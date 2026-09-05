import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenCodeServerRunner,
  opencodeTargetPatterns,
  opencodeWorktreeBases,
  permissionPatternMatches,
  runtimeGuardPluginSource,
  SUPERVISOR_SOURCE,
} from '../src/serverRunner.ts'
import { REQUIRED_RUNTIME_AGENTS, REQUIRED_RUNTIME_SKILLS } from '../src/runtimeSnapshot.ts'

const REQUIRED_PATHS = [
  '/event', '/session', '/session/{sessionID}', '/session/{sessionID}/prompt_async',
  '/session/{sessionID}/abort', '/question', '/session/{sessionID}/children', '/session/{sessionID}/message',
  '/agent', '/skill', '/session/status', '/config',
]

const temporaryRoots: string[] = []
const liveRunners: OpenCodeServerRunner[] = []

afterEach(() => {
  for (const runner of liveRunners.splice(0)) runner.dispose()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly worker = new PassThrough()
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.worker]
  readonly pid = 43_210
  readonly kill = vi.fn(() => true)

  constructor() {
    super()
    this.stdin.once('finish', () => { queueMicrotask(() => { this.emit('close', 0, null) }) })
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function flush(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fixtureRepo(root = mkdtempSync(join(tmpdir(), 'dsh-server-runner-test-'))): string {
  temporaryRoots.push(root)
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'skills'), { recursive: true })
  mkdirSync(join(root, 'references', '_shared'), { recursive: true })
  mkdirSync(join(root, 'references', 'udma'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'other-module'), { recursive: true })
  for (const agent of REQUIRED_RUNTIME_AGENTS) {
    writeFileSync(join(root, 'agents', `${agent}.md`), [
      '---',
      `name: ${agent}`,
      `mode: ${agent === 'ub-leader' ? 'primary' : 'subagent'}`,
      'permission:',
      '  edit: allow',
      '  bash: allow',
      '  task: { "*": allow }',
      '  skill: { "*": allow }',
      '  question: allow',
      '---',
      `# ${agent}`,
      'Read skills/ub-workflow/SKILL.md.',
      '',
    ].join('\n'))
  }
  for (const skill of REQUIRED_RUNTIME_SKILLS) {
    const directory = join(root, 'skills', skill)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), [
      '---',
      `name: ${skill}`,
      `description: Protocol for ${skill}`,
      '---',
      `# ${skill}`,
      `Protocol for ${skill}.`,
      '',
    ].join('\n'))
  }
  writeFileSync(join(root, 'references', '_shared', 'knowledge-lifecycle.md'), '# Knowledge lifecycle\n')
  writeFileSync(join(root, 'references', 'udma', '_manifest.yaml'), 'module: udma\ncode_roots: [src]\n')
  return root
}

function permissionRules(config: Record<string, unknown>, name: string): Array<Record<string, string>> {
  const agent = (config.agent as Record<string, Record<string, unknown>> | undefined)?.[name]
  const permission = agent?.permission as Record<string, string | Record<string, string>> | undefined
  if (permission === undefined) return []
  return Object.entries(permission).flatMap(([key, value]) => (
    typeof value === 'string'
      ? [{ permission: key, pattern: '*', action: value }]
      : Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern, action }))
  ))
}

interface HarnessOptions {
  deferPrompt?: boolean
  closingSse?: boolean
  hangingConfigBody?: boolean
  requestTimeoutMs?: number
  sseReadTimeoutMs?: number
  missingSessionStatus?: boolean
  completedSessionMessages?: boolean
  repoPath?: string
}

function harness(options: HarnessOptions = {}) {
  const repoPath = options.repoPath ?? fixtureRepo()
  const children: FakeChild[] = []
  const calls: Array<{ path: string; init: RequestInit }> = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  let spawnEnvironment: Record<string, string | undefined> = {}
  let resolvePrompt: ((response: Response) => void) | undefined
  const prompt = new Promise<Response>(resolve => { resolvePrompt = resolve })
  const encoder = new TextEncoder()
  let mainCreated = false

  const spawnImpl = vi.fn((_command: string, _args: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
    spawnEnvironment = { ...spawnOptions.env }
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }) as unknown as typeof spawn

  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url)
    calls.push({ path: url.pathname, init })
    if (url.pathname === '/global/health') return json({ healthy: true, version: '1.18.3' })
    if (url.pathname === '/doc') return json({ paths: Object.fromEntries(REQUIRED_PATHS.map(path => [path, {}])) })
    if (url.pathname === '/agent') {
      const config = JSON.parse(spawnEnvironment.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      return json(REQUIRED_RUNTIME_AGENTS.map(name => ({
        name,
        native: false,
        permission: permissionRules(config, name),
      })))
    }
    if (url.pathname === '/skill') {
      const configDir = spawnEnvironment.OPENCODE_CONFIG_DIR ?? ''
      return json([
        ...REQUIRED_RUNTIME_SKILLS.map(name => ({ name, location: join(configDir, 'skills', name, 'SKILL.md') })),
        { name: 'customize-opencode', location: '/builtin/customize-opencode/SKILL.md' },
      ])
    }
    if (url.pathname === '/config') {
      if (options.hangingConfigBody) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return json(JSON.parse(spawnEnvironment.OPENCODE_CONFIG_CONTENT ?? '{}'))
    }
    if (url.pathname === '/session' && init.method === 'POST') {
      mainCreated = true
      return json({ id: 'ses_main' })
    }
    if (url.pathname === '/event') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller)
          if (options.closingSse) {
            controller.enqueue(encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'))
            controller.close()
          }
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.pathname === '/session/ses_main/prompt_async') {
      return options.deferPrompt ? await prompt : new Response(null, { status: 204 })
    }
    if (url.pathname === '/session/ses_main/children') return json([])
    if (url.pathname === '/session/ses_main/message') {
      return json(options.completedSessionMessages ? [{
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_main',
          role: 'assistant',
          time: { created: 1, completed: 2 },
        },
        parts: [],
      }] : [])
    }
    if (url.pathname === '/question') return json([])
    if (url.pathname === '/session/status') {
      return json(mainCreated && !options.missingSessionStatus ? { ses_main: { type: 'busy' } } : {})
    }
    if (url.pathname === '/session/ses_main/abort') return json(true)
    throw new Error(`unexpected request ${url.pathname}`)
  }) as unknown as typeof fetch

  const runner = new OpenCodeServerRunner({
    fetch: fetchImpl,
    spawn: spawnImpl,
    randomSecret: () => 'x'.repeat(43),
    startupTimeoutMs: 1_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    reconnectBaseMs: 1,
    sseReadTimeoutMs: options.sseReadTimeoutMs ?? 1_000,
  })
  liveRunners.push(runner)

  const child = (index = 0): FakeChild => {
    const value = children[index]
    if (value === undefined) throw new Error(`missing fake child ${index}`)
    return value
  }
  const announce = (index = 0): void => {
    child(index).worker.write('43210\n')
    child(index).stdout.write('opencode server listening on http://127.0.0.1:4096\n')
  }
  const connect = (index = 0): void => {
    streams[index]?.enqueue(encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'))
  }
  const event = (value: unknown, index = 0): void => {
    streams[index]?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
  }
  return {
    repoPath, runner, children, calls, streams, spawnImpl, child, announce, connect, event,
    environment: () => spawnEnvironment,
    resolvePrompt: (value: Response) => { resolvePrompt?.(value) },
  }
}

function startOptions(repoPath: string, extra: Partial<Parameters<OpenCodeServerRunner['start']>[0]> = {}) {
  return {
    workflowId: 'run-test',
    changeId: 'udma-explore-test',
    module: 'udma',
    repoPath,
    workflowPath: repoPath,
    sourceRoots: [{ manifestPath: 'src', path: realpathSync(join(repoPath, 'src')) }],
    title: 'segment',
    prompt: 'go',
    ...extra,
  }
}

describe('OpenCodeServerRunner lifecycle', () => {
  it('matches OpenCode permission paths with Windows separators and case semantics', () => {
    expect(permissionPatternMatches(
      'C:\\Runtime\\Config\\references\\udma\\**',
      'c:/runtime/config/references/UDMA/guide.md',
      'win32',
    )).toBe(true)
    expect(permissionPatternMatches(
      'C:\\Runtime\\Config\\references\\udma\\**',
      'c:/runtime/config/references/ummu/guide.md',
      'win32',
    )).toBe(false)
  })

  // Regression: OpenCode 1.18.3 evaluates read/edit permission patterns as
  // path.relative(instance.worktree, target), where the worktree is the Git
  // toplevel of the working directory. A workspace nested inside a larger
  // checkout previously produced rules OpenCode could never match, so every
  // read of the selected source roots and every write of exploration_notes.md
  // was denied and Explore could only fail closed.
  it('spells allow patterns relative to the enclosing Git worktree', () => {
    const outer = mkdtempSync(join(tmpdir(), 'dsh-server-runner-worktree-'))
    temporaryRoots.push(outer)
    const init = spawnSync('git', ['init', '--quiet', outer], { encoding: 'utf8' })
    if (init.status !== 0) return // git unavailable in this environment
    const nested = join(outer, 'nested', 'workspace')
    mkdirSync(nested, { recursive: true })
    const repoPath = realpathSync(fixtureRepo(nested))
    const bases = opencodeWorktreeBases(repoPath)
    expect(bases).toEqual([repoPath, realpathSync(outer)])
    const spellings = opencodeTargetPatterns(
      bases,
      join(repoPath, 'ub-workspace/changes/udma-explore-test/exploration_notes.md'),
    )
    expect(spellings).toContain('ub-workspace/changes/udma-explore-test/exploration_notes.md')
    expect(spellings).toContain('nested/workspace/ub-workspace/changes/udma-explore-test/exploration_notes.md')
  })

  it('emits worktree-relative Explore allow rules for a workspace inside a larger Git checkout', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'dsh-server-runner-worktree-'))
    temporaryRoots.push(outer)
    const init = spawnSync('git', ['init', '--quiet', outer], { encoding: 'utf8' })
    if (init.status !== 0) return // git unavailable in this environment
    const nested = join(outer, 'nested', 'workspace')
    mkdirSync(nested, { recursive: true })
    const repoPath = fixtureRepo(nested)
    const h = harness({ repoPath })
    expect(h.runner.start(startOptions(repoPath))).toBe(true)
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))
    const config = JSON.parse(h.environment().OPENCODE_CONFIG_CONTENT ?? '{}') as {
      agent: Record<string, { permission: { read: Record<string, string>; edit: Record<string, string> } }>
    }
    const permission = config.agent['ub-leader']!.permission
    expect(permission.edit['nested/workspace/ub-workspace/changes/udma-explore-test/exploration_notes.md']).toBe('allow')
    expect(permission.edit['ub-workspace/changes/udma-explore-test/exploration_notes.md']).toBe('allow')
    expect(permission.read['nested/workspace/src']).toBe('allow')
    expect(permission.read['nested/workspace/src/**']).toBe('allow')
    expect(permission.read['src']).toBe('allow')
    expect(permission.edit['*']).toBe('deny')
    expect(permission.read['*']).toBe('deny')
  })

  it('loads only the immutable workflow snapshot before creating the workflow session', async () => {
    const h = harness()
    expect(h.runner.start(startOptions(h.repoPath))).toBe(true)
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    expect(h.calls.filter(call => call.path === '/session')).toHaveLength(0)
    expect(h.calls.some(call => call.path.endsWith('/prompt_async'))).toBe(false)

    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))
    const environment = h.environment()
    expect(environment.OPENCODE_CONFIG).toBeUndefined()
    expect(environment.OPENCODE_CONFIG_DIR).toMatch(/\/config$/)
    expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
    expect(environment.OPENCODE_TEST_HOME).toMatch(/\/home$/)
    expect(environment.XDG_CONFIG_HOME).toMatch(/\/xdg-config$/)
    expect(statSync(join(environment.XDG_CONFIG_HOME ?? '', 'opencode')).mode & 0o222).toBe(0)
    expect(environment.XDG_STATE_HOME).toMatch(/\/xdg-state$/)
    expect(environment.XDG_CACHE_HOME).toMatch(/\/xdg-cache$/)
    expect(environment.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME)
    const runtimeConfig = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
    expect(runtimeConfig).toMatchObject({
      agent: {
        'ub-leader': {
          permission: {
            '*': 'deny',
            question: 'deny',
            task: { '*': 'deny' },
            skill: 'deny',
            edit: {
              '*': 'deny',
              'ub-workspace/changes/udma-explore-test/exploration_notes.md': 'allow',
            },
          },
        },
      },
    })
    const read = (runtimeConfig.agent as Record<string, { permission: { read: Record<string, string> } }>)
      ['ub-leader']?.permission.read
    expect(read?.['*']).toBe('deny')
    expect(read?.['src/**']).toBe('allow')
    expect(read?.['other-module/**']).toBeUndefined()
    const snapshotReference = relative(
      realpathSync(h.repoPath),
      join(environment.OPENCODE_CONFIG_DIR!, 'references', 'udma'),
    ).replace(/\\/g, '/')
    expect(read?.[snapshotReference]).toBe('allow')
    expect(read?.[`${snapshotReference}/**`]).toBe('allow')
    const snapshotSkills = relative(
      realpathSync(h.repoPath),
      join(environment.OPENCODE_CONFIG_DIR!, 'skills'),
    ).replace(/\\/g, '/')
    expect(read?.[snapshotSkills]).toBeUndefined()
    expect(read?.[`${snapshotSkills}/**`]).toBeUndefined()
    expect(read?.[join(environment.OPENCODE_CONFIG_DIR!, 'references', 'udma')]).toBeUndefined()
    const leader = readFileSync(join(environment.OPENCODE_CONFIG_DIR!, 'agents', 'ub-leader.md'), 'utf8')
    expect(leader).toContain(`${environment.OPENCODE_CONFIG_DIR}/references/_shared/`)
    expect(leader).not.toContain('Read skills/ub-workflow/SKILL.md')
    expect(leader).not.toContain('permission:')
    expect(leader).toContain('mode: primary')
    const exploreProtocol = readFileSync(
      join(environment.OPENCODE_CONFIG_DIR!, 'skills', 'ub-workflow', 'SKILL.md'),
      'utf8',
    )
    expect(exploreProtocol).toContain('Protocol for ub-workflow')
    expect(readFileSync(
      join(environment.OPENCODE_CONFIG_DIR!, 'references', 'udma', '_manifest.yaml'),
      'utf8',
    )).toContain('module: udma')
    expect(h.calls.filter(call => call.path === '/session')).toHaveLength(1)
  })

  it('builds the snapshot from the workflow bundle while reading a frozen external source root', async () => {
    const h = harness()
    const workflowPath = fixtureRepo()
    const sourceCheckout = fixtureRepo()
    const externalSource = realpathSync(join(sourceCheckout, 'src'))
    expect(h.runner.start(startOptions(h.repoPath, {
      workflowPath,
      sourceRoots: [{ manifestPath: 'src', path: externalSource }],
    }))).toBe(true)
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))

    const config = JSON.parse(h.environment().OPENCODE_CONFIG_CONTENT ?? '{}') as {
      agent: Record<string, { permission: { read: Record<string, string>; external_directory: Record<string, string> } }>
    }
    const permission = config.agent['ub-leader']!.permission
    const relativeSource = relative(realpathSync(h.repoPath), externalSource).replace(/\\/g, '/')
    expect(permission.read[relativeSource]).toBe('allow')
    expect(permission.read[`${relativeSource}/**`]).toBe('allow')
    expect(permission.external_directory[externalSource]).toBe('allow')
  })

  it('rejects a frozen mapping whose portable roots differ from the snapshot manifest', async () => {
    const h = harness()
    const onExit = vi.fn()
    expect(h.runner.start(startOptions(h.repoPath, {
      sourceRoots: [{ manifestPath: 'other-root', path: realpathSync(join(h.repoPath, 'src')) }],
      onExit,
    }))).toBe(true)

    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(onExit).toHaveBeenCalledWith(-1, null)
    expect(h.children).toHaveLength(0)
  })

  it('blocks private and cross-session workspace reads in the runtime guard', async () => {
    const repoPath = fixtureRepo()
    const configDir = mkdtempSync(join(tmpdir(), 'dsh-guard-config-'))
    temporaryRoots.push(configDir)
    mkdirSync(join(configDir, 'skills', 'ub-workflow'), { recursive: true })
    mkdirSync(join(configDir, 'references', '_shared'), { recursive: true })
    mkdirSync(join(configDir, 'references', 'udma'), { recursive: true })
    mkdirSync(join(configDir, 'references', 'ummu'), { recursive: true })
    const current = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-test')
    const other = join(repoPath, 'ub-workspace', 'changes', 'another-session')
    const privateState = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    const mixedCaseState = join(repoPath, 'UB-WORKSPACE', '.DSH-UB-WORKFLOW')
    mkdirSync(join(repoPath, 'src'), { recursive: true })
    mkdirSync(join(repoPath, 'other-module'), { recursive: true })
    mkdirSync(current, { recursive: true })
    mkdirSync(other, { recursive: true })
    mkdirSync(privateState, { recursive: true })
    mkdirSync(mixedCaseState, { recursive: true })
    writeFileSync(join(repoPath, 'src', 'driver.c'), 'int driver;\n')
    if (process.platform !== 'win32') {
      writeFileSync(join(repoPath, '.gitignore'), 'src/ignored.pipe\n')
      expect(spawnSync('mkfifo', [join(repoPath, 'src', 'ignored.pipe')]).status).toBe(0)
    }
    writeFileSync(join(repoPath, 'other-module', 'private.conf'), 'cross-module\n')
    writeFileSync(join(configDir, 'references', 'udma', '_manifest.yaml'), 'module: udma\n')
    writeFileSync(join(configDir, 'references', 'ummu', '_manifest.yaml'), 'module: ummu\n')
    writeFileSync(join(configDir, 'skills', 'ub-workflow', 'SKILL.md'), '# forbidden workflow skill\n')
    writeFileSync(join(current, 'exploration_notes.md'), '# current\n')
    writeFileSync(join(other, 'exploration_notes.md'), '# another session\n')
    writeFileSync(join(privateState, 'runs.json'), '{"secret":"other-session"}\n')
    writeFileSync(join(mixedCaseState, 'runs.json'), '{"secret":"mixed-case"}\n')
    const pluginPath = join(configDir, 'guard.mjs')
    writeFileSync(pluginPath, runtimeGuardPluginSource(
      repoPath,
      configDir,
      'udma-explore-test',
      'udma',
      [
        { manifestPath: 'src', path: realpathSync(join(repoPath, 'src')) },
        { manifestPath: 'UB-WORKSPACE', path: realpathSync(join(repoPath, 'UB-WORKSPACE')) },
      ],
    ))
    const plugin = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`) as {
      DshWorkflowRuntimeGuard: () => Promise<Record<string, unknown>>
    }
    const hooks = await plugin.DshWorkflowRuntimeGuard()
    const before = hooks['tool.execute.before'] as (
      input: { tool: string },
      output: { args: Record<string, unknown> },
    ) => Promise<void>
    const shellEnvironment = hooks['shell.env'] as (
      input: unknown,
      output: { env: Record<string, string> },
    ) => Promise<void>

    await expect(before({ tool: 'read' }, { args: { filePath: join(repoPath, 'src', 'driver.c') } })).resolves.toBeUndefined()
    if (process.platform !== 'win32') {
      await expect(before({ tool: 'read' }, { args: { filePath: join(repoPath, 'src', 'ignored.pipe') } }))
        .rejects.toThrow(/regular file/i)
    }
    await expect(before({ tool: 'read' }, { args: { filePath: join(repoPath, 'other-module', 'private.conf') } }))
      .rejects.toThrow(/selected module|source root/i)
    await expect(before({ tool: 'read' }, { args: { filePath: join(configDir, 'references', 'udma', '_manifest.yaml') } }))
      .resolves.toBeUndefined()
    await expect(before({ tool: 'read' }, { args: { filePath: join(configDir, 'skills', 'ub-workflow', 'SKILL.md') } }))
      .rejects.toThrow(/selected module|source root/i)
    await expect(before({ tool: 'read' }, { args: { filePath: join(configDir, 'references', 'ummu', '_manifest.yaml') } }))
      .rejects.toThrow(/selected module|source root/i)
    await expect(before({ tool: 'read' }, { args: { filePath: join(current, 'exploration_notes.md') } })).resolves.toBeUndefined()
    await expect(before({ tool: 'read' }, { args: { filePath: join(other, 'exploration_notes.md') } })).rejects.toThrow('another workflow session')
    await expect(before({ tool: 'read' }, { args: { filePath: join(privateState, 'runs.json') } })).rejects.toThrow('private plugin state')
    await expect(before({ tool: 'read' }, { args: { filePath: join(mixedCaseState, 'runs.json') } })).rejects.toThrow('private plugin state')
    await expect(before({ tool: 'read' }, { args: { filePath: repoPath } })).rejects.toThrow('unfiltered repository listing')
    await expect(before({ tool: 'grep' }, { args: { pattern: 'secret' } })).rejects.toThrow('must select a source directory')
    await expect(before({ tool: 'write' }, { args: { filePath: join(current, 'exploration_notes.md') } })).resolves.toBeUndefined()
    await expect(before({ tool: 'write' }, { args: { filePath: join(repoPath, 'src', 'driver.c') } })).rejects.toThrow('only exploration_notes.md')
    await expect(before({ tool: 'apply_patch' }, { args: {
      patchText: '*** Begin Patch\n*** Move to: src/moved-note.c\n*** End Patch',
    } })).rejects.toThrow(/patch.*disabled|禁用/i)
    await expect(before({ tool: 'patch' }, { args: {} })).rejects.toThrow(/patch.*disabled|禁用/i)
    await expect(before({ tool: 'glob' }, { args: { path: join(repoPath, 'src'), pattern: '**/*' } })).resolves.toBeUndefined()
    await expect(before({ tool: 'edit' }, { args: { filePath: join(current, 'exploration_notes.md') } })).resolves.toBeUndefined()
    await expect(before({ tool: 'edit' }, { args: { filePath: join(repoPath, 'src', 'driver.c') } })).rejects.toThrow('only exploration_notes.md')
    const env = { OPENCODE_SERVER_PASSWORD: 'secret', OPENCODE_CONFIG_CONTENT: 'secret', SAFE_VALUE: 'kept' }
    await shellEnvironment({}, { env })
    expect(env).toEqual({ SAFE_VALUE: 'kept' })
  })

  it('waits for prompt acceptance after busy and idle events before reporting success', async () => {
    const h = harness({ deferPrompt: true })
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))
    h.event({ type: 'session.status', properties: { sessionID: 'ses_main', status: { type: 'busy' } } })
    h.event({ type: 'session.idle', properties: { sessionID: 'ses_main' } })
    await flush()
    expect(onExit).not.toHaveBeenCalled()
    h.resolvePrompt(new Response(null, { status: 204 }))
    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(onExit).toHaveBeenCalledWith(0, null)
  })

  it('does not reset reconnect exhaustion for rapid server.connected frames', async () => {
    const h = harness({ closingSse: true })
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(h.calls.filter(call => call.path === '/event').length).toBeGreaterThanOrEqual(4)
    expect(onExit).toHaveBeenCalledWith(-1, null)
  })

  it('recovers completion when reconnect loses the complete busy-to-idle event window', async () => {
    const h = harness({ missingSessionStatus: true, completedSessionMessages: true })
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path.endsWith('/prompt_async')))
    await flush()

    h.streams[0]!.close()
    await waitUntil(() => h.streams.length === 2)
    h.connect(1)
    await waitUntil(() => onExit.mock.calls.length > 0)

    expect(h.calls.some(call => call.path === '/session/ses_main/message')).toBe(true)
    expect(onExit).toHaveBeenCalledWith(0, null)
  })

  it('fails closed when an owned session asks a runtime question', async () => {
    const h = harness()
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))
    h.event({ type: 'question.asked', properties: { sessionID: 'ses_main', id: 'que_main', questions: [] } })
    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(onExit).toHaveBeenCalledWith(-1, null)
  })

  it('times out while consuming a response body that never ends', async () => {
    const h = harness({ hangingConfigBody: true, requestTimeoutMs: 25 })
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(onExit).toHaveBeenCalledWith(-1, null)
  })

  it('fails when the authenticated SSE stream stops producing heartbeats', async () => {
    const h = harness({ sseReadTimeoutMs: 15 })
    const onExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit }))
    h.announce()
    await waitUntil(() => onExit.mock.calls.length > 0)
    expect(h.streams.length).toBeGreaterThanOrEqual(4)
    expect(onExit).toHaveBeenCalledWith(-1, null)
  })

  it('reuses one frozen runtime per run and rejects source changes before the next segment', async () => {
    const h = harness()
    const firstExit = vi.fn()
    h.runner.start(startOptions(h.repoPath, { onExit: firstExit }))
    h.announce()
    await waitUntil(() => h.streams.length === 1)
    h.connect()
    await waitUntil(() => h.calls.some(call => call.path === '/session/ses_main/prompt_async'))
    h.event({ type: 'session.status', properties: { sessionID: 'ses_main', status: { type: 'busy' } } })
    h.event({ type: 'session.idle', properties: { sessionID: 'ses_main' } })
    await waitUntil(() => firstExit.mock.calls.length > 0)

    writeFileSync(join(h.repoPath, 'agents', 'ub-leader.md'), '# mutated\n')
    const secondExit = vi.fn()
    expect(h.runner.start(startOptions(h.repoPath, { sessionId: 'ses_main', onExit: secondExit }))).toBe(true)
    await waitUntil(() => secondExit.mock.calls.length > 0)
    expect(secondExit).toHaveBeenCalledWith(-1, null)
    expect(h.children).toHaveLength(1)
  })
})

const installedOpenCode = spawnSync('opencode', ['--version'], { encoding: 'utf8' })
const hasPinnedOpenCode = installedOpenCode.status === 0 && installedOpenCode.stdout.trim() === '1.18.3'

describe.runIf(hasPinnedOpenCode)('OpenCode 1.18.3 contract', () => {
  it('loads the sanitized agent with the effective Explore permissions', async () => {
    const repoPath = fixtureRepo()
    const isolatedData = mkdtempSync(join(tmpdir(), 'dsh-opencode-data-'))
    temporaryRoots.push(isolatedData)
    const previousData = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = isolatedData
    const logs: string[] = []
    const runner = new OpenCodeServerRunner({
      // Keep the production 15 s startup/request bounds. Model-catalog
      // refresh is disabled by the runner, so this probe must not consume the
      // former upstream 10 s network timeout before /agent becomes available.
      reconnectBaseMs: 20,
      sseReadTimeoutMs: 10_000,
    })
    liveRunners.push(runner)
    try {
      const options = startOptions(repoPath, {
        opencodeBin: 'opencode',
        onLogLine: line => { logs.push(line) },
      })
      const active = {
        generation: 1,
        options,
        ownedSessions: new Set<string>(),
        parents: new Map<string, string | undefined>(),
        promptAccepted: false,
        sawActivity: false,
        sawIdle: false,
      }
      const internals = runner as unknown as {
        active?: typeof active
        ensureServer: (value: typeof active) => Promise<unknown>
      }
      internals.active = active
      try {
        await Promise.race([
          internals.ensureServer(active),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('OpenCode contract probe timed out')), 20_000)
            timer.unref?.()
          }),
        ])
      } catch (error) {
        throw new Error([
          error instanceof Error ? error.message : String(error),
          ...logs,
        ].join('\n'), { cause: error })
      }
      runner.stop()
      await waitUntil(() => !runner.running, 7_000)
      expect(logs.join('\n')).not.toContain('permissions are not confined')
    } finally {
      if (previousData === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousData
    }
  }, 30_000)
})

describe.runIf(process.platform !== 'win32')('OpenCode supervisor', () => {
  it('reports the worker on fd 3 and kills a TERM-resistant process group after stdin closes', async () => {
    const workerSource = [
      "const {spawn}=require('node:child_process')",
      "const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
      "console.log('grandchild:'+grand.pid)",
      "process.on('SIGTERM',()=>{})",
      "setInterval(()=>{},1000)",
    ].join(';')
    const config = JSON.stringify({ cmd: process.execPath, args: ['-e', workerSource], cwd: process.cwd(), stopGraceMs: 50 })
    const supervisor = spawn(process.execPath, ['-e', SUPERVISOR_SOURCE, config], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let workerPid = ''
    supervisor.stdout.on('data', chunk => { output += String(chunk) })
    supervisor.stdio[3]?.on('data', chunk => { workerPid += String(chunk) })
    await waitUntil(() => /grandchild:\d+/.test(output) && /^\d+\n$/.test(workerPid), 2_000)
    supervisor.stdin.end()
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('supervisor did not close')), 2_000)
      supervisor.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    expect(result.code).toBe(0)
    expect(output).not.toContain('[dsh supervisor child]')
  })

  it('kills the detached worker when the supervisor exits unexpectedly', async () => {
    const workerSource = [
      "process.on('SIGTERM',()=>{})",
      "console.log('worker-ready')",
      'setInterval(()=>{},1000)',
    ].join(';')
    const config = JSON.stringify({ cmd: process.execPath, args: ['-e', workerSource], cwd: process.cwd(), stopGraceMs: 50 })
    const supervisor = spawn(process.execPath, ['-e', SUPERVISOR_SOURCE, config], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let workerText = ''
    supervisor.stdout.on('data', chunk => { output += String(chunk) })
    supervisor.stdio[3]?.on('data', chunk => { workerText += String(chunk) })
    let workerPid = 0
    const alive = (): boolean => {
      if (workerPid <= 0) return false
      try { process.kill(workerPid, 0); return true } catch { return false }
    }
    try {
      await waitUntil(() => output.includes('worker-ready') && /^\d+\n$/.test(workerText), 2_000)
      workerPid = Number(workerText.trim())
      expect(alive()).toBe(true)

      const runner = new OpenCodeServerRunner()
      const server = {
        child: supervisor,
        workerPid,
        workerReady: Promise.resolve(),
        resolveWorker: () => {},
        username: 'test',
        password: 'x'.repeat(32),
        pluginUrl: 'file:///test.js',
        configDir: process.cwd(),
        repoPath: process.cwd(),
        sourceRoots: [],
        ready: Promise.resolve(),
        reconnects: 0,
        closing: false,
      }
      const active = {
        generation: 1,
        options: { onLogLine: vi.fn(), onStopped: vi.fn(), onExit: vi.fn() },
        ownedSessions: new Set<string>(),
        parents: new Map<string, string | undefined>(),
        promptAccepted: false,
        sawActivity: false,
        sawIdle: false,
        server,
      }
      const internals = runner as unknown as {
        server?: typeof server
        active?: typeof active
        serverExited: (value: typeof server, code: number | null, signal: string | null) => void
      }
      internals.server = server
      internals.active = active

      const closed = new Promise<void>(resolve => { supervisor.once('close', () => { resolve() }) })
      supervisor.kill('SIGKILL')
      await closed
      internals.serverExited(server, null, 'SIGKILL')

      await waitUntil(() => !alive(), 2_000)
      expect(alive()).toBe(false)
    } finally {
      try { supervisor.kill('SIGKILL') } catch {}
      if (workerPid > 0) {
        try { process.kill(-workerPid, 'SIGKILL') } catch { try { process.kill(workerPid, 'SIGKILL') } catch {} }
      }
    }
  })
})
