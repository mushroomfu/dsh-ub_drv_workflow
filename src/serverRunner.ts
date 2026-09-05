/** Authenticated loopback OpenCode REST/SSE runner. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { describeOpencodeSpawn } from './runner.ts'
import type { ParsedOpencodeEvent } from './core/opencodeEvents.ts'
import type { WorkflowSourceRoot } from './core/types.ts'
import { isSafeWorkflowId } from './core/ids.ts'
import {
  createRuntimeSnapshot,
  REQUIRED_RUNTIME_AGENTS,
  REQUIRED_RUNTIME_SKILLS,
  verifyRuntimeSnapshot,
  verifyRuntimeSources,
  type RuntimeSnapshot,
} from './runtimeSnapshot.ts'
import { isSupportedModule, loadModuleCodeRootIds, validateFrozenSourceRoots } from './moduleManifest.ts'

export interface ServerRunnerOptions {
  workflowId: string
  /** Exact change workspace that is the only writable path for this run. */
  changeId: string
  /** Selected module whose frozen manifest defines every readable source root. */
  module: string
  /** Frozen workflow bundle used to build the immutable runtime snapshot. */
  workflowPath: string
  /** Frozen physical roots resolved and reviewed before this segment starts. */
  sourceRoots: WorkflowSourceRoot[]
  /** Writable workspace root and OpenCode working directory. */
  repoPath: string
  sessionId?: string
  agent?: string
  title: string
  prompt: string
  opencodeBin?: string
  onEvent?: (event: ParsedOpencodeEvent) => void
  onExit?: (code: number | null, signal: string | null) => void
  onStopped?: () => void
  onLogLine?: (line: string) => void
}

export interface ServerRunnerDependencies {
  fetch?: typeof fetch
  spawn?: typeof spawn
  randomSecret?: () => string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  reconnectBaseMs?: number
  sseReadTimeoutMs?: number
}

interface ActiveSegment {
  generation: number
  options: ServerRunnerOptions
  rootSessionId?: string
  ownedSessions: Set<string>
  parents: Map<string, string | undefined>
  promptAccepted: boolean
  sawActivity: boolean
  sawIdle: boolean
  server?: ServerState
}

interface ServerState {
  child: ChildProcess
  workerPid?: number
  workerReady: Promise<void>
  resolveWorker: () => void
  origin?: string
  username: string
  password: string
  pluginUrl: string
  configDir: string
  repoPath: string
  sourceRoots: WorkflowSourceRoot[]
  ready: Promise<void>
  sseAbort?: AbortController
  reconnects: number
  closing: boolean
  shutdownTimer?: ReturnType<typeof setTimeout>
  plannedExit?: {
    active: ActiveSegment
    code: number | null
    signal: string | null
    notify: boolean
  }
}

const MAX_EVENT_CHARS = 256 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const PRIVATE_RUNTIME_ENV = [
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'OPENCODE_DB',
  'OPENCODE_PERMISSION',
  'OPENCODE_PLUGIN_META_FILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const
const REQUIRED_PATHS = [
  '/event', '/session', '/session/{sessionID}', '/session/{sessionID}/prompt_async',
  '/session/{sessionID}/abort', '/question',
  '/session/{sessionID}/children', '/session/{sessionID}/message', '/agent', '/skill',
  '/session/status',
  '/config',
] as const

// OpenCode is supervised by a process whose stdin is owned by DSH. If DSH is
// killed, EOF tears down the whole OpenCode process group instead of leaving a
// live deployment agent behind.
export const SUPERVISOR_SOURCE = String.raw`
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const cfg = JSON.parse(process.argv[1])
const child = spawn(cfg.cmd, cfg.args, { cwd: cfg.cwd, env: process.env,
  detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
let closing = false
let forceTimer
function signalTree(signal) {
  if (process.platform === 'win32') {
    if (child.pid) {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } catch { try { child.kill(signal) } catch {} }
    }
  }
  else if (child.pid) { try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }
}
function stop() {
  if (closing) return
  closing = true
  signalTree('SIGTERM')
  forceTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL')
  }, Number.isFinite(cfg.stopGraceMs) ? cfg.stopGraceMs : 5000)
  forceTimer.unref()
}
if (child.pid) { try { fs.writeSync(3, String(child.pid) + '\n') } finally { try { fs.closeSync(3) } catch {} } }
process.stdin.resume(); process.stdin.on('end', stop); process.stdin.on('close', stop)
process.on('SIGTERM', stop); process.on('SIGINT', stop)
child.on('error', e => { console.error('[opencode server error] ' + e.message); process.exitCode = 1 })
child.on('close', (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer)
  if (signal) console.error('[opencode server signal] ' + signal)
  process.exit(code ?? (closing ? 0 : 1))
})
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionId(value: unknown): value is string {
  return typeof value === 'string' && /^ses[A-Za-z0-9_-]{1,124}$/.test(value)
}

function safeText(value: unknown, max = 4_096): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

function supportsVersion(value: unknown): boolean { return value === '1.18.3' }

interface RuntimePermissionRule {
  permission: string
  pattern: string
  action: 'allow' | 'ask' | 'deny'
}

function permissionRule(value: unknown): value is RuntimePermissionRule {
  return isRecord(value)
    && typeof value.permission === 'string'
    && typeof value.pattern === 'string'
    && (value.action === 'allow' || value.action === 'ask' || value.action === 'deny')
}

function openCodePermissionPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * OpenCode 1.18.3 evaluates read/edit permission patterns as
 * `path.relative(instance.worktree, target)`: the worktree is the Git toplevel
 * of the working directory when that directory lives inside a repository (not
 * the working directory itself), and the filesystem root for directories
 * outside any repository. Emit each allow pattern relative to every candidate
 * base so the configured rule matches whichever base OpenCode resolves.
 */
export function opencodeWorktreeBases(cwd: string): string[] {
  const bases = [cwd]
  let gitRoot: string | undefined
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
    if (out !== '') gitRoot = realpathSync(out)
  } catch {
    gitRoot = undefined
  }
  if (gitRoot !== undefined) {
    if (gitRoot !== cwd) bases.push(gitRoot)
  } else {
    bases.push(sep)
  }
  return [...new Set(bases)]
}

/** Every worktree-relative spelling under which OpenCode may evaluate `target`. */
export function opencodeTargetPatterns(bases: readonly string[], target: string): string[] {
  return [...new Set(bases.map(base => openCodePermissionPath(relative(base, target))))]
}

export function permissionPatternMatches(
  rule: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  let normalizedRule = openCodePermissionPath(rule)
  let normalizedValue = openCodePermissionPath(value)
  if (platform === 'win32') {
    normalizedRule = normalizedRule.toLowerCase()
    normalizedValue = normalizedValue.toLowerCase()
  }
  if (normalizedRule === '*') return true
  if (normalizedRule.endsWith('/**')) {
    const prefix = normalizedRule.slice(0, -3)
    return normalizedValue === prefix || normalizedValue.startsWith(`${prefix}/`)
  }
  return normalizedRule === normalizedValue
}

function effectivePermission(
  rules: readonly RuntimePermissionRule[],
  permission: string,
  pattern: string,
): RuntimePermissionRule['action'] | undefined {
  return [...rules].reverse().find(rule => (
    (rule.permission === '*' || rule.permission === permission)
      && permissionPatternMatches(rule.pattern, pattern)
  ))?.action
}

function hasReadonlyExplorePermissions(
  value: Record<string, unknown>,
  changeId: string,
  repoPath: string,
  configDir: string,
  module: string,
  sourceRoots: readonly WorkflowSourceRoot[],
): boolean {
  if (!Array.isArray(value.permission) || value.permission.length > 512
    || !value.permission.every(permissionRule)) return false
  const rules = value.permission
  const bases = opencodeWorktreeBases(repoPath)
  const writable = `ub-workspace/changes/${changeId}/exploration_notes.md`
  const writablePatterns = opencodeTargetPatterns(bases, join(repoPath, writable))
  const selectedProbe = opencodeTargetPatterns(bases,
    join(sourceRoots[0]?.path ?? '__missing_source_root__', '__dsh_permission_probe__.c'))
  const selectedReference = opencodeTargetPatterns(bases,
    join(configDir, 'references', module, '_manifest.yaml'))
  const foreignReference = opencodeTargetPatterns(bases,
    join(configDir, 'references', '__foreign_module__', '_manifest.yaml'))
  const every = (patterns: readonly string[], permission: string, action: 'allow' | 'deny'): boolean =>
    patterns.every(pattern => effectivePermission(rules, permission, pattern) === action)
  return effectivePermission(rules, 'edit', 'src/__dsh_permission_probe__.c') === 'deny'
    && every(writablePatterns, 'edit', 'allow')
    && effectivePermission(rules, 'edit', 'ub-workspace/.dsh-ub-workflow/runs.json') === 'deny'
    && effectivePermission(rules, 'bash', 'printf unsafe') === 'deny'
    && effectivePermission(rules, 'question', '*') === 'deny'
    && effectivePermission(rules, 'task', 'ub-design') === 'deny'
    && every(selectedProbe, 'read', 'allow')
    && effectivePermission(rules, 'read', '__dsh_forbidden_module__/probe.c') === 'deny'
    && every(writablePatterns, 'read', 'allow')
    && every(selectedReference, 'read', 'allow')
    && every(foreignReference, 'read', 'deny')
    && effectivePermission(rules, 'read', '.git/config') === 'deny'
    && effectivePermission(rules, 'read', '.env') === 'deny'
    && effectivePermission(rules, 'skill', 'ub-workflow') === 'deny'
    && effectivePermission(rules, 'external_directory', openCodePermissionPath(join(configDir, 'references', '_shared', 'probe.md'))) === 'allow'
    && effectivePermission(rules, 'external_directory', '/tmp/untrusted/probe.md') === 'deny'
}

export function runtimeGuardPluginSource(
  repoPath: string,
  configDir: string,
  changeId: string,
  module: string,
  sourceRoots: readonly WorkflowSourceRoot[],
): string {
  const physicalSourceRoots = sourceRoots.map(root => root.path)
  const snapshotRoots = [
    join(configDir, 'references', '_shared'),
    join(configDir, 'references', module),
  ]
  return [
    'import { lstatSync, realpathSync } from "node:fs"',
    'import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"',
    `const BLOCKED = ${JSON.stringify(PRIVATE_RUNTIME_ENV)}`,
    `const REPO_INPUT = resolve(${JSON.stringify(repoPath)})`,
    `const SNAPSHOT_INPUT = resolve(${JSON.stringify(configDir)})`,
    `const SOURCE_INPUTS = ${JSON.stringify(physicalSourceRoots)}.map(value => resolve(value))`,
    `const SNAPSHOT_SCOPE_INPUTS = ${JSON.stringify(snapshotRoots)}.map(value => resolve(value))`,
    'const REPO = realpathSync(REPO_INPUT)',
    'const SNAPSHOT = realpathSync(SNAPSHOT_INPUT)',
    'const SOURCE_ROOTS = SOURCE_INPUTS.map(value => realpathSync(value))',
    'const SNAPSHOT_ROOTS = SNAPSHOT_SCOPE_INPUTS.map(value => realpathSync(value))',
    `const CHANGE = join(REPO, "ub-workspace", "changes", ${JSON.stringify(changeId)})`,
    'const NOTE = join(CHANGE, "exploration_notes.md")',
    'function inside(root, target) {',
    '  const rel = relative(root, target)',
    '  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))',
    '}',
    'function rootFor(target) {',
    '  if (inside(REPO, target)) return REPO',
    '  if (inside(SNAPSHOT, target)) return SNAPSHOT',
    '  const source = SOURCE_ROOTS.find(root => inside(root, target))',
    '  if (source !== undefined) return source',
    '  throw new Error("DSH Explore denied a path outside the workspace, selected source roots, and frozen workflow snapshot")',
    '}',
    'function normalizeTarget(raw) {',
    '  let target = resolve(REPO_INPUT, raw)',
    '  if (inside(REPO_INPUT, target)) target = resolve(REPO, relative(REPO_INPUT, target))',
    '  else if (inside(SNAPSHOT_INPUT, target)) target = resolve(SNAPSHOT, relative(SNAPSHOT_INPUT, target))',
    '  else {',
    '    const sourceIndex = SOURCE_INPUTS.findIndex(root => inside(root, target))',
    '    if (sourceIndex >= 0) target = resolve(SOURCE_ROOTS[sourceIndex], relative(SOURCE_INPUTS[sourceIndex], target))',
    '  }',
    '  return target',
    '}',
    'function checkPath(raw, allowMissingLeaf) {',
    '  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\\0")) throw new Error("DSH Explore received an invalid path")',
    '  const target = normalizeTarget(raw)',
    '  const root = rootFor(target)',
    '  const rel = relative(root, target)',
    '  let current = root',
    '  const parts = rel === "" ? [] : rel.split(sep)',
    '  for (let index = 0; index <= parts.length; index += 1) {',
    '    if (index > 0) current = join(current, parts[index - 1])',
    '    let stat',
    '    try { stat = lstatSync(current) } catch (error) {',
    '      if (allowMissingLeaf && index === parts.length && error && error.code === "ENOENT") return target',
    '      throw error',
    '    }',
    '    if (stat.isSymbolicLink()) throw new Error("DSH Explore denied a symbolic-link path")',
    '    if (index < parts.length && !stat.isDirectory()) throw new Error("DSH Explore path ancestor is not a directory")',
    '  }',
    '  if (!inside(root, realpathSync(target))) throw new Error("DSH Explore denied a resolved path outside its root")',
    '  {',
    '    const segments = relative(root, target).split(sep)',
    '    const foldedSegments = segments.map(segment => segment.toLowerCase())',
    '    const base = foldedSegments.at(-1) || ""',
    '    if (foldedSegments.includes(".git") || ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example")) {',
    '      throw new Error("DSH Explore denied sensitive repository metadata")',
    '    }',
    '    if (root === REPO && foldedSegments[0] === "ub-workspace" && !inside(CHANGE, target)) {',
    '      throw new Error("DSH Explore denied another workflow session or private plugin state")',
    '    }',
    '  }',
    '  return target',
    '}',
    'function checkSearchRoot(raw) {',
    '  const target = checkPath(raw === undefined ? REPO : raw, false)',
    '  if (!lstatSync(target).isDirectory()) throw new Error("DSH Explore search root must be a directory")',
    '  if (target === REPO) throw new Error("DSH Explore searches must select a source directory")',
    '  if (!SOURCE_ROOTS.some(root => inside(root, target)) && !SNAPSHOT_ROOTS.some(root => inside(root, target))) {',
    '    throw new Error("DSH Explore denied a path outside the selected module source roots")',
    '  }',
    '  return target',
    '}',
    'function checkReadable(raw) {',
    '  const target = checkPath(raw, false)',
    '  if (target === REPO) throw new Error("DSH Explore denied an unfiltered repository listing")',
    '  if (!lstatSync(target).isFile()) throw new Error("DSH Explore read target must be a regular file")',
    '  if (target !== NOTE && !SOURCE_ROOTS.some(root => inside(root, target))',
    '    && !SNAPSHOT_ROOTS.some(root => inside(root, target))) {',
    '    throw new Error("DSH Explore denied a path outside the selected module source roots")',
    '  }',
    '  return target',
    '}',
    'export const DshWorkflowRuntimeGuard = async () => ({',
    '  "shell.env": async (_input, output) => { for (const key of BLOCKED) delete output.env[key] },',
    '  "tool.execute.before": async (input, output) => {',
    '    const args = output.args || {}',
    '    if (input.tool === "read") {',
    '      checkReadable(args.filePath)',
    '      return',
    '    }',
    '    if (input.tool === "glob" || input.tool === "grep" || input.tool === "list") {',
    '      checkSearchRoot(args.path); return',
    '    }',
    '    if (input.tool === "apply_patch" || input.tool === "apply-patch" || input.tool === "patch") {',
    '      throw new Error("DSH Explore patch tools are disabled because move targets cannot be permission-scoped")',
    '    }',
    '    if (input.tool === "edit" || input.tool === "write") {',
      '      const target = normalizeTarget(typeof args.filePath === "string" ? args.filePath : "")',
      '      if (target !== NOTE) throw new Error("DSH Explore may edit only exploration_notes.md")',
      '      checkPath(dirname(target), false)',
      '      checkPath(target, true)',
      '      return',
      '    }',
    '  },',
    '})',
    '',
  ].join('\n')
}

async function boundedText(response: Response, limit = MAX_JSON_BYTES, signal?: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('OpenCode response exceeds size limit')
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  while (true) {
    if (signal?.aborted === true) {
      void reader.cancel().catch(() => {})
      throw new Error('OpenCode response timed out')
    }
    const chunk = signal === undefined
      ? await reader.read()
      : await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const aborted = (): void => {
            void reader.cancel().catch(() => {})
            reject(new Error('OpenCode response timed out'))
          }
          signal.addEventListener('abort', aborted, { once: true })
          void reader.read().then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', aborted)
          })
        })
    if (chunk.done) break
    bytes += chunk.value.byteLength
    if (bytes > limit) {
      await reader.cancel()
      throw new Error('OpenCode response exceeds size limit')
    }
    output += decoder.decode(chunk.value, { stream: true })
  }
  return output + decoder.decode()
}

async function boundedJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const text = await boundedText(response, MAX_JSON_BYTES, signal)
  return text === '' ? undefined : JSON.parse(text)
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      callback()
    }
    const aborted = (): void => {
      void reader.cancel().catch(() => {})
      finish(() => reject(new Error('OpenCode SSE stream aborted')))
    }
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
      finish(() => reject(new Error('OpenCode SSE heartbeat deadline exceeded')))
    }, timeoutMs)
    timer.unref?.()
    signal.addEventListener('abort', aborted, { once: true })
    void reader.read().then(
      value => { finish(() => resolve(value)) },
      error => { finish(() => reject(error)) },
    )
  })
}

export class OpenCodeServerRunner {
  private readonly fetchImpl: typeof fetch
  private readonly spawnImpl: typeof spawn
  private readonly secret: () => string
  private readonly startupTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly reconnectBaseMs: number
  private readonly sseReadTimeoutMs: number
  private server?: ServerState
  private active?: ActiveSegment
  private generation = 0
  private workflowRuntime?: {
    workflowId: string
    repoPath: string
    workflowPath: string
    module: string
    sourceRoots: WorkflowSourceRoot[]
    root: string
    snapshot: RuntimeSnapshot
    home: string
    xdgConfig: string
    xdgState: string
    xdgCache: string
    managedConfig: string
  }
  private disposeRequested = false

  constructor(deps: ServerRunnerDependencies = {}) {
    this.fetchImpl = deps.fetch ?? fetch
    this.spawnImpl = deps.spawn ?? spawn
    this.secret = deps.randomSecret ?? (() => randomBytes(32).toString('base64url'))
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 15_000
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 15_000
    this.reconnectBaseMs = deps.reconnectBaseMs ?? 200
    this.sseReadTimeoutMs = deps.sseReadTimeoutMs ?? 60_000
  }

  /** Busy includes the shutdown interval so a new segment cannot overlap it. */
  get running(): boolean { return this.active !== undefined || this.server !== undefined }

  start(options: ServerRunnerOptions): boolean {
    if (this.active !== undefined || this.server !== undefined) return false
    if (!isSafeWorkflowId(options.workflowId) || !isSafeWorkflowId(options.changeId)) return false
    if (!isSupportedModule(options.module)) return false
    if (typeof options.repoPath !== 'string' || options.repoPath === ''
      || typeof options.workflowPath !== 'string' || options.workflowPath === ''
      || !Array.isArray(options.sourceRoots) || options.sourceRoots.length === 0) return false
    if (options.agent !== undefined && options.agent !== 'ub-leader') return false
    this.disposeRequested = false
    const active: ActiveSegment = {
      generation: ++this.generation,
      options: {
        ...options,
        sourceRoots: options.sourceRoots.map(root => ({ ...root })),
      },
      ownedSessions: new Set(),
      parents: new Map(),
      promptAccepted: false,
      sawActivity: false,
      sawIdle: false,
    }
    this.active = active
    void this.startSegment(active).catch(error => {
      if (this.active !== active) return
      this.log(active, `[runner error] ${error instanceof Error ? error.message : String(error)}`)
      this.finish(active, -1, null)
    })
    return true
  }

  stop(): void {
    const active = this.active
    this.active = undefined
    this.generation += 1
    const server = active?.server ?? this.server
    if (active?.rootSessionId !== undefined && server !== undefined) {
      void this.request(server, `/session/${encodeURIComponent(active.rootSessionId)}/abort`, { method: 'POST' })
        .catch(() => {})
    }
    if (server !== undefined) {
      if (active !== undefined) {
        server.plannedExit = { active, code: null, signal: null, notify: false }
      }
      this.closeServer(server)
    }
  }

  dispose(): void {
    this.disposeRequested = true
    this.stop()
    if (this.server === undefined) this.clearWorkflowRuntime()
  }

  private async startSegment(active: ActiveSegment): Promise<void> {
    const server = await this.ensureServer(active)
    if (this.active !== active) return
    const value = active.options.sessionId === undefined
      ? await this.requestJson(server, '/session', { method: 'POST', body: JSON.stringify({
          title: active.options.title, agent: active.options.agent,
        }) })
      : await this.requestJson(server, `/session/${encodeURIComponent(active.options.sessionId)}`, {
          method: 'GET',
        })
    if (this.active !== active || active.server !== server) return
    if (!isRecord(value) || !sessionId(value.id)
      || (active.options.sessionId !== undefined && value.id !== active.options.sessionId)) {
      throw new Error('OpenCode returned an invalid or mismatched session id')
    }
    active.rootSessionId = value.id
    active.ownedSessions.add(value.id)
    active.parents.set(value.id, undefined)
    active.options.onEvent?.({ sessionId: value.id, raw: value })
    if (this.active !== active || active.server !== server) return
    const promptController = new AbortController()
    const promptTimer = setTimeout(() => promptController.abort(), this.requestTimeoutMs)
    promptTimer.unref?.()
    try {
      const response = await this.request(server, `/session/${encodeURIComponent(value.id)}/prompt_async`, {
        method: 'POST',
        signal: promptController.signal,
        body: JSON.stringify({ agent: active.options.agent, parts: [{ type: 'text', text: active.options.prompt }] }),
      }, false)
      if (this.active !== active || active.server !== server) return
      if (response.status !== 204) {
        const body = await boundedText(response, 16_384, promptController.signal).catch(() => '')
        throw new Error(`OpenCode prompt_async failed with HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 500)}`}`)
      }
    } finally {
      clearTimeout(promptTimer)
    }
    active.promptAccepted = true
    if (active.sawActivity && active.sawIdle) {
      queueMicrotask(() => {
        if (this.active === active) this.finish(active, 0, null)
      })
    }
  }

  private async ensureServer(active: ActiveSegment): Promise<ServerState> {
    if (this.server !== undefined) throw new Error('previous OpenCode server is still stopping')
    const options = active.options
    const workspacePath = realpathSync(options.repoPath)
    const launch = describeOpencodeSpawn(options.opencodeBin)
    const username = 'dsh-ub-workflow'
    const password = this.secret()
    if (password.length < 32) throw new Error('OpenCode server credential generator returned a weak secret')
    const runtime = this.ensureWorkflowRuntime(options)
    if (!verifyRuntimeSnapshot(runtime.snapshot) || !verifyRuntimeSources(options.workflowPath, runtime.snapshot)) {
      throw new Error('trusted OpenCode runtime source or snapshot changed during the workflow')
    }
    const pluginPath = join(runtime.root, 'credential-scrubber.js')
    const writableWorkspace = `ub-workspace/changes/${options.changeId}/exploration_notes.md`
    const permissionBases = opencodeWorktreeBases(workspacePath)
    const writablePatterns = opencodeTargetPatterns(permissionBases, join(workspacePath, writableWorkspace))
    const protectedReads: Record<string, 'allow' | 'deny'> = {
      '*': 'deny',
    }
    const allowReadTree = (root: string): void => {
      for (const pattern of opencodeTargetPatterns(permissionBases, root)) {
        protectedReads[pattern] = 'allow'
        protectedReads[`${pattern}/**`] = 'allow'
      }
    }
    for (const root of runtime.sourceRoots) allowReadTree(root.path)
    for (const pattern of writablePatterns) protectedReads[pattern] = 'allow'
    allowReadTree(join(runtime.snapshot.configDir, 'references', '_shared'))
    allowReadTree(join(runtime.snapshot.configDir, 'references', options.module))
    const protectedEdits: Record<string, 'allow' | 'deny'> = {
      '*': 'deny',
      ...Object.fromEntries(writablePatterns.map(pattern => [pattern, 'allow' as const])),
      [openCodePermissionPath(join(options.repoPath, 'agents', '**'))]: 'deny',
      [openCodePermissionPath(join(options.repoPath, 'skills', '**'))]: 'deny',
      [openCodePermissionPath(join(options.repoPath, 'opencode.json'))]: 'deny',
      [openCodePermissionPath(join(options.repoPath, 'opencode.jsonc'))]: 'deny',
      [openCodePermissionPath(join(options.repoPath, '.opencode', '**'))]: 'deny',
      [openCodePermissionPath(join(runtime.snapshot.configDir, '**'))]: 'deny',
    }
    const agents = Object.fromEntries(REQUIRED_RUNTIME_AGENTS.map(name => [name, {
      permission: {
        '*': 'deny',
        read: protectedReads,
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        skill: 'deny',
        todowrite: 'allow',
        question: 'deny',
        task: { '*': 'deny' },
        edit: protectedEdits,
        external_directory: {
          '*': 'deny',
          ...Object.fromEntries(runtime.sourceRoots.flatMap(root => [
            [openCodePermissionPath(root.path), 'allow'],
            [openCodePermissionPath(join(root.path, '**')), 'allow'],
          ])),
          [openCodePermissionPath(join(runtime.snapshot.configDir, '**'))]: 'allow',
        },
      },
    }]))
    const pluginUrl = pathToFileURL(pluginPath).href
    const runtimeConfig: Record<string, unknown> = {
      plugin: [pluginUrl],
      agent: agents,
      mcp: {},
    }
    const config = JSON.stringify({
      cmd: launch.cmd,
      args: [...launch.argsPrefix, 'serve', '--hostname', '127.0.0.1', '--port', '0'],
      cwd: workspacePath,
    })
    const child = this.spawnImpl(process.execPath, ['-e', SUPERVISOR_SOURCE, config], {
      cwd: workspacePath,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG: undefined,
        OPENCODE_CONFIG_DIR: runtime.snapshot.configDir,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig),
        OPENCODE_PERMISSION: undefined,
        OPENCODE_PLUGIN_META_FILE: undefined,
        OPENCODE_DB: undefined,
        OPENCODE_MODELS_PATH: undefined,
        OPENCODE_MODELS_URL: undefined,
        OPENCODE_DIRECT_TRACE: undefined,
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        OTEL_EXPORTER_OTLP_HEADERS: undefined,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
        OPENCODE_TEST_HOME: runtime.home,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: runtime.managedConfig,
        XDG_CONFIG_HOME: runtime.xdgConfig,
        XDG_STATE_HOME: runtime.xdgState,
        XDG_CACHE_HOME: runtime.xdgCache,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      },
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    let resolveWorker!: () => void
    const workerReady = new Promise<void>(resolve => { resolveWorker = resolve })
    const server: ServerState = {
      child, workerReady, resolveWorker, username, password, pluginUrl,
      configDir: runtime.snapshot.configDir, repoPath: workspacePath,
      sourceRoots: runtime.sourceRoots.map(root => ({ ...root })),
      ready, reconnects: 0, closing: false,
    }
    this.server = server
    active.server = server
    void this.initializeServer(server, resolveReady, rejectReady)
    await ready
    if (this.active !== active || active.server !== server) throw new Error('OpenCode segment stopped during startup')
    return server
  }

  private ensureWorkflowRuntime(options: ServerRunnerOptions): NonNullable<OpenCodeServerRunner['workflowRuntime']> {
    const current = this.workflowRuntime
    if (current !== undefined && current.workflowId === options.workflowId
      && current.repoPath === options.repoPath
      && current.workflowPath === options.workflowPath
      && current.module === options.module
      && JSON.stringify(current.sourceRoots) === JSON.stringify(options.sourceRoots)) {
      return current
    }
    this.clearWorkflowRuntime()
    const root = mkdtempSync(join(tmpdir(), 'dsh-ub-opencode-'))
    try {
      const pluginPath = join(root, 'credential-scrubber.js')
      const home = join(root, 'home')
      const xdgConfig = join(root, 'xdg-config')
      const xdgState = join(root, 'xdg-state')
      const xdgCache = join(root, 'xdg-cache')
      const managedConfig = join(root, 'managed-config')
      for (const directory of [home, xdgConfig, xdgState, xdgCache, managedConfig]) {
        mkdirSync(directory, { mode: 0o700 })
      }
      // OpenCode checks every discovered config directory for plugin runtime
      // dependencies. An empty writable global config triggers an npm network
      // install even though this runner disables default/external plugins.
      // Make the isolated global config complete and read-only so that check
      // deterministically becomes a no-op.
      const globalConfig = join(xdgConfig, 'opencode')
      mkdirSync(globalConfig, { mode: 0o700 })
      writeFileSync(
        join(globalConfig, '.gitignore'),
        'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n',
        { mode: 0o400, flag: 'wx' },
      )
      chmodSync(globalConfig, 0o500)
      const snapshot = createRuntimeSnapshot(options.workflowPath, root)
      const manifestRoots = loadModuleCodeRootIds(snapshot.configDir, options.module)
      const sourceRoots = validateFrozenSourceRoots(options.sourceRoots)
      if (JSON.stringify(manifestRoots) !== JSON.stringify(sourceRoots.map(root => root.manifestPath))) {
        throw new Error('frozen source root mapping does not match the runtime manifest snapshot')
      }
      writeFileSync(
        pluginPath,
        runtimeGuardPluginSource(
          options.repoPath,
          snapshot.configDir,
          options.changeId,
          options.module,
          sourceRoots,
        ),
        { mode: 0o400, flag: 'wx' },
      )
      this.workflowRuntime = {
        workflowId: options.workflowId,
        repoPath: options.repoPath,
        workflowPath: options.workflowPath,
        module: options.module,
        sourceRoots,
        root,
        snapshot,
        home,
        xdgConfig,
        xdgState,
        xdgCache,
        managedConfig,
      }
      return this.workflowRuntime
    } catch (error) {
      try { this.makeRuntimeTreeWritable(root) } catch {}
      try { rmSync(root, { recursive: true, force: true }) } catch {}
      throw error
    }
  }

  private clearWorkflowRuntime(): void {
    const current = this.workflowRuntime
    this.workflowRuntime = undefined
    if (current !== undefined) {
      try { this.makeRuntimeTreeWritable(current.root) } catch {}
      try { rmSync(current.root, { recursive: true, force: true }) } catch {}
    }
  }

  private makeRuntimeTreeWritable(path: string): void {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (!stat.isDirectory()) {
      if (stat.isFile()) chmodSync(path, 0o600)
      return
    }
    chmodSync(path, 0o700)
    for (const entry of readdirSync(path)) this.makeRuntimeTreeWritable(join(path, entry))
  }

  private async initializeServer(server: ServerState, ready: () => void, reject: (error: Error) => void): Promise<void> {
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    let partial = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('OpenCode server startup timed out')); this.closeServer(server) }
    }, this.startupTimeoutMs)
    timer.unref?.()
    const workerPipe = server.child.stdio?.[3]
    if (workerPipe === null || workerPipe === undefined || typeof workerPipe.on !== 'function') {
      settled = true
      clearTimeout(timer)
      reject(new Error('OpenCode supervisor worker PID channel is unavailable'))
      this.closeServer(server)
      return
    }
    let workerBuffer = ''
    const invalidWorker = (): void => {
      server.resolveWorker()
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('OpenCode supervisor returned an invalid worker PID'))
      }
      this.closeServer(server)
    }
    const workerData = (chunk: Buffer): void => {
      if (server.workerPid !== undefined) return
      workerBuffer += String(chunk)
      if (workerBuffer.length > 32) {
        invalidWorker()
        return
      }
      const newline = workerBuffer.indexOf('\n')
      if (newline < 0) return
      const value = workerBuffer.slice(0, newline).trim()
      const pid = Number(value)
      if (String(pid) !== value || !Number.isSafeInteger(pid) || pid <= 0) {
        invalidWorker()
        return
      }
      server.workerPid = pid
      server.resolveWorker()
      workerPipe.removeListener('data', workerData)
    }
    workerPipe.on('data', workerData)
    const line = (value: string): void => {
      const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(value)
      if (match !== null && !settled) {
        server.origin = match[1]
        void (async () => {
          await server.workerReady
          if (server.workerPid === undefined) throw new Error('OpenCode supervisor returned an invalid worker PID')
          await this.probe(server)
          if (this.server !== server || settled) return
          let connected!: () => void
          const firstConnection = new Promise<void>(resolve => { connected = resolve })
          server.sseAbort = new AbortController()
          void this.events(server, server.sseAbort.signal, connected)
          // Session creation and prompt submission are unsafe until the
          // authenticated event stream is actually subscribed.
          await firstConnection
          if (this.server !== server || settled || server.closing) return
          settled = true; clearTimeout(timer); ready()
        })().catch(error => {
          if (settled) return
          settled = true; clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error)))
          this.closeServer(server)
        })
      } else if (value.trim() !== '') this.active?.options.onLogLine?.(`[opencode server] ${value.trim().slice(0, 1_200)}`)
    }
    server.child.stdout?.on('data', (chunk: Buffer) => {
      partial += stdout.write(chunk)
      if (partial.length > MAX_EVENT_CHARS * 2) partial = partial.slice(-MAX_EVENT_CHARS)
      const lines = partial.split(/\r?\n/); partial = lines.pop() ?? ''
      for (const value of lines) line(value)
    })
    server.child.stderr?.on('data', (chunk: Buffer) => {
      const value = stderr.write(chunk).trim()
      if (value !== '') this.active?.options.onLogLine?.(`[opencode server stderr] ${value.slice(0, 1_200)}`)
    })
    server.child.once('error', error => {
      server.resolveWorker()
      if (!settled) { settled = true; clearTimeout(timer); reject(error) }
      this.serverExited(server, -1, null)
    })
    server.child.once('close', (code, signal) => {
      server.resolveWorker()
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`OpenCode server exited before ready (${code}/${signal})`)) }
      this.serverExited(server, code, signal)
    })
  }

  private async probe(server: ServerState): Promise<void> {
    const health = await this.requestJson(server, '/global/health', { method: 'GET' })
    if (!isRecord(health) || health.healthy !== true || !supportsVersion(health.version)) {
      throw new Error(`OpenCode 1.18.3 is required; received ${isRecord(health) ? String(health.version) : 'unknown'}`)
    }
    const doc = await this.requestJson(server, '/doc', { method: 'GET' })
    if (!isRecord(doc) || !isRecord(doc.paths)) throw new Error('OpenCode did not expose a valid OpenAPI document')
    const missing = REQUIRED_PATHS.filter(path => !Object.hasOwn(doc.paths as object, path))
    if (missing.length > 0) throw new Error(`OpenCode API is missing: ${missing.join(', ')}`)
    const configuredAgents = await this.requestJson(server, '/agent', { method: 'GET' })
    if (!Array.isArray(configuredAgents) || configuredAgents.length > 64
      || !configuredAgents.every(value => isRecord(value) && typeof value.name === 'string')) {
      throw new Error('OpenCode returned an invalid agent registry')
    }
    const customAgentRecords = configuredAgents
      .filter(value => isRecord(value) && value.native !== true) as Record<string, unknown>[]
    const customAgents = customAgentRecords.map(value => value.name as string)
      .sort()
    const expectedAgents = [...REQUIRED_RUNTIME_AGENTS].sort()
    if (JSON.stringify(customAgents) !== JSON.stringify(expectedAgents)) {
      throw new Error(`OpenCode agent registry is not isolated: ${customAgents.join(', ')}`)
    }
    if (customAgentRecords.some(agent => !hasReadonlyExplorePermissions(
      agent,
      this.active?.options.changeId ?? '',
      server.repoPath,
      server.configDir,
      this.active?.options.module ?? '',
      server.sourceRoots,
    ))) {
      throw new Error('OpenCode agent permissions are not confined to the read-only Explore profile')
    }
    const configuredSkills = await this.requestJson(server, '/skill', { method: 'GET' })
    if (!Array.isArray(configuredSkills) || configuredSkills.length > 64
      || !configuredSkills.every(value => isRecord(value)
        && typeof value.name === 'string' && typeof value.location === 'string')) {
      throw new Error('OpenCode returned an invalid skill registry')
    }
    const expectedSkills = new Set<string>([...REQUIRED_RUNTIME_SKILLS, 'customize-opencode'])
    const actualSkills = configuredSkills.map(value => (value as Record<string, unknown>).name as string)
    if (actualSkills.length !== expectedSkills.size || actualSkills.some(name => !expectedSkills.has(name))) {
      throw new Error(`OpenCode skill registry is not isolated: ${actualSkills.sort().join(', ')}`)
    }
    for (const value of configuredSkills) {
      if (!isRecord(value) || value.name === 'customize-opencode') continue
      const location = value.location as string
      if (!location.startsWith(`${server.configDir}/`) && !location.startsWith(`${server.configDir}\\`)) {
        throw new Error(`OpenCode skill was loaded outside the trusted snapshot: ${String(value.name)}`)
      }
    }
    const config = await this.requestJson(server, '/config', { method: 'GET' })
    if (!isRecord(config) || !Array.isArray(config.plugin)
      || config.plugin.length !== 1 || config.plugin[0] !== server.pluginUrl
      || !isRecord(config.mcp) || Object.keys(config.mcp).length !== 0) {
      throw new Error('OpenCode plugin configuration is not isolated')
    }
  }

  private async events(server: ServerState, signal: AbortSignal, firstConnected: () => void): Promise<void> {
    let announcedConnection = false
    while (this.server === server && !server.closing && !signal.aborted) {
      try {
        const response = await this.request(server, '/event', { method: 'GET', signal }, false)
        if (response.status !== 200 || response.body === null
          || !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
          throw new Error(`SSE subscription failed with HTTP ${response.status}`)
        }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
        let connectedAt: number | undefined
        let recovered = false
        while (!signal.aborted) {
          const chunk = await readWithDeadline(reader, this.sseReadTimeoutMs, signal); if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          if (buffer.length > MAX_EVENT_CHARS * 2) throw new Error('OpenCode SSE event exceeds size limit')
          const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const result = this.frame(server, frame)
            if (result.activity) server.reconnects = 0
            if (result.connected && !recovered) {
              connectedAt = Date.now()
              recovered = true
              if (!announcedConnection) { announcedConnection = true; firstConnected() }
              const active = this.active
              if (active?.server === server) await this.recover(server, active)
            }
          }
        }
        if (signal.aborted) return
        if (connectedAt !== undefined && Date.now() - connectedAt >= 2_000) server.reconnects = 0
        throw new Error('OpenCode SSE stream ended')
      } catch (error) {
        if (signal.aborted || this.server !== server || server.closing) return
        server.reconnects += 1
        this.active?.options.onLogLine?.(`[SSE reconnect ${server.reconnects}/3] ${error instanceof Error ? error.message : String(error)}`)
        if (server.reconnects > 3) {
          const active = this.active
          if (active?.server === server) this.fail(active, 'OpenCode SSE reconnect budget exhausted')
          else this.closeServer(server)
          return
        }
        await new Promise(resolve => setTimeout(resolve, this.reconnectBaseMs * server.reconnects))
      }
    }
  }

  private frame(server: ServerState, frame: string): { connected: boolean; activity: boolean } {
    const data = frame.split(/\r?\n/).filter(value => value.startsWith('data:'))
      .map(value => value.slice(5).trimStart()).join('\n')
    if (data === '' || data.length > MAX_EVENT_CHARS) return { connected: false, activity: false }
    try {
      const parsed: unknown = JSON.parse(data)
      if (!isRecord(parsed) || typeof parsed.type !== 'string' || !isRecord(parsed.properties)) {
        return { connected: false, activity: false }
      }
      const connected = parsed.type === 'server.connected'
      const active = this.active
      const activity = active?.server === server ? this.event(active, parsed) : false
      return { connected, activity }
    } catch {
      return { connected: false, activity: false }
    }
  }

  private event(active: ActiveSegment, raw: unknown): boolean {
    if (this.active !== active || !isRecord(raw) || typeof raw.type !== 'string' || !isRecord(raw.properties)) return false
    const props = raw.properties
    const owner = sessionId(props.sessionID) ? props.sessionID : undefined
    if (raw.type === 'session.created' && isRecord(props.info) && sessionId(props.info.id)) {
      const parent = sessionId(props.info.parentID) ? props.info.parentID : undefined
      active.parents.set(props.info.id, parent)
      if (parent !== undefined && this.owned(active, parent)) active.ownedSessions.add(props.info.id)
      return parent !== undefined && this.owned(active, parent)
    }
    if (raw.type === 'question.asked' || raw.type === 'question.v2.asked') {
      if (owner === undefined || !this.owned(active, owner)) return false
      this.fail(active, 'OpenCode runtime questions are disabled; required input must use a fixed DSH gate')
      return true
    }
    if (raw.type === 'question.replied' || raw.type === 'question.rejected') {
      if (owner === undefined || !this.owned(active, owner)) return false
      this.securityFailure(active, `unexpected ${raw.type} event while runtime questions are disabled`)
      return true
    }
    if ((raw.type === 'permission.asked' || raw.type === 'permission.v2.asked')
      && owner !== undefined && this.owned(active, owner)) {
      this.fail(active, `OpenCode permission request blocked: ${safeText(props.permission ?? props.action) ?? 'unknown'}`)
      return true
    }
    if (raw.type === 'session.error' && owner !== undefined && this.owned(active, owner)) {
      this.fail(active, `OpenCode session error: ${safeText(JSON.stringify(props.error ?? {}), 1_200) ?? 'unknown'}`)
      return true
    }
    if ((raw.type === 'session.status' || raw.type === 'session.idle') && owner === active.rootSessionId) {
      const status = isRecord(props.status) ? props.status.type : raw.type === 'session.idle' ? 'idle' : undefined
      if (status === 'busy' || status === 'retry') active.sawActivity = true
      if (status === 'idle') active.sawIdle = true
      if (status === 'idle' && active.promptAccepted && active.sawActivity) {
        queueMicrotask(() => { if (this.active === active) this.finish(active, 0, null) })
      }
      return true
    }
    if (owner !== undefined && this.owned(active, owner)
      && (raw.type === 'message.updated' || raw.type === 'message.part.updated')) {
      active.sawActivity = true
      const part = isRecord(props.part) ? props.part : undefined
      const toolName = part !== undefined && typeof part.tool === 'string' ? part.tool : undefined
      const text = part === undefined ? undefined : safeText(part.text)
        ?? (isRecord(part.state) ? safeText(part.state.title) ?? safeText(part.state.output) : undefined)
      active.options.onEvent?.({ sessionId: owner, toolName, text, raw })
      return true
    }
    return false
  }

  private owned(active: ActiveSegment, id: string): boolean {
    if (active.ownedSessions.has(id)) return true
    const seen = new Set<string>(); let current: string | undefined = id
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      if (current === active.rootSessionId) { for (const value of seen) active.ownedSessions.add(value); return true }
      current = active.parents.get(current)
    }
    return false
  }

  private async recover(server: ServerState, active: ActiveSegment): Promise<void> {
    if (this.active !== active || active.server !== server || active.rootSessionId === undefined) return
    const queue = [active.rootSessionId]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const parent = queue.shift()
      if (parent === undefined || visited.has(parent)) continue
      visited.add(parent)
      if (visited.size > 128) throw new Error('OpenCode child session topology exceeds safety limit')
      active.ownedSessions.add(parent)
      const children = await this.requestJson(server, `/session/${encodeURIComponent(parent)}/children`, { method: 'GET' })
      if (this.active !== active || active.server !== server) return
      if (!Array.isArray(children) || children.length > 128) throw new Error('OpenCode returned an invalid child session topology')
      for (const child of children) {
        if (!isRecord(child) || !sessionId(child.id)) throw new Error('OpenCode returned an invalid child session')
        const declaredParent = sessionId(child.parentID) ? child.parentID : parent
        active.parents.set(child.id, declaredParent)
        if (!visited.has(child.id)) queue.push(child.id)
      }
    }
    const pending = await this.requestJson(server, '/question', { method: 'GET' })
    if (this.active !== active || active.server !== server) return
    if (!Array.isArray(pending) || pending.length > 128) throw new Error('OpenCode returned an invalid pending question list')
    for (const value of pending) {
      if (!isRecord(value) || !sessionId(value.sessionID)) continue
      if (!this.owned(active, value.sessionID)) continue
      this.fail(active, 'OpenCode runtime questions are disabled; required input must use a fixed DSH gate')
      return
    }
    const statuses = await this.requestJson(server, '/session/status', { method: 'GET' })
    if (this.active !== active || active.server !== server) return
    if (isRecord(statuses) && active.rootSessionId !== undefined && isRecord(statuses[active.rootSessionId])) {
      this.event(active, { type: 'session.status', properties: { sessionID: active.rootSessionId, status: statuses[active.rootSessionId] } })
    } else if (isRecord(statuses) && this.active === active && active.promptAccepted) {
      // OpenCode may remove a completed idle session from the status map
      // before a reconnecting subscriber observes its activity/idle frames.
      // A completed assistant message is the durable terminal witness; mere
      // absence from the transient status map is not enough to finish.
      const messages = await this.requestJson(
        server,
        `/session/${encodeURIComponent(active.rootSessionId)}/message?limit=128`,
        { method: 'GET' },
      )
      if (this.active !== active || active.server !== server) return
      if (!Array.isArray(messages) || messages.length > 128) {
        throw new Error('OpenCode returned an invalid session message history')
      }
      let completed = false
      for (const value of messages) {
        if (!isRecord(value) || !isRecord(value.info)) {
          throw new Error('OpenCode returned an invalid session message')
        }
        const info = value.info
        if (info.sessionID !== active.rootSessionId || (info.role !== 'user' && info.role !== 'assistant')) {
          throw new Error('OpenCode returned a foreign session message')
        }
        if (info.role !== 'assistant') continue
        if (info.error !== undefined) {
          this.fail(active, `OpenCode assistant message failed: ${safeText(JSON.stringify(info.error), 1_200) ?? 'unknown'}`)
          return
        }
        if (isRecord(info.time) && Number.isFinite(info.time.completed)) completed = true
      }
      if (completed) {
        active.sawActivity = true
        this.event(active, { type: 'session.idle', properties: { sessionID: active.rootSessionId } })
      }
    }
  }

  private async requestJson(server: ServerState, path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timer.unref?.()
    try {
      const response = await this.request(server, path, { ...init, signal: controller.signal }, false)
      if (!response.ok) throw new Error(`OpenCode request ${path} failed with HTTP ${response.status}`)
      return await boundedJson(response, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(server: ServerState, path: string, init: RequestInit, timeout = true): Promise<Response> {
    if (this.server !== server || server.origin === undefined || server.closing) throw new Error('OpenCode server unavailable')
    const url = new URL(path, server.origin)
    if (path !== '/global/health' && path !== '/doc') url.searchParams.set('directory', server.repoPath)
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Basic ${Buffer.from(`${server.username}:${server.password}`).toString('base64')}`)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    const controller = timeout && init.signal === undefined ? new AbortController() : undefined
    const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timer?.unref?.()
    try {
      const response = await this.fetchImpl(url, { ...init, headers, signal: init.signal ?? controller?.signal })
      if (response.status === 401) throw new Error('OpenCode loopback authentication failed')
      return response
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private finish(active: ActiveSegment, code: number | null, signal: string | null): void {
    if (this.active !== active) return
    const runtime = this.workflowRuntime
    if (code === 0 && (runtime === undefined
      || !verifyRuntimeSnapshot(runtime.snapshot)
      || !verifyRuntimeSources(runtime.workflowPath, runtime.snapshot))) {
      code = -1
      this.log(active, '[runner failure] trusted OpenCode runtime changed during the segment')
    }
    this.active = undefined
    const server = active.server
    if (server === undefined) {
      active.options.onExit?.(code, signal)
      return
    }
    server.plannedExit = { active, code, signal, notify: true }
    this.closeServer(server)
  }

  private securityFailure(active: ActiveSegment, message: string): void {
    this.fail(active, `security violation: ${message}`)
  }

  private fail(active: ActiveSegment, message: string): void {
    this.log(active, `[runner failure] ${message}`)
    const server = active.server
    if (active.rootSessionId !== undefined && server !== undefined) {
      void this.request(server, `/session/${encodeURIComponent(active.rootSessionId)}/abort`, { method: 'POST' })
        .catch(() => {})
    }
    this.finish(active, -1, null)
  }

  private serverExited(server: ServerState, code: number | null, signal: string | null): void {
    if (this.server !== server) return
    this.server = undefined
    server.sseAbort?.abort()
    if (server.shutdownTimer !== undefined) clearTimeout(server.shutdownTimer)
    const planned = server.plannedExit
    if (planned === undefined) this.forceStopWorkerTree(server)
    if (planned !== undefined) {
      planned.active.options.onStopped?.()
      if (planned.notify) planned.active.options.onExit?.(planned.code, planned.signal)
      if (this.disposeRequested) this.clearWorkflowRuntime()
      return
    }
    if (this.active?.server === server) {
      const active = this.active
      this.active = undefined
      this.log(active, `[opencode server exited] code=${code} signal=${signal}`)
      active.options.onStopped?.()
      active.options.onExit?.(code === 0 ? -1 : code, signal)
      if (this.disposeRequested) this.clearWorkflowRuntime()
      return
    }
    if (this.disposeRequested) this.clearWorkflowRuntime()
  }

  private closeServer(server: ServerState): void {
    if (this.server !== server || server.closing) return
    server.closing = true
    server.sseAbort?.abort()
    try { server.child.stdin?.end() } catch {}
    server.shutdownTimer = setTimeout(() => {
      this.forceStopWorkerTree(server)
      try { server.child.kill('SIGKILL') } catch {}
    }, 6_000)
    server.shutdownTimer.unref?.()
  }

  private forceStopWorkerTree(server: ServerState): void {
    if (server.workerPid === undefined) return
    if (process.platform === 'win32') {
      try {
        const killer = this.spawnImpl('taskkill.exe', ['/PID', String(server.workerPid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.unref()
      } catch {}
      return
    }
    try {
      process.kill(-server.workerPid, 'SIGKILL')
    } catch {
      try { process.kill(server.workerPid, 'SIGKILL') } catch {}
    }
  }

  private log(active: ActiveSegment, value: string): void {
    if (this.active === active) active.options.onLogLine?.(value.slice(0, 1_200))
  }
}
