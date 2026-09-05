/**
 * Artifact-based step completion. The change workspace is polled by the host;
 * this module converts a flat list of relative file paths into done/unchanged
 * step decisions.
 */

import { allSteps, aggregateSubsteps } from './stages.ts'
import type { StepId, WorkflowStep } from './types.ts'

/**
 * These stages produce a report on both success and failure. Their report's
 * mere presence is useful for the UI but cannot be treated as a passing gate;
 * the hash-verified terminal event is the authoritative result.
 */
export const EVENT_VERIFIED_STEPS = new Set<StepId>([
  'requirement',
  'design',
  'develop',
  'develop.patch',
  'develop.pre-review',
  'develop.compile',
  'test.pre-dev',
  'test.post-dev',
  'test.regression',
  'review',
  'verify-deploy',
  'verify',
  'verify-stc',
  'closeout',
])

/** Routing closes only by a user gate; Explore closes only after host exit/source/workspace checks. */
export const HOST_VERIFIED_STEPS = new Set<StepId>(['routing-plan', 'explore'])

const REVERSIBLE_ARTIFACT_STEPS = new Set<StepId>(['design-summary', 'develop.implement'])

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

/**
 * Apply filesystem evidence to all steps. A step with artifact hints is marked
 * done when every hint matches at least one file and that step's artifact is
 * success-only. Validation/report steps are closed by workflow terminal events
 * instead, because those files are also written on failure. Parent steps with
 * substeps close when all substeps are done. Never downgrades a step.
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

    const hintsSatisfied = step.artifactHints.length > 0
      && step.artifactHints.every(hint => files.some(file => matchesArtifact(hint, file)))

    if (step.status === 'done' && REVERSIBLE_ARTIFACT_STEPS.has(step.id) && !hintsSatisfied) {
      step.status = 'pending'
      step.startedAt = undefined
      step.finishedAt = undefined
      step.note = undefined
      step.error = undefined
      changed = true
    }

    if (step.status === 'done' || step.status === 'skipped' || step.status === 'failed') return

    if (hintsSatisfied && !EVENT_VERIFIED_STEPS.has(step.id) && !HOST_VERIFIED_STEPS.has(step.id)) {
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
