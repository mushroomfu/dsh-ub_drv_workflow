import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import {
  applyWorkflowEventEvidence,
  parseWorkflowEventLine,
  type WorkflowEvidenceEvent,
} from '../src/core/workflowEvents.ts'
import type { WorkflowStep } from '../src/core/types.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function signedEvent(overrides: Partial<WorkflowEvidenceEvent> = {}): WorkflowEvidenceEvent {
  const base: Omit<WorkflowEvidenceEvent, 'event_id' | 'content_sha256'> = {
    schema_version: 1,
    module: 'udma',
    change_id: 'udma-reclaim',
    session_id: 'udma-reclaim',
    phase: 'compile',
    skill: 'ub-compile',
    event_type: 'compile.completed',
    outcome: 'completed',
    summary: 'remote compile passed',
    artifacts: [{ path: 'compile_report.md', sha256: 'a'.repeat(64), size: 42 }],
    files: [],
    symbols: [],
    occurred_at: '2026-09-04T12:00:00+00:00',
    ...overrides,
  }
  const identity = Object.fromEntries(Object.entries(base).filter(([key]) => !['occurred_at'].includes(key)))
  const eventId = `ke-${createHash('sha256').update(canonical(identity)).digest('hex').slice(0, 24)}`
  const withId = { ...base, event_id: eventId }
  return {
    ...withId,
    content_sha256: createHash('sha256').update(canonical(withId)).digest('hex'),
  } as WorkflowEvidenceEvent
}

function find(steps: WorkflowStep[], id: string): WorkflowStep {
  for (const step of steps) {
    if (step.id === id) return step
    const nested = step.substeps?.find(candidate => candidate.id === id)
    if (nested !== undefined) return nested
  }
  throw new Error(`missing step ${id}`)
}

function declaredArtifacts(events: readonly WorkflowEvidenceEvent[]): WorkflowEvidenceEvent['artifacts'] {
  return events.flatMap(event => event.artifacts)
}

describe('workflow event evidence', () => {
  it('does not let an Explore event bypass the host exit and filesystem audit', () => {
    const steps = buildStageChain({ mode: 'explore' })
    const event = signedEvent({
      phase: 'explore',
      skill: 'ub-leader',
      event_type: 'explore.completed',
      outcome: 'completed',
      artifacts: [{ path: 'exploration_notes.md', sha256: 'a'.repeat(64), size: 42 }],
    })
    applyWorkflowEventEvidence(steps, [event], event.artifacts, ['exploration_notes.md'])
    expect(find(steps, 'explore').status).toBe('pending')
  })

  it('accepts a real event emitted by the upstream knowledge_capture.py', () => {
    const line = '{"artifacts":[{"path":"compile_report.md","sha256":"e17585a0c21d23e410e4114e590ebf47eff42f7372dd22b0f93b464ada356b19","size":13}],"change_id":"udma-reclaim","content_sha256":"50b01c6f9b9f1b03f8a47cec5dad15702d87d153a99de40a2b9c9da9eb290f72","event_id":"ke-8b32e8797d54d9d82f455dd4","event_type":"compile.completed","files":[],"module":"udma","occurred_at":"2026-09-04T15:29:24.336492+00:00","outcome":"completed","phase":"compile","schema_version":1,"session_id":"udma-reclaim","skill":"ub-compile","summary":"remote compile passed","symbols":[]}'
    expect(parseWorkflowEventLine(line, 'udma-reclaim')).toMatchObject({
      event_type: 'compile.completed',
      outcome: 'completed',
    })
  })

  it('accepts a schema-v1 event only when its canonical hashes match', () => {
    const event = signedEvent()
    expect(parseWorkflowEventLine(JSON.stringify(event), event.change_id)).toEqual(event)

    const tampered = { ...event, outcome: 'failed' }
    expect(parseWorkflowEventLine(JSON.stringify(tampered), event.change_id)).toBeUndefined()
    expect(parseWorkflowEventLine(JSON.stringify(event), 'another-change')).toBeUndefined()
  })

  it('rejects re-signed events whose phase, skill, event type, or outcome contradict each other', () => {
    const wrongPhase = signedEvent({ phase: 'compile', event_type: 'review.completed' })
    const wrongOutcome = signedEvent({ event_type: 'compile.failed', outcome: 'completed' })
    const wrongSkill = signedEvent({ skill: 'ub-review' })

    expect(parseWorkflowEventLine(JSON.stringify(wrongPhase), wrongPhase.change_id)).toBeUndefined()
    expect(parseWorkflowEventLine(JSON.stringify(wrongOutcome), wrongOutcome.change_id)).toBeUndefined()
    expect(parseWorkflowEventLine(JSON.stringify(wrongSkill), wrongSkill.change_id)).toBeUndefined()
  })

  it('rejects noncanonical timestamps, duplicate lists, and text that was not privacy-filtered', () => {
    const timestamp = signedEvent({ occurred_at: '2026-09-04T14:00:00+02:00' })
    const duplicates = signedEvent({ files: ['driver.c', 'driver.c'] })
    const secret = signedEvent({ summary: 'password=hunter2' })

    expect(parseWorkflowEventLine(JSON.stringify(timestamp), timestamp.change_id)).toBeUndefined()
    expect(parseWorkflowEventLine(JSON.stringify(duplicates), duplicates.change_id)).toBeUndefined()
    expect(parseWorkflowEventLine(JSON.stringify(secret), secret.change_id)).toBeUndefined()
  })

  it('rejects deeply nested or unknown event data without throwing', () => {
    const event = signedEvent() as WorkflowEvidenceEvent & { extra?: unknown }
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 5_000; depth += 1) nested = { nested }
    event.extra = nested
    const line = JSON.stringify(event)

    expect(() => parseWorkflowEventLine(line, event.change_id)).not.toThrow()
    expect(parseWorkflowEventLine(line, event.change_id)).toBeUndefined()
  })

  it('uses terminal events, rather than report presence, to close validated stages', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const events = [
      signedEvent({
        phase: 'patch',
        skill: 'ub-patch',
        event_type: 'patch.completed',
        summary: 'patch validation passed',
        artifacts: [
          { path: 'patch/change.patch', sha256: 'a'.repeat(64), size: 23 },
          { path: 'patch_report.md', sha256: 'b'.repeat(64), size: 24 },
        ],
      }),
      signedEvent(),
      signedEvent({
        phase: 'develop',
        skill: 'ub-develop',
        event_type: 'develop.completed',
        summary: 'implementation, patch, pre-review and compile passed',
        artifacts: [
          { path: 'implementation_notes.md', sha256: 'c'.repeat(64), size: 30 },
          { path: 'pre_review_report.md', sha256: 'd'.repeat(64), size: 31 },
        ],
      }),
    ]
    const workspaceFiles = [
      'implementation_notes.md',
      'patch/change.patch',
      'patch_report.md',
      'pre_review_report.md',
      'compile_report.md',
    ]

    expect(applyWorkflowEventEvidence(steps, events, declaredArtifacts(events), workspaceFiles)).toBe(true)
    expect(find(steps, 'develop.implement').status).toBe('done')
    expect(find(steps, 'develop.patch').status).toBe('done')
    expect(find(steps, 'develop.pre-review').status).toBe('done')
    expect(find(steps, 'develop.compile').status).toBe('done')
    expect(find(steps, 'develop').status).toBe('done')
  })

  it('accepts artifact-free workflow.completed only after every closeout artifact exists', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const completed = signedEvent({
      phase: 'workflow',
      skill: 'ub-leader',
      event_type: 'workflow.completed',
      outcome: 'completed',
      summary: 'workflow finalized with status completed',
      artifacts: [],
    })

    expect(applyWorkflowEventEvidence(
      steps,
      [completed],
      [],
      ['workflow_report.md', 'archive_report.md'],
    )).toBe(false)
    expect(find(steps, 'closeout').status).toBe('pending')

    expect(applyWorkflowEventEvidence(
      steps,
      [completed],
      [],
      [
        'workflow_report.md',
        'archive_report.md',
        '.knowledge/events.ndjson',
        '.knowledge/retrieved.json',
        '.knowledge/episode.json',
        '.knowledge/candidates.json',
        '.knowledge/registry-receipt.json',
      ],
    )).toBe(true)
    expect(find(steps, 'closeout').status).toBe('done')
  })

  it('rejects artifact-free or unrelated success events outside workflow.completed', () => {
    const artifactFreeSteps = buildStageChain({ mode: 'dev' })
    const artifactFree = signedEvent({ artifacts: [] })

    expect(applyWorkflowEventEvidence(
      artifactFreeSteps,
      [artifactFree],
      [],
      ['compile_report.md'],
    )).toBe(false)
    expect(find(artifactFreeSteps, 'develop.compile').status).toBe('pending')

    const unrelatedSteps = buildStageChain({ mode: 'dev' })
    const unrelated = signedEvent({
      artifacts: [{ path: 'implementation_notes.md', sha256: 'f'.repeat(64), size: 23 }],
    })
    expect(applyWorkflowEventEvidence(
      unrelatedSteps,
      [unrelated],
      unrelated.artifacts,
      ['implementation_notes.md', 'compile_report.md'],
    )).toBe(false)
    expect(find(unrelatedSteps, 'develop.compile').status).toBe('pending')
  })

  it('closes a dev chain with the terminal event shapes emitted by upstream skills', () => {
    const steps = buildStageChain({ mode: 'dev', testTimings: ['post-dev'] })
    const events = [
      signedEvent({
        phase: 'requirement',
        skill: 'ub-requirement',
        event_type: 'requirement.completed',
        artifacts: [{ path: 'requirement_analysis.md', sha256: '1'.repeat(64), size: 11 }],
      }),
      signedEvent({
        phase: 'design',
        skill: 'ub-design',
        event_type: 'design.completed',
        artifacts: [
          { path: 'detailed_design.md', sha256: '2'.repeat(64), size: 12 },
          { path: 'delta/udma/spec.md', sha256: '3'.repeat(64), size: 13 },
        ],
      }),
      signedEvent({
        phase: 'stc',
        skill: 'ub-design',
        event_type: 'stc.completed',
        artifacts: [
          { path: 'udma-stc-output/udma_STC_Testcases.json', sha256: 'a'.repeat(64), size: 20 },
          { path: 'udma-stc-output/udma_STC_Testcases.xlsx', sha256: 'b'.repeat(64), size: 21 },
          { path: 'udma-stc-output/scripts/run_stc.sh', sha256: 'c'.repeat(64), size: 22 },
          { path: 'udma-stc-output/scripts/verify_case.sh', sha256: 'd'.repeat(64), size: 23 },
          { path: 'udma-stc-output/review_report.md', sha256: 'e'.repeat(64), size: 24 },
        ],
      }),
      signedEvent({
        phase: 'patch',
        skill: 'ub-patch',
        event_type: 'patch.completed',
        artifacts: [
          { path: 'patch/change.patch', sha256: '4'.repeat(64), size: 14 },
          { path: 'patch_report.md', sha256: '5'.repeat(64), size: 15 },
        ],
      }),
      signedEvent({
        phase: 'compile',
        skill: 'ub-compile',
        event_type: 'compile.completed',
        artifacts: [{ path: 'compile_report.md', sha256: '6'.repeat(64), size: 16 }],
      }),
      signedEvent({
        phase: 'develop',
        skill: 'ub-develop',
        event_type: 'develop.completed',
        artifacts: [
          { path: 'implementation_notes.md', sha256: '7'.repeat(64), size: 17 },
          { path: 'pre_review_report.md', sha256: '0'.repeat(64), size: 18 },
        ],
      }),
      signedEvent({
        phase: 'test',
        skill: 'ub-UT',
        event_type: 'verification.passed',
        outcome: 'passed',
        artifacts: [{ path: 'test_report.md', sha256: '8'.repeat(64), size: 18 }],
      }),
      signedEvent({
        phase: 'review',
        skill: 'ub-review',
        event_type: 'review.completed',
        artifacts: [{ path: 'module_review_report.md', sha256: '9'.repeat(64), size: 19 }],
      }),
      signedEvent({
        phase: 'workflow',
        skill: 'ub-leader',
        event_type: 'workflow.completed',
        artifacts: [],
      }),
    ]
    const workspaceFiles = [
      'requirement_analysis.md',
      'detailed_design.md',
      'delta/udma/spec.md',
      'udma-stc-output/udma_STC_Testcases.json',
      'udma-stc-output/udma_STC_Testcases.xlsx',
      'udma-stc-output/scripts/run_stc.sh',
      'udma-stc-output/scripts/verify_case.sh',
      'udma-stc-output/review_report.md',
      'implementation_notes.md',
      'patch/change.patch',
      'patch_report.md',
      'pre_review_report.md',
      'compile_report.md',
      'test_report.md',
      'module_review_report.md',
      'workflow_report.md',
      'archive_report.md',
      '.knowledge/events.ndjson',
      '.knowledge/retrieved.json',
      '.knowledge/episode.json',
      '.knowledge/candidates.json',
      '.knowledge/registry-receipt.json',
    ]

    expect(applyWorkflowEventEvidence(steps, events, declaredArtifacts(events), workspaceFiles)).toBe(true)
    for (const id of [
      'requirement',
      'design',
      'develop.implement',
      'develop.patch',
      'develop.pre-review',
      'develop.compile',
      'develop',
      'test.post-dev',
      'review',
      'closeout',
    ]) {
      expect(find(steps, id).status, id).toBe('done')
    }
  })

  it('preserves an explicitly skipped develop stage when no develop evidence exists', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const develop = find(steps, 'develop')
    develop.status = 'skipped'
    for (const substep of develop.substeps ?? []) substep.status = 'skipped'

    expect(applyWorkflowEventEvidence(steps, [], [], [])).toBe(false)
    expect(develop.status).toBe('skipped')
  })

  it('clears an earlier develop failure after a later successful retry closes every substep', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const events = [
      signedEvent({
        phase: 'develop',
        skill: 'ub-develop',
        event_type: 'develop.failed',
        outcome: 'failed',
        summary: 'initial implementation failed',
        correlation_id: 'develop-retry',
        attempt: 0,
        artifacts: [],
      }),
      signedEvent({
        phase: 'patch',
        skill: 'ub-patch',
        event_type: 'patch.completed',
        artifacts: [
          { path: 'patch/change.patch', sha256: 'a'.repeat(64), size: 20 },
          { path: 'patch_report.md', sha256: 'b'.repeat(64), size: 21 },
        ],
      }),
      signedEvent({
        phase: 'compile',
        skill: 'ub-compile',
        event_type: 'compile.completed',
        artifacts: [{ path: 'compile_report.md', sha256: 'c'.repeat(64), size: 22 }],
      }),
      signedEvent({
        phase: 'develop',
        skill: 'ub-develop',
        event_type: 'develop.completed',
        outcome: 'completed',
        summary: 'retry passed',
        correlation_id: 'develop-retry',
        attempt: 1,
        artifacts: [
          { path: 'implementation_notes.md', sha256: 'd'.repeat(64), size: 23 },
          { path: 'pre_review_report.md', sha256: 'e'.repeat(64), size: 24 },
        ],
        occurred_at: '2026-09-04T12:05:00+00:00',
      }),
    ]
    const files = [
      'implementation_notes.md',
      'patch/change.patch',
      'patch_report.md',
      'pre_review_report.md',
      'compile_report.md',
    ]

    void applyWorkflowEventEvidence(steps, events, declaredArtifacts(events), files)
    expect(find(steps, 'develop').status).toBe('done')
    expect(find(steps, 'develop').error).toBeUndefined()
  })

  it('does not accept a passing terminal event until its declared UI artifacts exist', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const passed = signedEvent()

    expect(applyWorkflowEventEvidence(steps, [passed], [], [])).toBe(false)
    expect(find(steps, 'develop.compile').status).toBe('pending')
    expect(applyWorkflowEventEvidence(steps, [passed], passed.artifacts, ['compile_report.md'])).toBe(true)
    expect(find(steps, 'develop.compile').status).toBe('done')
  })

  it('does not accept a passing event when the current artifact size or sha256 differs', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const passed = signedEvent()
    const declared = passed.artifacts[0]
    expect(declared).toBeDefined()
    if (declared === undefined) return

    expect(applyWorkflowEventEvidence(steps, [passed], [{
      ...declared,
      sha256: 'b'.repeat(64),
    }], ['compile_report.md'])).toBe(false)
    expect(find(steps, 'develop.compile').status).toBe('pending')

    expect(applyWorkflowEventEvidence(steps, [passed], [declared], ['compile_report.md'])).toBe(true)
    expect(find(steps, 'develop.compile').status).toBe('done')
  })

  it('requires every concrete artifact behind a stage hint to be hash-bound by its terminal event', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const design = signedEvent({
      phase: 'design',
      skill: 'ub-design',
      event_type: 'design.completed',
      artifacts: [{ path: 'detailed_design.md', sha256: 'a'.repeat(64), size: 10 }],
    })
    const stc = signedEvent({
      phase: 'stc',
      skill: 'ub-design',
      event_type: 'stc.completed',
      artifacts: [
        { path: 'udma-stc-output/udma_STC_Testcases.json', sha256: 'b'.repeat(64), size: 11 },
        { path: 'udma-stc-output/udma_STC_Testcases.xlsx', sha256: 'c'.repeat(64), size: 12 },
        { path: 'udma-stc-output/scripts/run_stc.sh', sha256: 'd'.repeat(64), size: 13 },
        { path: 'udma-stc-output/scripts/verify_case.sh', sha256: 'e'.repeat(64), size: 14 },
        { path: 'udma-stc-output/review_report.md', sha256: 'f'.repeat(64), size: 15 },
      ],
    })
    const current = declaredArtifacts([design, stc])
    current.push({ path: 'delta/udma/spec.md', sha256: '1'.repeat(64), size: 16 })
    const files = current.map(item => item.path)

    void applyWorkflowEventEvidence(steps, [design, stc], current, files)
    expect(find(steps, 'design').status).toBe('pending')
  })

  it('revokes a completed stage when its bound artifact is later changed or removed', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const passed = signedEvent()

    expect(applyWorkflowEventEvidence(steps, [passed], passed.artifacts, ['compile_report.md'])).toBe(true)
    expect(find(steps, 'develop.compile').status).toBe('done')

    expect(applyWorkflowEventEvidence(steps, [passed], [], ['compile_report.md'])).toBe(true)
    expect(find(steps, 'develop.compile').status).toBe('pending')
    expect(find(steps, 'develop.compile').finishedAt).toBeUndefined()
  })

  it('surfaces a failed compile even when compile_report.md exists', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const failed = signedEvent({
      event_type: 'compile.failed',
      outcome: 'failed',
      summary: 'kernel build failed with -Werror',
    })

    void applyWorkflowEventEvidence(steps, [failed], failed.artifacts, ['compile_report.md'])
    expect(find(steps, 'develop.compile').status).toBe('failed')
    expect(find(steps, 'develop.compile').error).toBe('kernel build failed with -Werror')
    expect(find(steps, 'develop').status).toBe('failed')
  })

  it('treats requirement.blocked as the clarification handoff, not a failed requirement', () => {
    const steps = buildStageChain({ mode: 'dev' })
    find(steps, 'requirement').status = 'done'
    const event = signedEvent({
      phase: 'requirement',
      skill: 'ub-design',
      event_type: 'requirement.blocked',
      outcome: 'blocked',
      summary: 'need idempotent-release confirmation',
      artifacts: [{ path: 'requirement_analysis.md', sha256: 'd'.repeat(64), size: 50 }],
    })

    void applyWorkflowEventEvidence(steps, [event], event.artifacts, ['requirement_analysis.md'])
    expect(find(steps, 'requirement').status).toBe('done')
    expect(find(steps, 'requirement').note).toBe('need idempotent-release confirmation')
  })

  it('maps UT, deployment, and STC evidence to their distinct visible stages', () => {
    const steps = buildStageChain({ mode: 'full', deploy: true, testTimings: ['post-dev'] })
    const testPassed = signedEvent({
      phase: 'verify',
      skill: 'ub-UT',
      event_type: 'verification.passed',
      outcome: 'passed',
      summary: 'all unit tests passed',
      artifacts: [{ path: 'test_report.md', sha256: 'e'.repeat(64), size: 80 }],
    })
    const deployPassed = signedEvent({
      phase: 'deploy',
      skill: 'ub-deploy',
      event_type: 'deploy.completed',
      outcome: 'completed',
      summary: 'deployment verification passed',
      artifacts: [{ path: 'deploy_report.md', sha256: 'f'.repeat(64), size: 80 }],
    })
    const stcPassed = signedEvent({
      phase: 'stc-exec',
      skill: 'ub-stc-exec',
      event_type: 'stc-exec.completed',
      outcome: 'completed',
      summary: 'all required STC cases passed',
      artifacts: [{ path: 'stc_exec_report.md', sha256: '1'.repeat(64), size: 80 }],
    })

    const events = [testPassed, deployPassed, stcPassed]
    void applyWorkflowEventEvidence(steps, events, declaredArtifacts(events), [
      'test_report.md',
      'deploy_report.md',
      'stc_exec_report.md',
    ])
    expect(find(steps, 'test.post-dev').status).toBe('done')
    expect(find(steps, 'verify-deploy').status).toBe('done')
    expect(find(steps, 'verify-stc').status).toBe('done')
  })

  it('uses the latest retry outcome for a stage', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const failed = signedEvent({
      event_type: 'compile.failed',
      outcome: 'failed',
      summary: 'attempt 0 failed',
      correlation_id: 'compile-retry',
      attempt: 0,
    })
    const passed = signedEvent({
      event_type: 'compile.completed',
      outcome: 'completed',
      summary: 'attempt 1 passed',
      correlation_id: 'compile-retry',
      attempt: 1,
      occurred_at: '2026-09-04T12:01:00+00:00',
    })

    void applyWorkflowEventEvidence(steps, [failed, passed], passed.artifacts, ['compile_report.md'])
    expect(find(steps, 'develop.compile').status).toBe('done')
    expect(find(steps, 'develop.compile').error).toBeUndefined()
    expect(find(steps, 'develop.compile').note).toBe('attempt 1 passed')
  })

  it('attributes a failed workflow terminal event to closeout', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const failed = signedEvent({
      phase: 'workflow',
      skill: 'ub-leader',
      event_type: 'workflow.failed',
      outcome: 'failed',
      summary: 'knowledge finalization failed',
      artifacts: [],
    })

    void applyWorkflowEventEvidence(steps, [failed], [], [])
    expect(find(steps, 'closeout').status).toBe('failed')
    expect(find(steps, 'closeout').error).toBe('knowledge finalization failed')
  })

  it('treats skipped evidence for a mandatory visible stage as a failure', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const skipped = signedEvent({
      phase: 'review',
      skill: 'ub-review',
      event_type: 'review.skipped',
      outcome: 'skipped',
      summary: 'review was skipped',
      artifacts: [],
    })

    expect(applyWorkflowEventEvidence(steps, [skipped], [], [])).toBe(true)
    expect(find(steps, 'review').status).toBe('failed')
    expect(find(steps, 'review').error).toBe('review was skipped')
  })
})
