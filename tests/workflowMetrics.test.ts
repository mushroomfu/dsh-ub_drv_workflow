import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import type { WorkflowRun } from '../src/core/types.ts'
import { workflowMetrics } from '../src/client/workflowMetrics.ts'

function run(): WorkflowRun {
  const steps = buildStageChain({ mode: 'dev' })
  steps[0].status = 'done'
  steps[1].status = 'done'
  steps[2].status = 'waiting_user'
  return {
    runId: 'run-1',
    repoPath: '/repo',
    mode: 'dev',
    designOnly: false,
    deploy: false,
    testTimings: ['post-dev', 'regression'],
    requirement: 'test',
    status: 'waiting_user',
    steps,
    segment: 0,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:05.000Z',
    startedAt: '2026-09-04T00:00:01.000Z',
    logTail: [],
  }
}

describe('workflowMetrics', () => {
  it('reports completed progress and the current stage position', () => {
    const metrics = workflowMetrics(run(), new Date('2026-09-04T00:01:01.000Z'))
    expect(metrics.completed).toBe(2)
    expect(metrics.total).toBeGreaterThan(2)
    expect(metrics.currentIndex).toBe(2)
    expect(metrics.progressPercent).toBe(Math.round((2 / metrics.total) * 100))
    expect(metrics.elapsedLabel).toBe('01:00')
    expect(metrics.needsResponse).toBe(true)
  })

  it('keeps the final stage current while a completed chain is still exiting', () => {
    const active = run()
    for (const step of active.steps) step.status = 'done'
    active.status = 'running'

    const metrics = workflowMetrics(active)
    expect(metrics.currentIndex).toBe(active.steps.length - 1)
    expect(metrics.activeStep).toBe(active.steps.at(-1))
    expect(metrics.progressPercent).toBe(100)
  })
})
