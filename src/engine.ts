/**
 * WorkflowEngine wires the pure state machine to the store, the opencode
 * runner, and the artifact watcher. It is the host-side conductor:
 * launch → segment 0 (to design-gate) → user confirm → segment 1/2
 * (continue through closeout), with artifact evidence as the only source of
 * "done".
 */

import { applyArtifactEvidence } from './core/artifacts.ts'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'
import { buildStageChain, STEP_META } from './core/stages.ts'
import { attachFailure, markStepStatus, walkChain } from './core/stateMachine.ts'
import type { RunInput, RunMode, StepId, WorkflowRun } from './core/types.ts'
import { findLatestChangeId, listChangeFiles, resolveChangeId } from './artifact-watcher.ts'
import { OpenCodeRunner } from './runner.ts'
import { WorkflowStore } from './store.ts'

export interface EngineOptions {
  repoPath: string
  store: WorkflowStore
  runner: OpenCodeRunner
  opencodeBin?: string
  pollMs?: number
  logTailLimit?: number
  onLog?: (line: string) => void
}

const SEGMENT_TITLES = ['routing-to-design-gate', 'develop-to-closeout', 'post-deploy-closeout'] as const

export class WorkflowEngine {
  private readonly repoPath: string
  private readonly store: WorkflowStore
  private readonly runner: OpenCodeRunner
  private readonly opencodeBin?: string
  private readonly pollMs: number
  private readonly logTailLimit: number
  private readonly onLog?: (line: string) => void
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: EngineOptions) {
    this.repoPath = options.repoPath
    this.store = options.store
    this.runner = options.runner
    this.opencodeBin = options.opencodeBin
    this.pollMs = options.pollMs ?? 1500
    this.logTailLimit = options.logTailLimit ?? 80
    this.onLog = options.onLog
  }

  /** The repo this engine instance was created for. */
  get currentRepoPath(): string {
    return this.repoPath
  }

  stopActiveProcess(): void {
    this.runner.stop()
  }

  startPolling(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { this.tick() }, this.pollMs)
    this.timer.unref?.()
  }

  stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.stopPolling()
    this.runner.stop()
  }

  /** Create a run from user input (does not spawn). */
  createRun(input: RunInput): WorkflowRun {
    const now = new Date().toISOString()
    const mode: RunMode = input.mode
    const designOnly = input.designOnly === true
    const deploy = input.deploy === true
    const runId = input.runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const changeId = input.changeId ?? this.defaultChangeId(input.module, input.requirement)
    const steps = buildStageChain({ mode, designOnly, deploy })

    const run: WorkflowRun = {
      runId,
      repoPath: input.repoPath || this.repoPath,
      sessionId: input.sessionId,
      changeId,
      module: input.module,
      mode,
      designOnly,
      deploy,
      requirement: input.requirement,
      status: 'idle',
      steps,
      segment: 0,
      createdAt: now,
      updatedAt: now,
      logTail: [],
    }

    this.store.put(run)
    this.store.persist(run.repoPath)
    return run
  }

  /** Launch a run: routing plan is considered confirmed by the launch form. */
  launch(run: WorkflowRun): boolean {
    if (this.store.anyActive(run.repoPath, run.runId)) return false
    const now = new Date().toISOString()
    run.status = 'running'
    run.startedAt = now
    run.updatedAt = now
    run.segment = 0
    markStepStatus(run.steps, 'routing-plan', 'done', now, '启动表单已确认流程计划')
    const spawn = this.startSegment(run, 0)
    if (!spawn) {
      run.status = 'failed'
      run.error = 'opencode 启动失败'
      this.store.persist(run.repoPath)
      return false
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    this.startPolling()
    return true
  }

  /** Stop a run and kill the underlying process. */
  stopRun(runId: string): boolean {
    const run = this.store.get(runId)
    if (run === undefined) return false
    this.runner.stop()
    run.status = 'stopped'
    run.updatedAt = new Date().toISOString()
    run.exitCode = null
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting_user') {
        step.status = 'skipped'
      }
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    return true
  }

  /** Confirm or cancel a waiting user gate. */
  resolveGate(runId: string, stepId: StepId, action: 'confirm' | 'cancel'): boolean {
    const run = this.store.get(runId)
    if (run === undefined) return false
    const step = run.steps.find(s => s.id === stepId)
    if (step === undefined || step.gate === undefined) return false

    const now = new Date().toISOString()

    if (action === 'cancel') {
      this.runner.stop()
      markStepStatus(run.steps, stepId, 'failed', now, '用户取消')
      run.status = 'stopped'
      run.updatedAt = now
      this.store.put(run)
      this.store.persist(run.repoPath)
      return true
    }

    if (step.status !== 'waiting_user') return false

    markStepStatus(run.steps, stepId, 'done', now, '用户已确认')

    // Terminal gate of a design-only run: no continuation segment exists.
    if (run.designOnly && stepId === 'design-gate') {
      run.status = 'done'
      run.finishedAt = now
      run.updatedAt = now
      this.runner.stop()
      this.store.put(run)
      this.store.persist(run.repoPath)
      return true
    }

    const nextSegment = stepId === 'design-gate' ? 1 : stepId === 'deploy-ok' ? 2 : run.segment
    run.segment = nextSegment as 0 | 1 | 2
    run.status = 'running'
    run.updatedAt = now
    this.runner.stop()

    const spawn = this.startSegment(run, nextSegment as 0 | 1 | 2)
    if (!spawn) {
      run.status = 'failed'
      run.error = 'opencode 续跑启动失败'
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    return true
  }

  /** Poll artifacts and advance the chain. Called on an interval and after events. */
  tick(): void {
    const run = this.store.findActive(this.repoPath)
    if (run === undefined || run.status === 'idle' || run.status === 'done' || run.status === 'stopped') return
    if (run.status === 'running' || run.status === 'waiting_user') {
      this.reconcile(run)
    }
  }

  private reconcile(run: WorkflowRun): void {
    const now = new Date().toISOString()
    const resolvedChangeId = resolveChangeId(run.repoPath, run.changeId)
    if (resolvedChangeId !== undefined && run.changeId !== resolvedChangeId) {
      run.changeId = resolvedChangeId
    }

    if (resolvedChangeId !== undefined) {
      const files = listChangeFiles(run.repoPath, resolvedChangeId)
      const changed = applyArtifactEvidence(run.steps, files, now)
      if (changed) this.persist(run)
    }

    const confirmedGates = new Set<StepId>(
      run.steps.filter(s => s.gate !== undefined && s.status === 'done').map(s => s.id),
    )
    const outcome = walkChain(run.steps, { designOnly: run.designOnly, confirmedGates, now })

    if (outcome.stoppedOnGate !== undefined) {
      run.status = 'waiting_user'
      // Keep the non-interactive process from lingering while the UI waits for
      // the user: opencode has already persisted the session at this point.
      if (this.runner.running) this.runner.stop()
      this.persist(run)
      return
    }

    if (outcome.stoppedOnDone === true) {
      if (!this.runner.running) {
        run.status = 'done'
        run.finishedAt = run.finishedAt ?? now
        run.exitCode = run.exitCode ?? 0
        this.persist(run)
      } else {
        // Chain complete but process still finishing. Keep running until exit.
        this.persist(run)
      }
      return
    }

    if (run.status === 'waiting_user') run.status = 'running'
    this.persist(run)
  }

  /** Forward a parsed opencode event into the run log and current step notes. */
  onEvent(runId: string, event: ParsedOpencodeEvent): void {
    const run = this.store.get(runId)
    if (run === undefined) return
    if (event.sessionId !== undefined && run.runId !== event.sessionId && event.sessionId.includes('ses')) {
      // informational only; the plugin's own session id is authoritative
    }
    const text = event.toolName !== undefined
      ? `tool:${event.toolName}${event.text !== undefined ? ` ${event.text}` : ''}`
      : event.text
    if (text !== undefined && text !== '') {
      this.pushLog(run, text.slice(0, 400))
      const active = run.steps.find(s => s.status === 'running')
      if (active !== undefined) active.note = text.slice(0, 400)
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    this.tick()
  }

  onExit(runId: string, code: number | null, signal: string | null): void {
    const run = this.store.get(runId)
    if (run === undefined) return
    run.exitCode = code
    run.updatedAt = new Date().toISOString()
    this.pushLog(run, `[opencode exited] code=${code} signal=${signal}`)

    this.reconcile(run)

    if (run.status === 'running' || run.status === 'waiting_user') {
      // Process ended before the chain did. If the next barrier is a gate we
      // are already waiting on, leave it waiting; otherwise attribute failure
      // to the current step.
      const nextWaiting = run.steps.find(s => s.status === 'waiting_user')
      if (nextWaiting === undefined && !run.designOnly) {
        const failed = attachFailure(run.steps, `opencode 进程退出 (code=${code})`)
        run.status = failed === undefined ? 'done' : 'failed'
        run.error = `opencode 进程非正常退出 (code=${code})`
      } else if (nextWaiting === undefined && run.designOnly) {
        // design-only naturally ends after the design gate is confirmed; treat
        // an exited process with only the terminal gate remaining as done.
        const gate = run.steps.find(s => s.id === 'design-gate')
        if (gate?.status === 'done') {
          run.status = 'done'
          run.finishedAt = run.finishedAt ?? new Date().toISOString()
        }
      }
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
  }

  private startSegment(run: WorkflowRun, segment: 0 | 1 | 2): boolean {
    return this.runner.start({
      repoPath: run.repoPath,
      sessionId: run.runId,
      title: `dsh-ub-workflow:${run.module ?? ''}:${SEGMENT_TITLES[segment]}:${run.runId.slice(0, 8)}`,
      prompt: this.buildPrompt(run, segment),
      opencodeBin: this.opencodeBin,
      onEvent: event => { this.onEvent(run.runId, event) },
      onExit: (code, signal) => { this.onExit(run.runId, code, signal) },
      onLogLine: line => {
        const active = this.store.findActive(run.repoPath)
        if (active !== undefined && active.runId === run.runId) this.pushLog(active, line)
      },
    })
  }

  private buildPrompt(run: WorkflowRun, segment: 0 | 1 | 2): string {
    const params: string[] = []
    if (run.module !== undefined && run.module !== '') params.push(`--module ${run.module}`)
    if (run.designOnly) params.push('--stage design')
    else params.push(`--mode ${run.mode}`)
    if (run.changeId !== undefined && run.changeId !== '') params.push(`--change-id ${run.changeId}`)
    if (run.deploy) params.push('--deploy')

    if (segment === 0) {
      return [
        params.join(' '),
        run.requirement,
        '',
        '[dsh-ub-workflow 控制台指令（优先级高于默认流程）]',
        '用户已在控制台启动表单中确认 0d 流程计划。请直接从 0e 建立 workspace 开始执行，',
        'dispatch 至 design-gate 后停下等待用户确认，不要进入 develop。',
      ].filter(line => line !== '').join('\n')
    }

    if (segment === 1) {
      const stopAtDeploy = run.mode === 'full' && run.deploy
        ? '执行 verify 阶段后，在 deploy-ok 门禁停下等待用户确认，不要继续 STC/closeout。'
        : '继续执行后续全部阶段：develop → test → review →（full 模式含 verify）→ closeout。'
      return [
        '用户已在控制台确认 design-gate 通过。',
        stopAtDeploy,
        '无需再次询问 design-gate；其余自动门禁按 workflow-gates.md 自动推进即可。',
      ].join('\n')
    }

    return [
      '用户已在控制台确认 deploy-ok 通过。',
      '请继续执行 STC 验证与 closeout，直至工作流结束。',
    ].join('\n')
  }

  private defaultChangeId(module: string | undefined, requirement: string): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const slug = requirement
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 4)
      .join('-')
    const mod = module ?? 'auto'
    return `${mod}-${slug || 'change'}-${date}`.slice(0, 80)
  }

  private pushLog(run: WorkflowRun, line: string): void {
    run.logTail.push(line)
    if (run.logTail.length > this.logTailLimit) run.logTail.splice(0, run.logTail.length - this.logTailLimit)
    this.onLog?.(line)
  }

  private persist(run: WorkflowRun): void {
    run.updatedAt = new Date().toISOString()
    this.store.put(run)
    this.store.persist(run.repoPath)
  }
}