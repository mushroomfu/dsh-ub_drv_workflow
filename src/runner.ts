/**
 * OpenCodeRunner: spawns `opencode run --format json` as a child process and
 * streams its JSON events. The runner does not interpret workflow state — the
 * engine does — it only reports parsed lines and process exit.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'

export interface RunnerOptions {
  repoPath: string
  /** Omit for a fresh run; set an exact OpenCode `ses_…` id to resume. */
  sessionId?: string
  agent?: string
  title: string
  prompt: string
  opencodeBin?: string
  onEvent?: (event: ParsedOpencodeEvent) => void
  onExit?: (code: number | null, signal: string | null) => void
  onLogLine?: (line: string) => void
}

export interface OpencodeSpawn {
  cmd: string
  argsPrefix: string[]
}

const DEFAULT_JS_BIN = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode')
const MAX_STREAM_LINE_CHARS = 256 * 1024

function describeConfiguredBin(bin: string): OpencodeSpawn {
  if (/\.(?:cjs|mjs|js)$/i.test(bin)) return { cmd: process.execPath, argsPrefix: [bin] }
  return { cmd: bin, argsPrefix: [] }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      const args = ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]
      const result = spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' })
      if (result.status === 0) return
    } catch {
      // Fall through to direct child signaling when taskkill is unavailable.
    }
  } else if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The process may have exited before signaling; direct kill is a safe fallback.
    }
  }
  try { child.kill(signal) } catch {}
}

function processTreeAlive(child: ChildProcess): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Resolve how to launch opencode on this host. Never throws: falls back to PATH. */
export function describeOpencodeSpawn(requestedBin?: string): OpencodeSpawn {
  const bin = (requestedBin ?? '').trim()
  if (bin !== '') {
    return describeConfiguredBin(bin)
  }
  if (process.env.OPENCODE_BIN_PATH !== undefined && process.env.OPENCODE_BIN_PATH !== '') {
    return describeConfiguredBin(process.env.OPENCODE_BIN_PATH)
  }
  if (existsSync(DEFAULT_JS_BIN)) {
    return { cmd: process.execPath, argsPrefix: [DEFAULT_JS_BIN] }
  }
  // PATH fallback (may not work with .ps1 shims on Windows without shell; the
  // npm shim case above should cover the normal dsh desktop host).
  return { cmd: 'opencode', argsPrefix: [] }
}

export class OpenCodeRunner {
  private child: ChildProcess | null = null
  private generation = 0
  private stopping = false
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null

  get running(): boolean {
    return this.child !== null
  }

  /** Spawn one opencode run segment. Returns false when already running. */
  start(options: RunnerOptions): boolean {
    if (this.running) return false
    const { cmd, argsPrefix } = describeOpencodeSpawn(options.opencodeBin)
    const args = [
      ...argsPrefix,
      'run',
      '--dir', options.repoPath,
      '--format', 'json',
      ...(options.sessionId === undefined ? [] : ['--session', options.sessionId]),
      ...(options.agent === undefined ? [] : ['--agent', options.agent]),
      '--title', options.title,
      options.prompt,
    ]

    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: options.repoPath,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.onLogLine?.(`[spawn error] ${message}`)
      return false
    }
    const generation = ++this.generation
    this.child = child
    this.stopping = false

    const isCurrent = (): boolean => this.child === child && this.generation === generation
    const acceptsOutput = (): boolean => isCurrent() && !this.stopping
    const release = (): boolean => {
      if (!isCurrent()) return false
      this.child = null
      this.stopping = false
      if (this.forceKillTimer !== null) {
        clearTimeout(this.forceKillTimer)
        this.forceKillTimer = null
      }
      return true
    }

    let partial = ''
    let droppingOversizedLine = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (!acceptsOutput() || line.trim() === '') return
      options.onLogLine?.(line.trim())
      if (!acceptsOutput()) return
      const event = parseOpencodeLine(line)
      if (event !== null) options.onEvent?.(event)
    }
    const consumeText = (text: string): void => {
      if (!acceptsOutput()) return
      let offset = 0
      while (offset < text.length && acceptsOutput()) {
        if (droppingOversizedLine) {
          const newline = text.indexOf('\n', offset)
          if (newline < 0) return
          droppingOversizedLine = false
          offset = newline + 1
          continue
        }

        const newline = text.indexOf('\n', offset)
        const fragment = newline < 0 ? text.slice(offset) : text.slice(offset, newline)
        if (partial.length + fragment.length > MAX_STREAM_LINE_CHARS) {
          partial = ''
          droppingOversizedLine = true
          options.onLogLine?.(`[stdout line dropped] exceeded ${MAX_STREAM_LINE_CHARS} characters`)
          if (newline >= 0) {
            droppingOversizedLine = false
            offset = newline + 1
            continue
          }
          return
        }
        partial += fragment
        if (newline < 0) return
        processLine(partial)
        partial = ''
        offset = newline + 1
      }
    }

    const consume = (chunk: Buffer): void => { consumeText(stdoutDecoder.write(chunk)) }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!acceptsOutput()) return
      const value = stderrDecoder.write(chunk).trim()
      if (value !== '') options.onLogLine?.(`[stderr] ${value}`)
    })

    child.on('error', (error) => {
      if (!isCurrent()) return
      const wasStopping = this.stopping
      release()
      if (wasStopping) return
      options.onLogLine?.(`[spawn error] ${error.message}`)
      options.onExit?.(-1, null)
    })

    child.on('close', (code, signal) => {
      if (!isCurrent()) return
      const wasStopping = this.stopping
      if (!wasStopping) {
        const stdoutTail = stdoutDecoder.end()
        if (stdoutTail !== '') consumeText(stdoutTail)
        const stderrTail = stderrDecoder.end().trim()
        if (stderrTail !== '') options.onLogLine?.(`[stderr] ${stderrTail}`)
      }
      if (!wasStopping && !droppingOversizedLine && partial.trim() !== '') processLine(partial)
      if (wasStopping && processTreeAlive(child)) return
      release()
      if (wasStopping) return
      options.onExit?.(code, signal)
    })

    return true
  }

  /** Stop the current run (used before continuing the same opencode session). */
  stop(): void {
    if (this.child === null || this.stopping) return
    const child = this.child
    const generation = this.generation
    this.stopping = true
    signalProcessTree(child, 'SIGTERM')
    this.forceKillTimer = setTimeout(() => {
      if (this.child === child && this.generation === generation && this.stopping) {
        signalProcessTree(child, 'SIGKILL')
        this.child = null
        this.stopping = false
        this.forceKillTimer = null
      }
    }, 5_000)
    this.forceKillTimer.unref?.()
  }
}
