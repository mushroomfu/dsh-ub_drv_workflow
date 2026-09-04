/**
 * Artifact watcher: scans `ub-workspace/changes/<change-id>` under the repo
 * and hands a flat list of workspace-relative file paths to the pure artifact
 * evaluator.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CHANGES_DIR = 'ub-workspace/changes'

export function changesRoot(repoPath: string): string {
  return join(repoPath, CHANGES_DIR)
}

/** Latest created/modified change directory, or undefined. */
export function findLatestChangeId(repoPath: string): string | undefined {
  const root = changesRoot(repoPath)
  if (!existsSync(root)) return undefined
  let latest: { id: string; mtime: number } | undefined
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (!statSync(full).isDirectory()) continue
    const mtime = statSync(full).mtimeMs
    if (latest === undefined || mtime > latest.mtime) latest = { id: entry, mtime }
  }
  return latest?.id
}

/**
 * Recursively list files under `ub-workspace/changes/<changeId>/` relative to
 * that change workspace (e.g. `requirement_analysis.md`,
 * `delta/udma/spec.md`, `.knowledge/events.ndjson`).
 */
export function listChangeFiles(repoPath: string, changeId: string): string[] {
  const root = join(changesRoot(repoPath), changeId)
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (st.isFile() && st.size > 0) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return out
}

/** Resolve the effective change id: explicit > latest modified. */
export function resolveChangeId(repoPath: string, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit
  return findLatestChangeId(repoPath)
}