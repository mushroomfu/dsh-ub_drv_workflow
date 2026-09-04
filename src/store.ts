/**
 * WorkflowStore: authoritative in-memory run registry with JSON persistence
 * under `<repo>/.dsh-ub-workflow/runs.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WorkflowRun, WorkflowStateSnapshot } from './core/types.ts'

const RUNS_FILE = 'runs.json'
const DIR_NAME = '.dsh-ub-workflow'

function stateDirOf(repoPath: string): string {
  return join(repoPath, DIR_NAME)
}

function stateFileOf(repoPath: string): string {
  return join(stateDirOf(repoPath), RUNS_FILE)
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
        if (typeof run?.runId === 'string') this.runs.set(run.runId, run)
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

  snapshot(repoPath: string): WorkflowStateSnapshot {
    return {
      repoPath,
      activeRun: this.findActive(repoPath) ?? null,
      runs: this.listForRepo(repoPath).map(run => ({
        runId: run.runId,
        createdAt: run.createdAt,
        status: run.status,
        mode: run.mode,
        changeId: run.changeId,
        module: run.module,
      })),
    }
  }
}