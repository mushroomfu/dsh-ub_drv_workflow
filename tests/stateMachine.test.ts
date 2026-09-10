import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import { attachFailure, markStepStatus, walkChain } from '../src/core/stateMachine.ts'
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
  it('starts with the routing step running first', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const outcome = walkChain(steps, { designOnly: false, confirmedGates: new Set() })
    expect(outcome.stoppedOnGate).toBeUndefined()
    expect(steps.find(s => s.id === 'routing')?.status).toBe('running')
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
    ;['routing', 'routing-plan', 'requirement', 'design', 'design-gate'].forEach(id => setDone(steps, id))
    const outcome = walkChain(steps, {
      designOnly: false,
      confirmedGates: new Set(['routing-plan', 'design-gate']),
    })
    expect(outcome.stoppedOnGate).toBeUndefined()
    expect(steps.find(s => s.id === 'develop')?.status).toBe('running')
  })

  it('keeps only one running step at a time', () => {
    const steps = buildStageChain({ mode: 'dev' })
    ;['routing', 'routing-plan', 'requirement'].forEach(id => setDone(steps, id))
    walkChain(steps, { designOnly: false, confirmedGates: new Set(['routing-plan']) })
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
  it('sets a running step failed with an error message', () => {
    const steps = buildStageChain({ mode: 'dev' })
    walkChain(steps, { designOnly: false, confirmedGates: new Set() })
    expect(steps.find(s => s.id === 'routing')?.status).toBe('running')
    const failed = attachFailure(steps, 'boom')
    expect(failed).toBe('routing')
    expect(steps.find(s => s.id === 'routing')?.status).toBe('failed')
    expect(steps.find(s => s.id === 'routing')?.error).toBe('boom')
  })
})