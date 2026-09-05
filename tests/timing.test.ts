import { describe, expect, it } from 'vitest'
import { normalizePollMs } from '../src/core/timing.ts'

describe('normalizePollMs', () => {
  it('uses a safe fallback for non-finite values', () => {
    expect(normalizePollMs(Number.NaN)).toBe(1500)
    expect(normalizePollMs(Number.POSITIVE_INFINITY)).toBe(1500)
  })

  it('clamps finite values to the supported range', () => {
    expect(normalizePollMs(10)).toBe(250)
    expect(normalizePollMs(2100)).toBe(2100)
    expect(normalizePollMs(120_000)).toBe(60_000)
  })
})
