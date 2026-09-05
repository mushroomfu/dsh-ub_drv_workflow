import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'

describe('buildStageChain', () => {
  it('builds the dev chain with develop substeps', () => {
    const chain = buildStageChain({ mode: 'dev', testTimings: ['post-dev'] })
    expect(chain.map(s => s.id)).toEqual([
      'routing-plan',
      'requirement',
      'requirement-clarify',
      'design',
      'design-gate',
      'develop',
      'test.post-dev',
      'review',
      'closeout',
    ])
    const develop = chain.find(s => s.id === 'develop')
    expect(develop?.substeps?.map(s => s.id)).toEqual([
      'develop.implement',
      'develop.patch',
      'develop.pre-review',
      'develop.compile',
    ])
  })

  it('builds the design-only chain with its post-confirmation summary', () => {
    const chain = buildStageChain({ mode: 'dev', designOnly: true })
    expect(chain.map(s => s.id)).toEqual([
      'routing-plan',
      'requirement',
      'requirement-clarify',
      'design',
      'design-gate',
      'design-summary',
    ])
  })

  it('marks requirement clarification as a response-based hard gate', () => {
    const chain = buildStageChain({ mode: 'dev' })
    const clarify = chain.find(step => step.id === 'requirement-clarify')
    expect(clarify).toMatchObject({
      needsUser: true,
      gate: 'requirement-clarify',
      interaction: 'response',
    })
  })

  it('collects mandatory develop inputs at the non-design-only design gate', () => {
    const devGate = buildStageChain({ mode: 'dev' }).find(step => step.id === 'design-gate')
    const designOnlyGate = buildStageChain({ mode: 'dev', designOnly: true }).find(step => step.id === 'design-gate')
    expect(devGate?.interaction).toBe('response')
    expect(designOnlyGate?.interaction).toBe('confirm')
  })

  it('shows deployment, its hard gate, and STC as separate full-mode stages', () => {
    const chain = buildStageChain({ mode: 'full', deploy: true, testTimings: ['post-dev'] })
    expect(chain.map(s => s.id)).toEqual([
      'routing-plan',
      'requirement',
      'requirement-clarify',
      'design',
      'design-gate',
      'develop',
      'test.post-dev',
      'review',
      'deploy-authorize',
      'verify-deploy',
      'deploy-ok',
      'verify-stc',
      'closeout',
    ])
  })

  it('omits verify for full mode without deploy', () => {
    const chain = buildStageChain({ mode: 'full' })
    expect(chain.map(s => s.id)).not.toContain('verify-deploy')
    expect(chain.map(s => s.id)).not.toContain('verify-stc')
  })

  it('keeps routing confirmation visible before the single explore step', () => {
    const chain = buildStageChain({ mode: 'explore' })
    expect(chain.map(s => s.id)).toEqual(['routing-plan', 'explore'])
    expect(chain[0]?.artifactHints).toEqual([])
  })
})
