/**
 * Pure state-machine helpers for the workflow step chain. All functions are
 * immutable-plain-data friendly (they mutate the passed steps and return the
 * changed flag), framework-free, and unit-testable without Node or React.
 */

import { firstUnfinished, previousStep } from './stages.ts'
import type { StepId, StepStatus, WorkflowStep } from './types.ts'

export function markStepStatus(steps: WorkflowStep[], stepId: StepId, status: StepStatus, at?: string, note?: string): boolean {
  const step = steps.find(s => s.id === stepId)
  if (step === undefined) return false
  if (step.status === status) return false
  step.status = status
  if (status === 'running' && step.startedAt === undefined) step.startedAt = at ?? new Date().toISOString()
  if (status === 'done') step.finishedAt = at ?? step.finishedAt ?? new Date().toISOString()
  if (status === 'failed' && step.error === undefined) step.error = note
  if (status === 'waiting_user') step.note = note ?? step.note
  return true
}

/** Reset everything after `stepId` (used for rollback / restart from a gate). */
export function resetAfter(steps: WorkflowStep[], stepId: StepId): void {
  let seen = false
  for (const step of steps) {
    if (seen) {
      step.status = 'pending'
      step.startedAt = undefined
      step.finishedAt = undefined
      step.note = undefined
      step.error = undefined
      if (step.substeps !== undefined) {
        for (const sub of step.substeps) {
          sub.status = 'pending'
          sub.startedAt = undefined
          sub.finishedAt = undefined
          sub.note = undefined
          sub.error = undefined
        }
      }
    }
    if (step.id === stepId) seen = true
  }
}

/**
 * Whether the step chain has reached a terminal state (all main steps done)
 * or terminal gate confirmed in design-only mode.
 */
export function isChainFinished(steps: WorkflowStep[], designOnly: boolean): boolean {
  const unfinished = firstUnfinished(steps)
  if (unfinished === undefined) return true
  if (designOnly && unfinished.id === 'design-gate') return unfinished.status === 'done'
  return false
}

/**
 * Bump an ordered chain forward: ensures exactly one non-terminal step is
 * `running`. Hard gates that are not done stop the walk and are marked
 * `waiting_user`. The caller provides the step status lookups and decides
 * which gates are already confirmed (so a re-run can skip them).
 */
export function walkChain(runSteps: WorkflowStep[], options: {
  designOnly: boolean
  confirmedGates: ReadonlySet<StepId>
  now?: string
}): { steps: WorkflowStep[]; stoppedOnGate?: StepId; stoppedOnDone?: boolean } {
  const { designOnly, confirmedGates, now = new Date().toISOString() } = options
  const changed: WorkflowStep[] = []

  // Close lingering wrong states first: after a restart, removed gates are reset.
  for (const step of runSteps) {
    const shouldWait = step.needsUser && step.gate !== undefined
      && step.status !== 'done'
      && confirmedGates.has(step.id)
    const shouldBeDone = step.needsUser && step.gate !== undefined && confirmedGates.has(step.id)
    if (step.status === 'waiting_user' && shouldBeDone) markStepStatus(runSteps, step.id, 'done', now, '用户已确认')
    if (step.status === 'done' && shouldWait && !shouldBeDone) {
      // stale done for an unconfirmed gate should not happen; reset it
    }
    changed.push(step)
  }

  // Developer-friendly compaction: step chain order already carries the flow.
  for (let i = 0; i < runSteps.length; i += 1) {
    const step = runSteps[i]
    if (step.status === 'done' || step.status === 'skipped' || step.status === 'failed') continue

    const prev = previousStep(runSteps, step.id)
    const prevDone = prev === undefined
      || prev.status === 'done'
      || prev.status === 'skipped'

    if (!prevDone) break // previous is not ready; nothing to do

    if (step.needsUser && step.gate !== undefined) {
      if (confirmedGates.has(step.id)) continue // already handled above; let next loop pick it up
      if (step.status !== 'waiting_user') markStepStatus(runSteps, step.id, 'waiting_user', now, '等待用户确认')
      return { steps: runSteps, stoppedOnGate: step.id }
    }

    if (step.status !== 'running') markStepStatus(runSteps, step.id, 'running', now)
    // One running non-gate step is enough; leave the rest pending. Stop and
    // re-run this function on the next artifact/gate event so order holds.
    break
  }

  const tail = firstUnfinished(runSteps)
  if (tail === undefined) return { steps: runSteps, stoppedOnDone: true }
  if (designOnly && tail.id === 'design-gate' && tail.status === 'done') {
    return { steps: runSteps, stoppedOnDone: true }
  }
  if (designOnly && tail.id === 'design-gate') {
    // In design-only mode the chain ends AT the gate; the gate itself is still
    // a user wait, which the loop above handles. Should not reach here unless
    // it is already done.
  }
  return { steps: runSteps }
}

/** Best-effort error attribution: first running/pending non-gate step gets the failure. */
export function attachFailure(steps: WorkflowStep[], error: string, now?: string): StepId | undefined {
  const candidate = steps.find(s => s.status === 'running')
    ?? steps.find(s => s.status === 'pending' && !(s.needsUser && s.gate !== undefined))
  if (candidate === undefined) return undefined
  markStepStatus(steps, candidate.id, 'failed', now ?? new Date().toISOString(), error)
  return candidate.id
}