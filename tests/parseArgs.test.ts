import { describe, expect, it } from 'vitest'
import { parseWorkflowArgs } from '../src/core/parseArgs.ts'

describe('parseWorkflowArgs', () => {
  it('parses module, mode, change-id and keeps requirement', () => {
    const parsed = parseWorkflowArgs('--module udma --mode full --change-id udma-jetty-20260904 帮我新增 jetty 接口')
    expect(parsed.module).toBe('udma')
    expect(parsed.mode).toBe('full')
    expect(parsed.changeId).toBe('udma-jetty-20260904')
    expect(parsed.designOnly).toBe(false)
    expect(parsed.requirement).toBe('帮我新增 jetty 接口')
  })

  it('recognizes design-only', () => {
    const parsed = parseWorkflowArgs('--stage design 只做方案')
    expect(parsed.designOnly).toBe(true)
    expect(parsed.requirement).toBe('只做方案')
  })

  it('deploy implies full mode unless explicitly stated', () => {
    const parsed = parseWorkflowArgs('--deploy 升级网卡驱动')
    expect(parsed.deploy).toBe(true)
    expect(parsed.mode).toBe('full')
  })

  it('keeps unknown tokens in the requirement', () => {
    const parsed = parseWorkflowArgs('--experimental 试一下')
    expect(parsed.requirement).toBe('--experimental 试一下')
    expect(parsed.module).toBeUndefined()
  })

  it('empty input yields empty requirement', () => {
    expect(parseWorkflowArgs('   ').requirement).toBe('')
  })

  it('treats unknown parameter values as ordinary text', () => {
    const parsed = parseWorkflowArgs('--change-id --mode 看看 --module xyz 需求')
    expect(parsed.changeId).toBeUndefined()
    expect(parsed.requirement).toBe('--change-id --mode 看看 --module xyz 需求')
  })
})