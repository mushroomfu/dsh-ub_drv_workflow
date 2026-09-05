/**
 * Host loader entry for dsh-ub-workflow — runs in the DSH host process.
 * Owns the workflow store, the workflow engine (opencode runner + artifact
 * watcher), the loopback Connection RPC, and the settings section. The browser half
 * (src/client/*) renders the workflow view as a conversation tab.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { parseWorkflowArgs } from './core/parseArgs.ts'
import { MAX_REQUIREMENT_LENGTH, validateLaunchBody } from './core/inputValidation.ts'
import { normalizePollMs } from './core/timing.ts'
import { WorkflowEngine } from './engine.ts'
import { OpenCodeServerRunner } from './serverRunner.ts'
import { makeWorkflowRpcHandler } from './rpc.ts'
import { WorkflowStore } from './store.ts'

/** Required host services. */
export const inject = ['connection', 'settings', 'commands']

/** Settings namespace of the workflow plugin. */
export const SETTINGS_NAMESPACE = settingsNamespace('ub-workflow')

const SECTION_ORDER = 320

const DEFAULT_WORKFLOW = 'D:\\ai_work\\ai_workspace\\ub-drv-develop\\ub-drv-develop'
const DEFAULT_WORKSPACE = 'D:\\ai_work\\ai_workspace'
const DEFAULT_SOURCE = 'D:\\ai_work\\ai_workspace'

export interface Config {
  enabled?: boolean
  workflowPath?: string
  workspacePath?: string
  sourcePath?: string
  sourceRootOverrides?: Record<string, string>
  opencodeBin?: string
  pollMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  workflowPath: z.string().default(DEFAULT_WORKFLOW),
  workspacePath: z.string().default(DEFAULT_WORKSPACE),
  sourcePath: z.string().default(DEFAULT_SOURCE),
  sourceRootOverrides: z.dict(z.string()).default({}),
  opencodeBin: z.string().default(''),
  pollMs: z.number().default(1500),
})

/**
 * Apply the host half.
 * @param ctx - plugin context carrying Connection, settings, and commands.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const composition: Config = config ?? {}

  let current: () => Config = () => composition
  let store: WorkflowStore = new WorkflowStore()
  let runner: OpenCodeServerRunner = new OpenCodeServerRunner()
  let engine: WorkflowEngine | undefined
  let engineSignature = ''

  const configuredPath = (value: string | undefined, fallback: string): string => {
    const path = (value ?? fallback).trim()
    return path === '' ? fallback : path
  }
  const workspaceOf = (): string => configuredPath(current().workspacePath, DEFAULT_WORKSPACE)
  const workflowOf = (): string => configuredPath(current().workflowPath, DEFAULT_WORKFLOW)
  const sourceOf = (): string => configuredPath(current().sourcePath, DEFAULT_SOURCE)

  const ensureEngine = (): WorkflowEngine => {
    const repo = workspaceOf()
    const workflowPath = workflowOf()
    const sourcePath = sourceOf()
    const sourceRootOverrides = { ...(current().sourceRootOverrides ?? {}) }
    const bin = (current().opencodeBin ?? '').trim()
    const pollMs = normalizePollMs(current().pollMs)
    const signature = JSON.stringify([repo, workflowPath, sourcePath, sourceRootOverrides, bin, pollMs])
    if (engine !== undefined && engineSignature === signature) return engine

    if (engine !== undefined) {
      // Do not tear down a running engine just because settings changed.
      if (store.anyActive(engine.currentRepoPath)) return engine
      engine.dispose()
    }

    store.loadRepo(repo)
    runner = new OpenCodeServerRunner()
    engine = new WorkflowEngine({
      repoPath: repo,
      workflowPath,
      sourcePath,
      sourceRootOverrides,
      store,
      runner,
      opencodeBin: (current().opencodeBin ?? '').trim() || undefined,
      pollMs,
    })
    engineSignature = signature
    if (current().enabled !== false) engine.startPolling()
    return engine
  }

  // DSH Connection owns the physical carrier and its Host/Origin trust fence.
  // `loopback` keeps process-control methods local in served-web mode while
  // also working through the Desktop `file://` IPC transport hook.
  ensureEngine()
  ctx.effect(() => {
    const disposeRpc = ctx.connection.rpc.handle('/ub-workflow', makeWorkflowRpcHandler({
      repoPath: () => ensureEngine().currentRepoPath,
      store: () => store,
      engine: ensureEngine,
      enabled: () => current().enabled !== false,
    }), { authority: 'loopback' })
    return () => { void disposeRpc() }
  }, 'ub-workflow: connection rpc')

  // Slash-command trigger: /ub-workflow <需求描述> starts the workflow from the
  // existing conversation composer; progress stays in the contributed view tab.
  ctx.effect(() => {
    return ctx.commands.register({
      name: 'ub-workflow',
      description: '启动 UnifiedBus 内核驱动只读探索工作流，并在当前 DSH 会话中查看进度',
      input: { hint: '--mode explore --module <id> [--change-id <slug>] <探索目标>' },
      recordInput: true,
      handler: async ({ rawInput, agent }) => {
        if (current().enabled === false) {
          return { kind: 'error', text: 'UB 工作流插件当前已禁用，请先在设置中启用。' }
        }
        const parsed = parseWorkflowArgs(rawInput)
        if (parsed.requirement === '') {
          return {
            kind: 'error',
            text: '用法：/ub-workflow --mode explore --module <ubase|cdma|udma|ummu|ubus> '
              + '[--change-id <slug>] <探索目标>',
          }
        }
        if (parsed.module === undefined) {
          return { kind: 'error', text: '启动前必须用 --module 明确选择 ubase、cdma、udma、ummu 或 ubus。' }
        }
        if (parsed.mode !== 'explore' || parsed.designOnly || parsed.deploy) {
          return {
            kind: 'error',
            text: '当前可靠发布范围仅开放 --mode explore。上游设计、UT 与部署协议包含运行时 question，'
              + '宿主尚未提供可审计的原位问题/权限代理，因此 dev、--stage design 与 live deployment 均拒绝启动。',
          }
        }

        const active = ensureEngine()
        if (active.currentRepoPath !== workspaceOf()) {
          return { kind: 'error', text: '工作流引擎已绑定其他 workspace，请先在设置中调整工作区根目录或重启插件。' }
        }
        if (store.anyActive(active.currentRepoPath)) {
          return { kind: 'error', text: '启动失败：该工作区已有进行中的工作流运行。' }
        }
        if (active.processBusy) {
          return { kind: 'error', text: '上一工作流进程仍在退出，请稍后重试。' }
        }

        const validated = validateLaunchBody({
          repoPath: active.currentRepoPath,
          sessionId: agent.id,
          requirement: parsed.requirement,
          module: parsed.module,
          mode: parsed.mode,
          designOnly: parsed.designOnly,
          deploy: parsed.deploy,
          changeId: parsed.changeId,
        }, active.currentRepoPath)
        if (!validated.ok) {
          return {
            kind: 'error',
            text: validated.status === 413
              ? `启动失败：探索目标不能超过 ${MAX_REQUIREMENT_LENGTH.toLocaleString()} 个字符。`
              : `启动参数无效：${validated.error}`,
          }
        }

        const run = active.createRun(validated.value)

        if (!active.launch(run)) {
          return { kind: 'error', text: '启动失败：该工作区已有进行中的工作流运行，或 opencode 无法启动。' }
        }

        return {
          kind: 'success',
          text: `UB 只读探索计划已生成（module: ${run.module}，change-id: ${run.changeId}）。`
            + '请点击会话上方 “UB 工作流” 标签页审阅具体 workspace 与阶段链，并确认“路由与流程计划”门禁后启动。',
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
