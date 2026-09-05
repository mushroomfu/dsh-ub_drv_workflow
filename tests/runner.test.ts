import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}

const spawned: FakeChild[] = []
const spawnCalls: Array<{ cmd: string; args: string[]; options?: { detached?: boolean } }> = []

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
  spawn: vi.fn((cmd: string, args: string[], options?: { detached?: boolean }) => {
    spawnCalls.push({ cmd, args, options })
    const child = new FakeChild()
    spawned.push(child)
    return child
  }),
}))

import { describeOpencodeSpawn, OpenCodeRunner } from '../src/runner.ts'

function options(onExit: (code: number | null, signal: string | null) => void) {
  return {
    repoPath: process.cwd(),
    sessionId: 'run-1',
    title: 'test',
    prompt: 'test',
    onExit,
  }
}

describe('OpenCodeRunner lifecycle', () => {
  beforeEach(() => {
    spawned.length = 0
    spawnCalls.length = 0
  })

  it('creates a fresh session first and names an exact session only for continuation', () => {
    const runner = new OpenCodeRunner()
    expect(runner.start({ ...options(vi.fn()), sessionId: undefined, agent: 'ub-leader' })).toBe(true)
    expect(spawnCalls[0].args).not.toContain('--session')
    expect(spawnCalls[0].args).toContain('--agent')
    expect(spawnCalls[0].args[spawnCalls[0].args.indexOf('--agent') + 1]).toBe('ub-leader')
    expect(spawnCalls[0].options?.detached).toBe(process.platform !== 'win32')
    spawned[0].emit('close', 0, null)

    expect(runner.start({ ...options(vi.fn()), sessionId: 'ses_exact123' })).toBe(true)
    const sessionIndex = spawnCalls[1].args.indexOf('--session')
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(spawnCalls[1].args[sessionIndex + 1]).toBe('ses_exact123')
  })

  it('keeps ownership while a stopped child is closing before allowing a continuation', () => {
    const runner = new OpenCodeRunner()
    const firstExit = vi.fn()
    const nextExit = vi.fn()

    expect(runner.start(options(firstExit))).toBe(true)
    const first = spawned[0]
    runner.stop()
    expect(runner.running).toBe(true)
    expect(runner.start(options(nextExit))).toBe(false)

    first.emit('close', 0, null)
    expect(firstExit).not.toHaveBeenCalled()
    expect(runner.running).toBe(false)

    expect(runner.start(options(nextExit))).toBe(true)
    const next = spawned[1]

    next.emit('close', 0, null)
    expect(nextExit).toHaveBeenCalledWith(0, null)
    expect(runner.running).toBe(false)
  })

  it('ignores stdout and stderr drained from a stopped child after a new child starts', () => {
    const runner = new OpenCodeRunner()
    const staleEvent = vi.fn()
    const staleLog = vi.fn()

    expect(runner.start({ ...options(vi.fn()), onEvent: staleEvent, onLogLine: staleLog })).toBe(true)
    const first = spawned[0]
    runner.stop()

    first.stdout.write(`${JSON.stringify({ type: 'message', message: { text: 'late output' } })}\n`)
    first.stderr.write('late stderr')

    expect(staleEvent).not.toHaveBeenCalled()
    expect(staleLog).not.toHaveBeenCalled()

    first.emit('close', 0, null)
    expect(runner.start(options(vi.fn()))).toBe(true)
  })

  it('bounds an unterminated stdout line and resumes parsing after its newline', () => {
    const runner = new OpenCodeRunner()
    const onEvent = vi.fn()
    const onLogLine = vi.fn()
    expect(runner.start({ ...options(vi.fn()), onEvent, onLogLine })).toBe(true)
    const child = spawned[0]

    child.stdout.write('x'.repeat(200_000))
    child.stdout.write('x'.repeat(200_000))
    expect(onLogLine).toHaveBeenCalledTimes(1)
    expect(onLogLine.mock.calls[0]?.[0]).toContain('line dropped')

    child.stdout.write(`\n${JSON.stringify({ type: 'session', id: 'ses_after_limit' })}\n`)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0]?.[0]?.sessionId).toBe('ses_after_limit')
  })

  it('parses a final JSON event that is not terminated by a newline', () => {
    const runner = new OpenCodeRunner()
    const onEvent = vi.fn()
    expect(runner.start({ ...options(vi.fn()), onEvent })).toBe(true)
    const child = spawned[0]

    child.stdout.write(JSON.stringify({ type: 'session', id: 'ses_final_line' }))
    child.emit('close', 0, null)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0]?.[0]?.sessionId).toBe('ses_final_line')
  })

  it('preserves UTF-8 characters split across stdout chunks', () => {
    const runner = new OpenCodeRunner()
    const onEvent = vi.fn()
    const onLogLine = vi.fn()
    expect(runner.start({ ...options(vi.fn()), onEvent, onLogLine })).toBe(true)
    const child = spawned[0]
    const payload = Buffer.from(`${JSON.stringify({
      type: 'message',
      message: { text: '正在验证编译阶段' },
    })}\n`)
    const split = payload.indexOf(Buffer.from('验')) + 1

    child.stdout.write(payload.subarray(0, split))
    child.stdout.write(payload.subarray(split))

    expect(onLogLine).toHaveBeenCalledWith(expect.stringContaining('正在验证编译阶段'))
    expect(onEvent.mock.calls[0]?.[0]?.text).toBe('正在验证编译阶段')
  })

  it('escalates a stopped child from SIGTERM to SIGKILL after the grace period', () => {
    vi.useFakeTimers()
    try {
      const runner = new OpenCodeRunner()
      expect(runner.start(options(vi.fn()))).toBe(true)
      const child = spawned[0]
      runner.stop()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      vi.advanceTimersByTime(5_000)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it.runIf(process.platform !== 'win32')('signals the POSIX process group and retains ownership while descendants remain', () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const runner = new OpenCodeRunner()
      expect(runner.start(options(vi.fn()))).toBe(true)
      const child = spawned[0] as FakeChild & { pid?: number }
      child.pid = 43_210

      runner.stop()
      expect(kill).toHaveBeenCalledWith(-43_210, 'SIGTERM')
      child.emit('close', 0, null)
      expect(kill).toHaveBeenCalledWith(-43_210, 0)
      expect(runner.running).toBe(true)

      vi.advanceTimersByTime(5_000)
      expect(kill).toHaveBeenCalledWith(-43_210, 'SIGKILL')
      expect(runner.running).toBe(false)
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('describeOpencodeSpawn', () => {
  it('runs a configured command name directly instead of passing it to node', () => {
    expect(describeOpencodeSpawn('opencode')).toEqual({ cmd: 'opencode', argsPrefix: [] })
  })

  it('runs an explicit JavaScript entry through the current node executable', () => {
    expect(describeOpencodeSpawn('/tools/opencode.mjs')).toEqual({
      cmd: process.execPath,
      argsPrefix: ['/tools/opencode.mjs'],
    })
  })
})
