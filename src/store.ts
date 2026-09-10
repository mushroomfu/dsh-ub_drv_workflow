/**
 * WorkflowStore: authoritative in-memory run registry with JSON persistence
 * under `<repo>/.dsh-ub-workflow/runs.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkflowRun, WorkflowStateSnapshot, WorkflowStep } from './core/types.ts'
import { ARTIFACT_HINTS } from './core/stages.ts'

const RUNS_FILE = 'runs.json'
const DIR_NAME = '.dsh-ub-workflow'

function stateDirOf(repoPath: string): string {
  return join(repoPath, DIR_NAME)
}

function stateFileOf(repoPath: string): string {
  return join(stateDirOf(repoPath), RUNS_FILE)
}

/**
 * Re-stamp a step's artifact hints from the CURRENT plugin definition.
 * Steps are persisted with the hints of the plugin version that created the
 * run; when artifact naming evolves (e.g. alias alternatives are added), old
 * runs must adopt the new definitions or their completion checks silently
 * stop matching the files the workflow actually writes.
 */
function refreshHints(step: WorkflowStep): void {
  const hints = ARTIFACT_HINTS[step.id]
  if (hints !== undefined) step.artifactHints = [...hints]
  for (const sub of step.substeps ?? []) refreshHints(sub)
}

export class WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>()

  /** Load all persisted runs for a repo (idempotent; later repos add on demand). */
  loadRepo(repoPath: string): void {
    const file = stateFileOf(repoPath)
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: WorkflowRun[] }
      if (!Array.isArray(parsed.runs)) return
      for (const run of parsed.runs) {
        if (typeof run?.runId !== 'string') continue
        // A runs.json may carry records that migrated to another workspace (the
        // run's repoPath was corrected after creation). Only adopt runs that
        // still BELONG to this repo, or a stale duplicate in this file would
        // shadow the authoritative copy in the run's actual workspace. Path
        // separators are normalized because session cwds and corrected records
        // may use either slash style.
        if (run.repoPath !== undefined
          && run.repoPath.replaceAll('\\', '/') !== repoPath.replaceAll('\\', '/')) continue
        for (const step of run.steps ?? []) refreshHints(step)
        this.runs.set(run.runId, run)
      }
    } catch {
      // Corrupt state file is ignored; the store starts empty for that repo.
    }
  }

  persist(repoPath: string): void {
    const dir = stateDirOf(repoPath)
    mkdirSync(dir, { recursive: true })
    const repoRuns = this.listForRepo(repoPath)
    const payload = { version: 1, updatedAt: new Date().toISOString(), runs: repoRuns }
    writeFileSync(stateFileOf(repoPath), JSON.stringify(payload, null, 2), 'utf8')
  }

  listForRepo(repoPath: string): WorkflowRun[] {
    return [...this.runs.values()]
      .filter(run => run.repoPath === repoPath)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** All runs across every tracked workspace, newest first. */
  listAll(): WorkflowRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Active runs across every tracked workspace (executing or waiting for the user). */
  allActive(): WorkflowRun[] {
    return this.listAll().filter(run => run.status === 'running' || run.status === 'waiting_user')
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId)
  }

  put(run: WorkflowRun): void {
    run.updatedAt = new Date().toISOString()
    this.runs.set(run.runId, run)
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId)
  }

  findActive(repoPath: string): WorkflowRun | undefined {
    return this.listForRepo(repoPath).find(run => run.status === 'running' || run.status === 'waiting_user' || run.status === 'idle')
  }

  anyActive(repoPath: string, excludeRun?: string): boolean {
    return this.listForRepo(repoPath).some(run => run.runId !== excludeRun && (run.status === 'running' || run.status === 'waiting_user'))
  }

  /**
   * Session-scoped active check. Slash-command runs execute inside their
   * conversation, so a blocked run in one conversation must not prevent
   * another conversation (a different workspace) from starting its own
   * workflow. With a sessionId the check spans every tracked workspace (a
   * session has one cwd, so a session's runs share a repo in practice);
   * legacy runs without a sessionId still count globally per repo.
   */
  anyActiveForSession(repoPath: string, sessionId?: string, excludeRun?: string): boolean {
    if (sessionId === undefined) return this.anyActive(repoPath, excludeRun)
    return this.allActive().some(run =>
      run.runId !== excludeRun
      && (run.sessionId === undefined || run.sessionId === sessionId),
    )
  }

  /**
   * Cross-workspace snapshot for the browser half: the most recent active run
   * plus every run, newest first. Runs carry their own repoPath (a run follows
   * the conversation's workspace, not the plugin's configured default), and
   * the client filters by session, so one global view serves every drawer.
   */
  snapshot(repoPath: string): WorkflowStateSnapshot {
    return {
      repoPath,
      activeRun: this.allActive()[0] ?? null,
      runs: this.listAll().map(run => ({
        runId: run.runId,
        createdAt: run.createdAt,
        status: run.status,
        mode: run.mode,
        changeId: run.changeId,
        module: run.module,
        sessionId: run.sessionId,
      })),
    }
  }
}