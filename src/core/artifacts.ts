/**
 * Artifact-based step completion. The change workspace is polled by the host;
 * this module converts a flat list of relative file paths into done/unchanged
 * step decisions.
 */

import { allSteps, aggregateSubsteps } from './stages.ts'
import type { WorkflowStep } from './types.ts'

/** Minimal glob: `*` within a path segment, `**` across segments. */
export function artifactPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` = zero or more path segments; trailing `**` = anything.
        if (normalized[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2 // skip both stars and the slash; loop increments to the char after
        } else {
          re += '.*'
          i += 1 // skip the second star
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** Whether a relative path matches an artifact hint pattern. */
export function matchesArtifact(pattern: string, file: string): boolean {
  return artifactPatternToRegExp(pattern).test(file.replace(/\\/g, '/'))
}

/** One file evidence entry with mtime for write-back detection. */
export interface ArtifactEvidenceFile {
  file: string
  mtimeMs: number
}

function fileNamesOf(files: readonly ArtifactEvidenceFile[]): string[] {
  return files.map(entry => entry.file)
}

/** Files matching a single hint. */
export function matchingFiles(hint: string, files: readonly ArtifactEvidenceFile[]): ArtifactEvidenceFile[] {
  if (hint.includes('/') && !hint.includes('*')) {
    // Directory hint: any non-empty file beneath `dir/`.
    const dir = hint.split('/')[0] === '.' ? hint.split('/')[1] : hint.split('/')[0]
    const prefix = dir.replace(/\/$/, '') + '/'
    return files.filter(entry => entry.file.replace(/\\/g, '/').startsWith(prefix))
  }
  if (hint.includes('*')) {
    return files.filter(entry => matchesArtifact(hint, entry.file))
  }
  return files.filter(entry => entry.file === hint)
}

/** True when every hint matches at least one file. */
export function hintsSatisfiedBy(hints: string[], files: readonly ArtifactEvidenceFile[]): boolean {
  return hints.length > 0 && hints.every(hint => matchingFiles(hint, files).length > 0)
}

/**
 * mtime-aware evidence application. Normal completion only needs existence;
 * a re-running step (status `running` but previously finished) needs at least
 * ONE freshly-rewritten matched file before it is marked done again — old
 * artifacts alone must not close a write-back before the workflow rewrote
 * them.
 *
 * @returns true when any step changed.
 */
export function applyArtifactEvidenceWithMtime(steps: WorkflowStep[], files: readonly ArtifactEvidenceFile[], now?: string): boolean {
  const at = now ?? new Date().toISOString()
  let changed = false

  const visit = (step: WorkflowStep): void => {
    if (step.substeps !== undefined) {
      for (const sub of step.substeps) visit(sub)
    }

    if (step.status === 'done' || step.status === 'skipped' || step.status === 'failed') return

    const matched = step.artifactHints.flatMap(hint => matchingFiles(hint, files))
    let satisfied = hintSatisfiedForStep(step, files)

    // Re-run guard: after a write-back, `startedAt` is reset to the re-run
    // time. Old artifact files predate it; they must not close the step.
    if (satisfied && step.status === 'running' && step.startedAt !== undefined && step.finishedAt !== undefined) {
      const started = Date.parse(step.startedAt)
      const hasFresh = matched.some(entry => entry.mtimeMs >= started - 1500)
      if (!hasFresh) satisfied = false
    }

    if (satisfied) {
      step.status = 'done'
      step.finishedAt = at
      changed = true
      return
    }

    // A parent step whose substeps all completed is itself complete.
    if (step.substeps !== undefined && step.substeps.length > 0 && aggregateSubsteps(step) === 'done') {
      step.status = 'done'
      step.finishedAt = at
      changed = true
    }
  }

  for (const step of steps) visit(step)
  return changed
}

function hintSatisfiedForStep(step: WorkflowStep, files: readonly ArtifactEvidenceFile[]): boolean {
  if (step.artifactHints.length === 0) return false
  return step.artifactHints.every(hint => matchingFiles(hint, files).length > 0)
}

/**
 * Existence-only evidence application, kept for tests and simple callers.
 * @returns true when any step changed.
 */
export function applyArtifactEvidence(steps: WorkflowStep[], files: readonly string[], now?: string): boolean {
  const entries = files.map(file => ({ file, mtimeMs: Number.POSITIVE_INFINITY }))
  return applyArtifactEvidenceWithMtime(steps, entries, now)
}

/** Collect every step referenced by a hint path (for diagnostics / UI). */
export function stepArtifactLabels(steps: WorkflowStep[]): Array<{ stepId: string; title: string; hints: string[] }> {
  return allSteps(steps).map(step => ({ stepId: step.id, title: step.title, hints: step.artifactHints }))
}