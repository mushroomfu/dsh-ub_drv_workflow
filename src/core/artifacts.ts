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

/** True when a relative directory path contains at least one file (depth-insensitive). */
function hasFileUnder(files: readonly string[], relDir: string): boolean {
  const prefix = relDir.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return files.some(file => file.replace(/\\/g, '/').startsWith(prefix))
}

/**
 * Apply filesystem evidence to all steps. A step with artifact hints is marked
 * done when every hint matches at least one file. Parent steps with substeps
 * also close when all substeps are done. Never downgrades a step.
 *
 * @returns true when any step changed.
 */
export function applyArtifactEvidence(steps: WorkflowStep[], files: readonly string[], now?: string): boolean {
  const at = now ?? new Date().toISOString()
  let changed = false

  const visit = (step: WorkflowStep): void => {
    if (step.substeps !== undefined) {
      for (const sub of step.substeps) visit(sub)
    }

    if (step.status === 'done' || step.status === 'skipped' || step.status === 'failed') return

    const directories = step.artifactHints.filter(hint => hint.includes('/') && !hint.includes('*'))
    const patterns = step.artifactHints.filter(hint => hint.includes('*'))

    const dirsOk = directories.every(hint => {
      return hasFileUnder(files, hint.split('/')[0] === '.' ? hint.split('/')[1] : hint.split('/')[0])
    })
    // More precise single-file hints:
    const fileHints = step.artifactHints.filter(hint => !hint.includes('/'))
    const filesOk = fileHints.every(hint => files.some(file => file === hint))
    const patternsOk = patterns.every(hint => files.some(file => matchesArtifact(hint, file)))

    const hintsSatisfied = step.artifactHints.length > 0 && dirsOk && filesOk && patternsOk

    if (hintsSatisfied) {
      step.status = 'done'
      if (step.finishedAt === undefined) step.finishedAt = at
      changed = true
      return
    }

    // A parent step whose substeps all completed is itself complete.
    if (step.substeps !== undefined && step.substeps.length > 0) {
      const aggregate = aggregateSubsteps(step)
      if (aggregate === 'done') {
        step.status = 'done'
        if (step.finishedAt === undefined) step.finishedAt = at
        changed = true
      }
    }
  }

  for (const step of steps) visit(step)
  return changed
}

/** Collect every step referenced by a hint path (for diagnostics / UI). */
export function stepArtifactLabels(steps: WorkflowStep[]): Array<{ stepId: string; title: string; hints: string[] }> {
  return allSteps(steps).map(step => ({ stepId: step.id, title: step.title, hints: step.artifactHints }))
}