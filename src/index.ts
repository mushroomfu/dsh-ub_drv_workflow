/**
 * Host loader entry for dsh-ub-workflow — runs in the DSH host process.
 * Owns the workflow store, the workflow engine (opencode runner + artifact
 * watcher), the loopback routes, and the settings section. The browser half
 * (src/client/*) renders the workflow view as a conversation tab.
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { parseWorkflowArgs } from './core/parseArgs.ts'
import { WorkflowEngine } from './engine.ts'
import { HarnessRunner } from './harness-runner.ts'
import { OpenCodeRunner } from './runner.ts'
import type { WorkflowRunner } from './runner.ts'
import { makeRoutes } from './routes.ts'
import { WorkflowStore } from './store.ts'

/** Required host services. */
export const inject = ['webServer', 'settings', 'commands']

/** Settings namespace of the workflow plugin. */
export const SETTINGS_NAMESPACE = settingsNamespace('ub-workflow')

const SECTION_ORDER = 320

const DEFAULT_REPO = 'D:\\ai_work\\ai_workspace\\ub-drv-develop\\ub-drv-develop'

export interface Config {
  enabled?: boolean
  repoPath?: string
  opencodeBin?: string
  pollMs?: number
  /** Execution backend: harness (in-process Agent) or opencode (legacy CLI). */
  runner?: 'harness' | 'opencode'
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  repoPath: z.string().default(DEFAULT_REPO),
  opencodeBin: z.string().default(''),
  pollMs: z.number().default(1500),
  runner: z.union([z.const('harness' as const), z.const('opencode' as const)]).default('harness'),
})

/**
 * Apply the host half.
 * @param ctx - plugin context carrying webServer/settings.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const composition: Config = config ?? {}

  let current: () => Config = () => composition
  const store: WorkflowStore = new WorkflowStore()
  let engine: WorkflowEngine | undefined
  let engineRunnerMode: 'harness' | 'opencode' | undefined

  const repoOf = (): string => {
    const repo = (current().repoPath ?? DEFAULT_REPO).trim()
    return repo === '' ? DEFAULT_REPO : repo
  }

  /** Best-effort extraction of the invoking conversation's workspace. */
  const sessionCwdOf = (agent: unknown): string | undefined => {
    const header = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  }

  /** All workspaces worth tracking: the configured repo + every live conversation cwd. */
  const knownWorkspaces = (): string[] => {
    const out = new Set<string>([repoOf()])
    try {
      const sessions = ctx.get('sessions') as unknown as { list?: () => Array<{ header?: { cwd?: unknown } }> } | undefined
      if (sessions !== undefined && typeof sessions.list === 'function') {
        for (const session of sessions.list()) {
          const cwd = session.header?.cwd
          if (typeof cwd === 'string' && cwd.trim() !== '') out.add(cwd)
        }
      }
    } catch {
      // Session enumeration is best-effort: the configured repo alone is enough
      // for a web-only profile.
    }
    return [...out]
  }

  const createRunner = (): WorkflowRunner => {
    const mode = current().runner ?? 'harness'
    if (mode === 'opencode') return new OpenCodeRunner()
    const harness = new HarnessRunner(ctx)
    if (!harness.hasServices) return new OpenCodeRunner()
    return harness
  }

  const ensureEngine = (): WorkflowEngine => {
    const desiredRunnerMode = current().runner ?? 'harness'
    if (engine === undefined || engineRunnerMode !== desiredRunnerMode) {
      if (engine !== undefined) {
        // Do not tear down a running engine just because settings changed.
        if (store.anyActiveForSession(repoOf())) return engine
        engine.dispose()
      }
      engineRunnerMode = desiredRunnerMode
      engine = new WorkflowEngine({
        repoPath: repoOf(),
        store,
        runner: createRunner(),
        opencodeBin: (current().opencodeBin ?? '').trim() || undefined,
        pollMs: current().pollMs ?? 1500,
      })
    }
    // Runs follow their own workspace (each slash-command run binds the invoking
    // conversation's cwd), so every workspace with persisted history or a live
    // conversation feeds the shared store.
    for (const workspace of knownWorkspaces()) store.loadRepo(workspace)
    if (current().enabled !== false) engine.startPolling()
    return engine
  }

  // Routes are always mounted; the loopback fence keeps them safe when the
  // web server is reachable beyond localhost.
  ctx.effect(() => {
    ensureEngine()
    const disposers = makeRoutes({
      repoPath: repoOf,
      store: () => store,
      // Ensuring on every route call refreshes the workspace set: sessions
      // resume asynchronously after boot, so a workspace that only becomes
      // live later must still be discovered and its runs loaded.
      engine: () => ensureEngine(),
    }).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'ub-workflow: routes')

  // Slash-command trigger: /ub-workflow <需求描述> starts the workflow from the
  // conversation composer instead of the standalone view.
  ctx.effect(() => {
    return ctx.commands.register({
      name: 'ub-workflow',
      description: '启动 UnifiedBus 内核驱动 AI 开发工作流（需求 → 设计 → 编码 → 测试 → 审查 → 归档）',
      input: { hint: '<需求描述>，可在开头加 --module/--mode/--stage design/--deploy/--change-id' },
      recordInput: true,
      handler: async ({ rawInput, agent }) => {
        const parsed = parseWorkflowArgs(rawInput)
        if (parsed.requirement === '') {
          return {
            kind: 'error',
            text: '用法：/ub-workflow <需求描述>。例如 /ub-workflow 帮 UDMA 新增 jetty 资源回收接口；'
              + '可用参数：--module ubase|cdma|udma|ummu|ubus，--mode dev|full|explore，'
              + '--stage design，--deploy，--change-id <slug>',
          }
        }

        const active = ensureEngine()

        // The workflow agent works inside the invoking conversation, so its
        // artifacts land under the SESSION's workspace — the run must track
        // that directory, not the plugin's configured default repo. Without a
        // session cwd (e.g. a web-only profile) fall back to the configured
        // repository.
        const hostSession = (agent as { session?: { id?: unknown } } | undefined)?.session
        const sessionCwd = sessionCwdOf(agent)
        const runRepo = sessionCwd !== undefined && existsSync(sessionCwd) ? sessionCwd : repoOf()
        store.loadRepo(runRepo)

        const run = active.createRun({
          repoPath: runRepo,
          sessionId: typeof hostSession?.id === 'string' ? hostSession.id : undefined,
          requirement: parsed.requirement,
          module: parsed.module,
          mode: parsed.mode,
          designOnly: parsed.designOnly,
          deploy: parsed.deploy,
          changeId: parsed.changeId,
        })

        // Run the workflow as an ordinary turn in the invoking conversation,
        // so the dialogue is preserved in the original chat. The plugin tab
        // only renders process/stage state.
        const launched = await active.launch(run, agent as unknown)
        if (!launched) {
          return {
            kind: 'error',
            text: '启动失败：该仓库已有进行中的工作流运行，或执行引擎无法启动（Harness 模式请确认默认模型已配置）。',
          }
        }

        return {
          kind: 'success',
          text: `UB 工作流已启动（change-id: ${run.changeId}，阶段链: ${run.designOnly ? 'design-only' : run.mode}）。`
            + '工作流执行对话会保留在当前会话中；点击对话右侧的 “UB 工作流” 悬浮按钮可查看阶段卡片与硬门禁。',
        }
      },
    })
  }, 'ub-workflow: slash command')

  const sync = (): void => {
    const active = ensureEngine()
    if (current().enabled === false) {
      active.stopPolling()
      active.stopActiveProcess()
    } else {
      active.startPolling()
    }
  }

  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, composition, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  ctx.effect(() => () => { engine?.dispose() }, 'ub-workflow: lifecycle')

  sync()
}