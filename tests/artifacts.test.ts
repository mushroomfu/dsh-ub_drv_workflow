import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import { applyArtifactEvidence } from '../src/core/artifacts.ts'
import type { WorkflowStep } from '../src/core/types.ts'

function find(steps: WorkflowStep[], id: string): WorkflowStep {
  for (const step of steps) {
    if (step.id === id) return step
    if (step.substeps !== undefined) {
      const hit = step.substeps.find(sub => sub.id === id)
      if (hit !== undefined) return hit
    }
  }
  throw new Error(`missing step ${id}`)
}

describe('applyArtifactEvidence', () => {
  it('does not treat draft and design document presence as terminal success', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['requirement_analysis.md', 'detailed_design.md', 'delta/udma/spec.md']
    expect(applyArtifactEvidence(steps, files)).toBe(false)
    expect(find(steps, 'requirement').status).toBe('pending')
    expect(find(steps, 'design').status).toBe('pending')
    expect(find(steps, 'routing-plan').status).toBe('pending')
  })

  it('does not treat validation report presence as a passing result', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['implementation_notes.md', 'patch/0001-x.patch', 'patch_report.md', 'pre_review_report.md', 'compile_report.md']
    expect(applyArtifactEvidence(steps, files)).toBe(true)
    expect(find(steps, 'develop.implement').status).toBe('done')
    expect(find(steps, 'develop.patch').status).toBe('pending')
    expect(find(steps, 'develop.pre-review').status).toBe('pending')
    expect(find(steps, 'develop.compile').status).toBe('pending')
    expect(find(steps, 'develop').status).toBe('pending')
  })

  it('does not downgrade an already failed step', () => {
    const steps = buildStageChain({ mode: 'dev' })
    find(steps, 'requirement').status = 'failed'
    expect(applyArtifactEvidence(steps, ['requirement_analysis.md'], undefined)).toBe(false)
    expect(find(steps, 'requirement').status).toBe('failed')
  })

  it('ignores artifact hints that are only partially satisfied', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['requirement_analysis.md']
    const changed = applyArtifactEvidence(steps, files)
    expect(find(steps, 'requirement').status).toBe('pending')
    expect(find(steps, 'design').status).toBe('pending')
    expect(changed).toBe(false)
  })

  it('never treats a workspace artifact as user routing confirmation', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['.knowledge/events.ndjson']
    expect(applyArtifactEvidence(steps, files)).toBe(false)
    expect(find(steps, 'routing-plan').status).toBe('pending')
  })

  it('requires an exact nested file hint instead of any sibling file', () => {
    const steps = buildStageChain({ mode: 'dev' })
    void applyArtifactEvidence(steps, ['.knowledge/retrieved.json'])
    expect(find(steps, 'routing-plan').status).toBe('pending')
  })

  it('does not treat a partial Explore note as completion before process exit audit', () => {
    const steps = buildStageChain({ mode: 'explore' })
    expect(applyArtifactEvidence(steps, ['exploration_notes.md'])).toBe(false)
    expect(find(steps, 'explore').status).toBe('pending')
    expect(find(steps, 'explore').finishedAt).toBeUndefined()
  })
})
