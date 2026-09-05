import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import { attachFailure, markStepStatus, resetAfter, walkChain } from '../src/core/stateMachine.ts'
import type { WorkflowStep } from '../src/core/types.ts'

function buildDoneThrough(chain: WorkflowStep[], stopId: string): void {
  for (const step of chain) {
    if (step.id === stopId) break
    step.status = 'done'
  }
}

function setDone(steps: WorkflowStep[], id: string): void {
  const step = steps.find(s => s.id === id)
  if (step !== undefined) step.status = 'done'
}

describe('walkChain', () => {
  it('sets the first non-gate step running after plan is done', () => {
    const steps = buildStageChain({ mode: 'dev' })
    setDone(steps, 'routing-plan')
    const outcome = walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan']) })
    expect(outcome.stoppedOnGate).toBeUndefined()
    expect(steps.find(s => s.id === 'requirement')?.status).toBe('running')
  })

  it('stops at design-gate as a user wait', () => {
    const steps = buildStageChain({ mode: 'dev' })
    buildDoneThrough(steps, 'design-gate')
    ;['routing-plan', 'requirement', 'design'].forEach(id => setDone(steps, id))
    const outcome = walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan']) })
    expect(outcome.stoppedOnGate).toBe('design-gate')
    expect(steps.find(s => s.id === 'design-gate')?.status).toBe('waiting_user')
  })

  it('continues dispatch after gate confirmations', () => {
    const steps = buildStageChain({ mode: 'dev' })
    ;['routing-plan', 'requirement', 'requirement-clarify', 'design', 'design-gate'].forEach(id => setDone(steps, id))
    const outcome = walkChain(steps, {
      designOnly: false,
      confirmedGates: new Set(['routing-plan', 'requirement-clarify', 'design-gate']),
    })
    expect(outcome.stoppedOnGate).toBeUndefined()
    expect(steps.find(s => s.id === 'develop')?.status).toBe('running')
  })

  it('keeps only one running step at a time', () => {
    const steps = buildStageChain({ mode: 'dev' })
    ;['routing-plan', 'requirement', 'requirement-clarify'].forEach(id => setDone(steps, id))
    walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan', 'requirement-clarify']) })
    expect(steps.filter(s => s.status === 'running')).toHaveLength(1)
    expect(steps.find(s => s.id === 'design')?.status).toBe('running')
  })

  it('marks a chain with all steps done as stoppedOnDone', () => {
    const steps = buildStageChain({ mode: 'dev' })
    for (const step of steps) step.status = 'done'
    const outcome = walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan', 'design-gate']) })
    expect(outcome.stoppedOnDone).toBe(true)
  })
})

describe('markStepStatus / attachFailure', () => {
  it('clears primary and supporting evidence when rolling later stages back', () => {
    const steps = buildStageChain({ mode: 'dev', testTimings: ['post-dev'] })
    const develop = steps.find(step => step.id === 'develop')
    const test = steps.find(step => step.id === 'test.post-dev')
    if (develop?.substeps === undefined || test === undefined) throw new Error('missing stages')
    test.evidenceId = 'ke-111111111111111111111111'
    test.supportingEvidenceIds = ['ke-222222222222222222222222']
    develop.substeps[0]!.evidenceId = 'ke-333333333333333333333333'
    develop.substeps[0]!.supportingEvidenceIds = ['ke-444444444444444444444444']

    resetAfter(steps, 'design-gate')

    expect(test.evidenceId).toBeUndefined()
    expect(test.supportingEvidenceIds).toBeUndefined()
    expect(develop.substeps[0]!.evidenceId).toBeUndefined()
    expect(develop.substeps[0]!.supportingEvidenceIds).toBeUndefined()
  })

  it('sets a running step failed with an error message', () => {
    const steps = buildStageChain({ mode: 'dev' })
    markStepStatus(steps, 'routing-plan', 'done')
    walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan']) })
    expect(steps.find(s => s.id === 'requirement')?.status).toBe('running')
    const failed = attachFailure(steps, 'boom')
    expect(failed).toBe('requirement')
    expect(steps.find(s => s.id === 'requirement')?.status).toBe('failed')
    expect(steps.find(s => s.id === 'requirement')?.error).toBe('boom')
  })

  it('attributes a child exit to the active develop substep', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const develop = steps.find(step => step.id === 'develop')
    expect(develop?.substeps).toBeDefined()
    if (develop?.substeps === undefined) return
    develop.status = 'running'
    const compile = develop.substeps.find(step => step.id === 'develop.compile')
    expect(compile).toBeDefined()
    if (compile === undefined) return
    compile.status = 'running'

    expect(attachFailure(steps, 'remote build failed')).toBe('develop.compile')
    expect(compile.status).toBe('failed')
    expect(compile.error).toBe('remote build failed')
    expect(develop.status).toBe('running')
  })
})
