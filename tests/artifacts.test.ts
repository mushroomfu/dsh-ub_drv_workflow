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
  it('marks requirement and design complete from files', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['requirement_analysis.md', 'detailed_design.md', 'delta/udma/spec.md']
    expect(applyArtifactEvidence(steps, files)).toBe(true)
    expect(find(steps, 'requirement').status).toBe('done')
    expect(find(steps, 'design').status).toBe('done')
    expect(find(steps, 'routing-plan').status).toBe('pending')
  })

  it('marks patch prepare complete via globs', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['implementation_notes.md', 'patch/0001-x.patch', 'patch_report.md', 'pre_review_report.md', 'compile_report.md']
    expect(applyArtifactEvidence(steps, files)).toBe(true)
    expect(find(steps, 'develop.implement').status).toBe('done')
    expect(find(steps, 'develop.patch').status).toBe('done')
    expect(find(steps, 'develop.pre-review').status).toBe('done')
    expect(find(steps, 'develop.compile').status).toBe('done')
    expect(find(steps, 'develop').status).toBe('done')
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
    expect(find(steps, 'requirement').status).toBe('done')
    expect(find(steps, 'design').status).toBe('pending')
    expect(changed).toBe(true)
  })

  it('treats .knowledge/events.ndjson as routing evidence', () => {
    const steps = buildStageChain({ mode: 'dev' })
    const files = ['.knowledge/events.ndjson']
    void applyArtifactEvidence(steps, files)
    expect(find(steps, 'routing-plan').status).toBe('done')
  })
})