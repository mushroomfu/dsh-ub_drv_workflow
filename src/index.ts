/**
 * Host loader entry for dsh-ub-workflow — runs in the DSH host process.
 * Owns the workflow store, the workflow engine (opencode runner + artifact
 * watcher), the loopback routes, and the settings section. The browser half
 * (src/client/*) renders the workflow view as a conversation tab.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { parseWorkflowArgs } from './core/parseArgs.ts'
import { WorkflowEngine } from './engine.ts'
import { OpenCodeRunner } from './runner.ts'
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
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  repoPath: z.string().default(DEFAULT_REPO),
  opencodeBin: z.string().default(''),
  pollMs: z.number().default(1500),
})

/**
 * Apply the host half.
 * @param ctx - plugin context carrying webServer/settings.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const composition: Config = config ?? {}

  let current: () => Config = () => composition
  let store: WorkflowStore = new WorkflowStore()
  let runner: OpenCodeRunner = new OpenCodeRunner()
  let engine: WorkflowEngine | undefined

  const repoOf = (): string => {
    const repo = (current().repoPath ?? DEFAULT_REPO).trim()
    return repo === '' ? DEFAULT_REPO : repo
  }

  const ensureEngine = (): WorkflowEngine => {
    const repo = repoOf()
    if (engine !== undefined && engine.currentRepoPath === repo) return engine

    if (engine !== undefined) {
      // Do not tear down a running engine just because settings changed.
      if (store.anyActive(engine.currentRepoPath)) return engine
      engine.dispose()
    }

    store.loadRepo(repo)
    runner = new OpenCodeRunner()
    engine = new WorkflowEngine({
      repoPath: repo,
      store,
      runner,
      opencodeBin: (current().opencodeBin ?? '').trim() || undefined,
      pollMs: current().pollMs ?? 1500,
    })
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
      engine: () => engine as WorkflowEngine,
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
      handler: async ({ rawInput }) => {
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
        if (active.currentRepoPath !== repoOf()) {
          return { kind: 'error', text: '工作流引擎已绑定其他仓库，请先在设置中调整仓库路径或重启插件。' }
        }

        const run = active.createRun({
          repoPath: active.currentRepoPath,
          requirement: parsed.requirement,
          module: parsed.module,
          mode: parsed.mode,
          designOnly: parsed.designOnly,
          deploy: parsed.deploy,
          changeId: parsed.changeId,
        })

        if (!active.launch(run)) {
          return { kind: 'error', text: '启动失败：该仓库已有进行中的工作流运行，或 opencode 无法启动。' }
        }

        return {
          kind: 'success',
          text: `UB 工作流已启动（change-id: ${run.changeId}，阶段链: ${run.designOnly ? 'design-only' : run.mode}）。`
            + '点击会话上方 “UB 工作流” 标签页可实时查看每一步进展与需要确认的硬门禁。',
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