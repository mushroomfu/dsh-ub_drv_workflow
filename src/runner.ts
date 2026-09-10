/**
 * Execution backend abstraction for dsh-ub-workflow.
 *
 * The plugin can run the UB workflow on two engines:
 *   - `OpenCodeRunner`: legacy backend that spawns `opencode run --format json`
 *     as a child process and parses its JSON stdout.
 *   - `HarnessRunner` (see harness-runner.ts): in-process DeepSeek Harness
 *     Agent backend that drives a Harness Session through `ctx.agents`.
 *
 * Both implement `WorkflowRunner` so the engine stays backend-agnostic.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'

export interface WorkflowRunnerStart {
  repoPath: string
  /** Engine-controlled id; the backend derives its own process/session id from it. */
  sessionId: string
  title: string
  prompt: string
  opencodeBin?: string
  /** Optional original-conversation Harness Agent that should own the turn. */
  hostAgent?: unknown
  onEvent?: (event: ParsedOpencodeEvent) => void
  onExit?: (code: number | null, signal: string | null) => void
  onLogLine?: (line: string) => void
}

export interface WorkflowRunner {
  readonly kind: 'opencode' | 'harness'
  /** True while the backend is actively executing a segment. */
  readonly running: boolean
  /**
   * Start (or, for backends that own one session/process per run, resume) a
   * workflow segment. Resolves to false when the backend cannot start.
   */
  start(options: WorkflowRunnerStart): Promise<boolean>
  /** Resolve once the currently active execution has settled (if any). */
  whenIdle(): Promise<void>
  /** Stop the active execution without following up. */
  stop(): Promise<void>
  /** Release the backend and any owned session/process. */
  dispose(): Promise<void>
}

export interface OpencodeSpawn {
  cmd: string
  argsPrefix: string[]
}

const DEFAULT_JS_BIN = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode')

/**
 * Pick a real Node.js executable for running the opencode npm shim.
 *
 * In the DSH Desktop host the plugin runs inside an Electron process, where
 * `process.execPath` points to `DSH Desktop.exe`. Spawning that exe to run a
 * JS file would launch a second Desktop instance (the single-instance handoff
 * exits immediately with code 0 and no output) instead of running opencode.
 * Prefer an actual `node.exe` when Electron is detected.
 */
function resolveNodeExecPath(): string {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  if (versions.electron === undefined) return process.execPath

  const candidates: string[] = []
  const configured = process.env.DSH_UB_WORKFLOW_NODE
  if (configured !== undefined && configured !== '') candidates.push(configured)
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(join(programFiles, 'nodejs', 'node.exe'))
    candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe'))
    const programFilesX86 = process.env['ProgramFiles(x86)']
    if (programFilesX86 !== undefined) candidates.push(join(programFilesX86, 'nodejs', 'node.exe'))
  } else {
    candidates.push('/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node')
  }

  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }

  // Last resort: still use process.execPath and let the caller observe the
  // failure through the usual spawn error/exit path instead of throwing here.
  return process.execPath
}

/** Resolve how to launch opencode on this host. Never throws: falls back to PATH. */
export function describeOpencodeSpawn(requestedBin?: string): OpencodeSpawn {
  const bin = (requestedBin ?? '').trim()
  if (bin !== '') {
    if (/\.exe$/i.test(bin) || existsSync(bin)) return { cmd: bin, argsPrefix: [] }
    return { cmd: resolveNodeExecPath(), argsPrefix: [bin] }
  }
  if (process.env.OPENCODE_BIN_PATH !== undefined && process.env.OPENCODE_BIN_PATH !== '') {
    return { cmd: resolveNodeExecPath(), argsPrefix: [process.env.OPENCODE_BIN_PATH] }
  }
  if (existsSync(DEFAULT_JS_BIN)) {
    return { cmd: resolveNodeExecPath(), argsPrefix: [DEFAULT_JS_BIN] }
  }
  // PATH fallback (may not work with .ps1 shims on Windows without shell; the
  // npm shim case above should cover the normal dsh desktop host).
  return { cmd: 'opencode', argsPrefix: [] }
}

/** Legacy opencode child-process backend. */
export class OpenCodeRunner implements WorkflowRunner {
  readonly kind = 'opencode' as const

  private child: ChildProcess | null = null
  private exited = false

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  async start(options: WorkflowRunnerStart): Promise<boolean> {
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

    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: options.repoPath,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      options.onLogLine?.(`[spawn error] ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
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

  async whenIdle(): Promise<void> {
    // Process backends report idle asynchronously through onExit; there is no
    // direct idle promise to await.
  }

  /** Stop the current run (used before continuing the same opencode session). */
  async stop(): Promise<void> {
    if (this.child === null) return
    const child = this.child
    this.child = null
    if (!this.exited) child.kill()
    this.exited = true
  }

  async dispose(): Promise<void> {
    await this.stop()
  }
}