import { describe, expect, it } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'

describe('buildStageChain', () => {
  it('builds the dev chain with develop substeps', () => {
    const chain = buildStageChain({ mode: 'dev' })
    expect(chain.map(s => s.id)).toEqual([
      'routing-plan',
      'requirement',
      'design',
      'design-gate',
      'develop',
      'test',
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

  it('builds the design-only chain ending at design-gate', () => {
    const chain = buildStageChain({ mode: 'dev', designOnly: true })
    expect(chain.map(s => s.id)).toEqual(['routing-plan', 'requirement', 'design', 'design-gate'])
  })

  it('adds verify + deploy-ok for full mode with deploy', () => {
    const chain = buildStageChain({ mode: 'full', deploy: true })
    expect(chain.map(s => s.id)).toContain('verify')
    expect(chain.map(s => s.id)).toContain('deploy-ok')
    expect(chain.findIndex(s => s.id === 'deploy-ok')).toBeGreaterThan(chain.findIndex(s => s.id === 'verify'))
  })

  it('omits verify for full mode without deploy', () => {
    const chain = buildStageChain({ mode: 'full' })
    expect(chain.map(s => s.id)).not.toContain('verify')
  })

  it('explore mode is a single step', () => {
    const chain = buildStageChain({ mode: 'explore' })
    expect(chain.map(s => s.id)).toEqual(['explore'])
  })
})