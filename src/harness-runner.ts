/**
 * HarnessRunner — in-process DeepSeek Harness execution backend.
 *
 * Instead of spawning an external `opencode` child, this backend creates a
 * Harness Session and Agent through `ctx.agents.create()` (the same API the
 * official `dsh-headless` runner uses) and drives the UB workflow as ordinary
 * user-message turns. Live progress is read from the agent's session event
 * log; each `whenIdle()` boundary is reported through the shared
 * `onExit(0, null)` callback so the existing engine reconciles the state
 * machine exactly like it does for opencode.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'
import type { WorkflowRunner, WorkflowRunnerStart } from './runner.ts'

interface AgentFacade {
  session: {
    id: string
    events: Array<Record<string, unknown>>
  }
  whenIdle(): Promise<void>
  followup(message: unknown): void
  /** Abort the active turn (DSH Agent.cancel). No-op when the agent is idle. */
  cancel?(cause: { kind: 'user' }): void
}

interface AgentHandle {
  agent: AgentFacade
  dispose(): Promise<void>
}

interface AgentServices {
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: Record<string, unknown>
  }): Promise<AgentHandle>
}

interface AgentDefaultModelService {
  currentSelection(): {
    provider?: string
    model?: string
    reasoningEffort?: string
  }
}

interface SessionService {
  flush?(session: AgentFacade['session']): Promise<void>
}

/** Minimal service surface resolved from the plugin root context. */
export interface HarnessServices {
  agents: AgentServices
  agentDefaultModel: AgentDefaultModelService
  sessions?: SessionService
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toText(event: Record<string, unknown>): string | null {
  const raw = event?.data
  if (isRecord(raw)) {
    if (isRecord(raw.message)) {
      const content = raw.message.content
      if (Array.isArray(content)) {
        const texts = content
          .filter((block): block is Record<string, unknown> => isRecord(block))
          .map(block => (typeof block.text === 'string' ? block.text : ''))
          .filter(text => text !== '')
        if (texts.length > 0) return texts.join('\n').slice(0, 1200)
      }
    }
    if (typeof raw.text === 'string' && raw.text !== '') return raw.text.slice(0, 1200)
    if (typeof raw.summary === 'string' && raw.summary !== '') return raw.summary.slice(0, 1200)
  }
  return null
}

/** Convert a Harness session event into the coarse opencode-shaped event object. */
export function harnessEventToParsed(event: Record<string, unknown>): ParsedOpencodeEvent {
  // Reuse the tolerant JSON-line parser for field extraction. It never throws.
  const parsed = parseOpencodeLine(JSON.stringify(event))
  if (parsed !== null) {
    const text = toText(event)
    return {
      type: parsed.type ?? event.type as string | undefined,
      subtype: parsed.subtype,
      sessionId: parsed.sessionId ?? (isRecord(event) && typeof event.seq === 'number' ? undefined : parsed.sessionId),
      toolName: parsed.toolName,
      text: text ?? parsed.text,
      raw: event,
    }
  }
  return { raw: event }
}

function userMessage(text: string): Record<string, unknown> {
  return {
    id: `user-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Resolve Harness services from the plugin root context. Returns undefined
 * when the profile lacks the core dsh-base services (web-only deployment).
 */
export function resolveHarnessServices(ctx: Context): HarnessServices | undefined {
  const agents = ctx.get('agents') as unknown
  const agentDefaultModel = ctx.get('agentDefaultModel') as unknown
  if (agents === undefined || agentDefaultModel === undefined) return undefined
  const sessions = ctx.get('sessions') as unknown
  return {
    agents: agents as AgentServices,
    agentDefaultModel: agentDefaultModel as AgentDefaultModelService,
    ...(sessions !== undefined ? { sessions: sessions as SessionService } : {}),
  }
}

/** In-process Harness Agent execution backend. */
export class HarnessRunner implements WorkflowRunner {
  readonly kind = 'harness' as const

  private handle: AgentHandle | null = null
  private sessionId: string | null = null
  private active = false
  private lastSeq = 0
  private readonly services: HarnessServices | undefined

  constructor(ctx: Context) {
    this.services = resolveHarnessServices(ctx)
  }

  get running(): boolean {
    return this.active
  }

  get hasServices(): boolean {
    return this.services !== undefined
  }

  get hasSession(): boolean {
    return this.handle !== null
  }

  async start(options: WorkflowRunnerStart): Promise<boolean> {
    if (this.running) return false

    // `/ub-workflow` in a live conversation passes the receiving agent: the
    // workflow then runs as an ordinary turn in the original dialog, keeping
    // every user/model/tool interaction in the conversation history.
    if (options.hostAgent !== undefined && options.hostAgent !== null) {
      const host = options.hostAgent as AgentFacade
      this.handle = { agent: host, dispose: async () => {} }
      this.sessionId = host.session.id
      this.lastSeq = host.session.events.length
      return await this.followup(options)
    }

    // Second and later segments continue the same Harness session. The engine
    // only calls start again after the agent has idled at a gate.
    if (this.handle !== null) return await this.followup(options)

    const services = this.services
    if (services === undefined) {
      options.onLogLine?.('[harness] profile 未提供 agents/agentDefaultModel 服务，无法使用 Harness 执行引擎')
      return false
    }

    const selection = services.agentDefaultModel.currentSelection()
    const provider = selection.provider ?? ''
    const model = selection.model ?? ''
    if (provider === '' || model === '') {
      options.onLogLine?.('[harness] 当前 DSH 默认模型未配置（provider/model 为空）')
      return false
    }

    const sessionId = `session-ub-${options.sessionId}`

    let handle: AgentHandle
    try {
      handle = await services.agents.create({
        sessionId,
        meta: { cwd: options.repoPath },
        agentOptions: {
          provider,
          model,
          ...(selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
            ? { reasoningEffort: selection.reasoningEffort }
            : {}),
        },
      })
      await handle.agent.whenIdle()
    } catch (error) {
      options.onLogLine?.(`[harness] agents.create 失败: ${asError(error)}`)
      return false
    }

    this.handle = handle
    this.sessionId = sessionId
    this.lastSeq = handle.agent.session.events.length

    return await this.followup(options)
  }

  private async followup(options: WorkflowRunnerStart): Promise<boolean> {
    const handle = this.handle
    if (handle === null) return false

    try {
      await handle.agent.whenIdle()
      this.lastSeq = handle.agent.session.events.length
      handle.agent.followup(userMessage(options.prompt))
    } catch (error) {
      options.onLogLine?.(`[harness] followup 失败: ${asError(error)}`)
      return false
    }

    this.active = true
    void this.driveToIdle(handle, options)
    return true
  }

  private driveToIdle(handle: AgentHandle, options: WorkflowRunnerStart): void {
    const run = async (): Promise<void> => {
      const interval = setInterval(() => {
        this.flushEvents(handle, options)
      }, 1000)

      let failed = false
      let failure = ''
      try {
        await handle.agent.whenIdle()
      } catch (error) {
        failed = true
        failure = asError(error)
      }

      clearInterval(interval)
      this.flushEvents(handle, options)
      this.active = false

      if (failed) {
        options.onLogLine?.(`[harness] agent turn 运行失败: ${failure}`)
        options.onExit?.(-1, null)
        return
      }

      try {
        await this.services?.sessions?.flush?.(handle.agent.session)
      } catch {
        // Flush is best-effort; the session is already durable through the
        // normal session persistence backend.
      }

      options.onLogLine?.('[harness] agent turn idle')
      options.onExit?.(0, null)
    }

    void run()
  }

  private flushEvents(handle: AgentHandle, options: WorkflowRunnerStart): void {
    const events = handle.agent.session.events
    if (this.lastSeq >= events.length) return

    const fresh = events.slice(this.lastSeq)
    this.lastSeq = events.length

    for (const event of fresh) {
      const parsed = harnessEventToParsed(event)
      const type = parsed.type ?? String(event.type ?? 'session/event')
      if (type === 'raw') continue
      options.onLogLine?.(`[harness:${type}] ${parsed.text ?? parsed.toolName ?? ''}`.trim())
      options.onEvent?.(parsed)
    }
  }

  async whenIdle(): Promise<void> {
    const handle = this.handle
    if (handle === null) return
    try {
      await handle.agent.whenIdle()
    } catch {
      // The drive loop owns error reporting; whenIdle here is only used by the
      // gate resolver to avoid racing a still-running turn.
    }
  }

  async stop(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.sessionId = null
    this.active = false
    if (handle !== null) {
      // Cancel the in-flight agent turn FIRST: for a host-agent handle
      // dispose() is a no-op, so without cancel() the conversation agent
      // keeps executing while the run is already marked stopped (observed as
      // "drawer says stopped but the chat keeps running"). cancel() is a
      // no-op when the agent is idle (gate wait), so it is always safe.
      const agent = handle.agent
      if (typeof agent.cancel === 'function') {
        try {
          agent.cancel({ kind: 'user' })
          await Promise.race([
            handle.agent.whenIdle().catch(() => {}),
            new Promise(resolve => { setTimeout(resolve, 5000) }),
          ])
        } catch {
          // best-effort: the drive loop owns error reporting
        }
      }
      try {
        await handle.dispose()
      } catch {
        // Best-effort disposal; the session stays persisted and can be resumed.
      }
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
  }
}