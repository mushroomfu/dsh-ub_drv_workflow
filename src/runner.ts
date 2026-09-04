/**
 * OpenCodeRunner: spawns `opencode run --format json` as a child process and
 * streams its JSON events. The runner does not interpret workflow state — the
 * engine does — it only reports parsed lines and process exit.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'

export interface RunnerOptions {
  repoPath: string
  sessionId: string
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

/** Resolve how to launch opencode on this host. Never throws: falls back to PATH. */
export function describeOpencodeSpawn(requestedBin?: string): OpencodeSpawn {
  const bin = (requestedBin ?? '').trim()
  if (bin !== '') {
    if (/\.exe$/i.test(bin) || existsSync(bin)) return { cmd: bin, argsPrefix: [] }
    return { cmd: process.execPath, argsPrefix: [bin] }
  }
  if (process.env.OPENCODE_BIN_PATH !== undefined && process.env.OPENCODE_BIN_PATH !== '') {
    return { cmd: process.execPath, argsPrefix: [process.env.OPENCODE_BIN_PATH] }
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
  private exited = false

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  /** Spawn one opencode run segment. Returns false when already running. */
  start(options: RunnerOptions): boolean {
    if (this.running) return false
    this.exited = false

    const { cmd, argsPrefix } = describeOpencodeSpawn(options.opencodeBin)
    const args = [
      ...argsPrefix,
      'run',
      '--dir', options.repoPath,
      '--format', 'json',
      '--session', options.sessionId,
      '--title', options.title,
      options.prompt,
    ]

    const child = spawn(cmd, args, {
      cwd: options.repoPath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    let partial = ''
    const consume = (chunk: Buffer): void => {
      partial += chunk.toString('utf8')
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        options.onLogLine?.(line.trim())
        const event = parseOpencodeLine(line)
        if (event !== null) options.onEvent?.(event)
      }
    }

    child.stdout?.on('data', consume)
    child.stderr?.on('data', (chunk: Buffer) => {
      options.onLogLine?.(`[stderr] ${chunk.toString('utf8').trim()}`)
    })

    child.on('error', (error) => {
      if (!this.exited) {
        this.exited = true
        this.child = null
        options.onLogLine?.(`[spawn error] ${error.message}`)
        options.onExit?.(-1, null)
      }
    })

    child.on('close', (code, signal) => {
      if (this.exited) return
      this.exited = true
      this.child = null
      if (partial.trim() !== '') {
        options.onLogLine?.(partial.trim())
        const event = parseOpencodeLine(partial)
        if (event !== null) options.onEvent?.(event)
      }
      options.onExit?.(code, signal)
    })

    return true
  }

  /** Stop the current run (used before continuing the same opencode session). */
  stop(): void {
    if (this.child === null) return
    const child = this.child
    this.child = null
    if (!this.exited) {
      child.kill()
    }
  }
}