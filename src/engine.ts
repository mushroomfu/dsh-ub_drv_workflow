/**
 * WorkflowEngine wires the pure state machine to the store, the opencode
 * runner, and the artifact watcher. It is the host-side conductor:
 * launch → segment 0 (to design-gate) → user confirm → segment 1/2
 * (continue through closeout), with artifact evidence as the only source of
 * "done".
 */

import { join } from 'node:path'
import { applyArtifactEvidenceWithMtime, matchingFiles } from './core/artifacts.ts'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'
import { buildStageChain, STEP_META } from './core/stages.ts'
import { attachFailure, markStepStatus, resetAfter, walkChain } from './core/stateMachine.ts'
import type { RunInput, RunMode, StepId, StepWriteback, WorkflowRun, WorkflowStep } from './core/types.ts'
import { findLatestChangeId, listChangeFileStats, resolveChangeId } from './artifact-watcher.ts'
import type { WorkflowRunner } from './runner.ts'
import { WorkflowStore } from './store.ts'

export interface EngineOptions {
  repoPath: string
  store: WorkflowStore
  runner: WorkflowRunner
  opencodeBin?: string
  pollMs?: number
  logTailLimit?: number
  onLog?: (line: string) => void
}

const SEGMENT_TITLES = [
  'routing-plan',
  'routing-to-design-gate',
  'develop-to-closeout',
  'post-deploy-closeout',
] as const

export class WorkflowEngine {
  private readonly repoPath: string
  private readonly store: WorkflowStore
  private readonly runner: WorkflowRunner
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
    void this.runner.stop()
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
    void this.runner.stop()
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
  async launch(run: WorkflowRun, hostAgent?: unknown): Promise<boolean> {
    if (this.store.anyActiveForSession(run.repoPath, run.sessionId, run.runId)) {
      run.status = 'failed'
      run.error = '该会话已有进行中的工作流运行'
      this.store.put(run)
      this.store.persist(run.repoPath)
      return false
    }
    const now = new Date().toISOString()
    run.status = 'running'
    run.startedAt = now
    run.updatedAt = now
    run.segment = 0
    markStepStatus(run.steps, 'routing', 'running', now, '正在生成路由与流程计划')
    const spawn = await this.startSegment(run, 0, hostAgent)
    if (!spawn) {
      run.status = 'failed'
      run.error = this.runner.kind === 'harness' ? 'Harness 执行引擎启动失败' : 'opencode 启动失败'
      this.store.persist(run.repoPath)
      return false
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    this.startPolling()
    return true
  }

  /** Stop a run, keep its current step positions, and annotate the user stop. */
  async stopRun(runId: string): Promise<boolean> {
    const run = this.store.get(runId)
    if (run === undefined) return false
    await this.runner.stop()
    run.status = 'stopped'
    run.updatedAt = new Date().toISOString()
    run.exitCode = null
    run.error = '用户终止'
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting_user') {
        step.note = '用户终止'
      }
      if (step.substeps !== undefined) {
        for (const sub of step.substeps) {
          if (sub.status === 'running' || sub.status === 'waiting_user') sub.note = '用户终止'
        }
      }
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    return true
  }

  /** Confirm or cancel a waiting user gate. */
  async resolveGate(runId: string, stepId: StepId, action: 'confirm' | 'cancel'): Promise<boolean> {
    const run = this.store.get(runId)
    if (run === undefined) return false
    const step = run.steps.find(s => s.id === stepId)
    if (step === undefined || step.gate === undefined) return false

    const now = new Date().toISOString()

    if (action === 'cancel') {
      await this.runner.stop()
      step.note = '用户终止'
      run.updatedAt = now
      run.error = '用户终止'
      run.status = 'stopped'
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
      await this.runner.stop()
      this.store.put(run)
      this.store.persist(run.repoPath)
      return true
    }

    const nextSegment = stepId === 'routing-plan' ? 1 : stepId === 'design-gate' ? 2 : stepId === 'deploy-ok' ? 3 : run.segment
    run.segment = nextSegment as 0 | 1 | 2 | 3
    run.status = 'running'
    run.updatedAt = now

    // Wait for a still-running harness turn to settle before continuing the
    // same session. Opencode segments are stopped explicitly below.
    if (this.runner.kind === 'harness') await this.runner.whenIdle()
    else await this.runner.stop()

    const spawn = await this.startSegment(run, nextSegment as 0 | 1 | 2 | 3)
    if (!spawn) {
      run.status = 'failed'
      run.error = this.runner.kind === 'harness' ? 'Harness 执行引擎续跑启动失败' : 'opencode 续跑启动失败'
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
    return true
  }

  /** Poll artifacts and advance the chain. Called on an interval and after events. */
  tick(): void {
    // Runs follow their own workspace (a slash-command run binds the invoking
    // conversation's cwd, which may differ from the plugin's configured repo),
    // so every active run reconciles against ITS OWN repoPath.
    for (const run of this.store.allActive()) {
      this.reconcile(run)
    }
  }

  private reconcile(run: WorkflowRun): void {
    const now = new Date().toISOString()
    const resolvedChangeId = resolveChangeId(run.repoPath, run.changeId)
    if (resolvedChangeId !== undefined && run.changeId !== resolvedChangeId) {
      run.changeId = resolvedChangeId
    }

    const stats = resolvedChangeId === undefined ? [] : listChangeFileStats(run.repoPath, resolvedChangeId)
    if (resolvedChangeId !== undefined) {
      const changed = applyArtifactEvidenceWithMtime(run.steps, stats, now)
      this.populateStepOutcomes(run, resolvedChangeId, stats)
      if (this.detectWritebacks(run, stats, resolvedChangeId)) {
        // A write-back re-opened an earlier step: make sure the chain reflects
        // the re-run step as the current one when possible.
        this.persist(run)
      }
      if (changed) this.persist(run)
    }

    const confirmedGates = new Set<StepId>(
      run.steps.filter(s => s.gate !== undefined && s.status === 'done').map(s => s.id),
    )
    // Gate catch-up: the conversation may confirm a gate in-band (the harness
    // agent just proceeds past it in the dialogue) without the plugin's UI
    // button ever being clicked. When a gate's DOWNSTREAM artifacts already
    // exist, the workflow has factually passed that gate — treat it as
    // confirmed so the chain does not stall on a wait the user already gave.
    let gateChanged = false
    for (const gate of run.steps.filter(s => s.gate !== undefined)) {
      if (gate.status === 'done' || confirmedGates.has(gate.id)) continue
      const gateIndex = run.steps.indexOf(gate)
      const downstreamSatisfied = run.steps
        .filter((s, index) => index > gateIndex && s.gate === undefined && s.artifactHints.length > 0)
        .some(s => s.artifactHints.some(hint => matchingFiles(hint, stats).length > 0))
      if (downstreamSatisfied) {
        markStepStatus(run.steps, gate.id, 'done', now, '已在会话中确认（产物已推进）')
        confirmedGates.add(gate.id)
        gateChanged = true
      }
    }
    if (gateChanged) this.persist(run)

    const outcome = walkChain(run.steps, { designOnly: run.designOnly, confirmedGates, now })

    if (outcome.stoppedOnGate !== undefined) {
      run.status = 'waiting_user'
      // For opencode, keep the non-interactive process from lingering while
      // the UI waits for the user. The Harness agent owns its session and will
      // settle at the next whenIdle boundary on its own; disposing it here
      // would lose the session we need to resume after confirmation.
      if (this.runner.kind === 'opencode' && this.runner.running) void this.runner.stop()
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

  /** Flatten main steps and substeps in canonical display order. */
  private flattenSteps(run: WorkflowRun): Array<{ step: WorkflowStep; parent?: WorkflowStep; order: number }> {
    const out: Array<{ step: WorkflowStep; parent?: WorkflowStep; order: number }> = []
    let order = 0
    for (const step of run.steps) {
      out.push({ step, order: order++ })
      if (step.substeps !== undefined) {
        for (const sub of step.substeps) out.push({ step: sub, parent: step, order: order++ })
      }
    }
    return out
  }

  /** Fill result summary and output directory for every completed step. */
  private populateStepOutcomes(run: WorkflowRun, changeId: string, stats: ReturnType<typeof listChangeFileStats>): void {
    const workspace = join(run.repoPath, 'ub-workspace', 'changes', changeId)
    for (const { step } of this.flattenSteps(run)) {
      if (step.status !== 'done') continue
      const matches = step.artifactHints.flatMap(hint => matchingFiles(hint, stats))
      const deduped = [...new Set(matches.map(entry => entry.file))]
      if (deduped.length > 0) {
        const dirHint = step.artifactHints.find(hint => hint.includes('/'))
        const subDir = dirHint !== undefined ? dirHint.split('/')[0] : ''
        step.outputDir = subDir !== '' ? join(workspace, subDir) : workspace
        const preview = deduped.slice(0, 6).join('、')
        step.result = `产出 ${deduped.length} 项：${preview}${deduped.length > 6 ? ' 等' : ''}`
      } else if (step.gate !== undefined) {
        step.outputDir = workspace
        step.result = step.status === 'done' ? '用户已确认' : step.result
      } else {
        step.outputDir = workspace
        step.result = step.result ?? '完成'
      }
    }
  }

  /**
   * Detect write-backs: a completed step whose artifact files got a newer
   * mtime than the step's recorded finish time was regenerated by the
   * workflow (resume/rollback). Returns true when at least one write-back was
   * recorded.
   */
  private detectWritebacks(run: WorkflowRun, stats: ReturnType<typeof listChangeFileStats>, changeId: string): boolean {
    const entries = this.flattenSteps(run)
    const detected: Array<{ step: WorkflowStep; parent?: WorkflowStep; order: number; reason: string; newest: number }> = []

    for (const { step, parent, order } of entries) {
      if (step.status !== 'done' || step.finishedAt === undefined || step.artifactHints.length === 0) continue
      const matched = step.artifactHints.flatMap(hint => matchingFiles(hint, stats))
      if (matched.length === 0) continue
      const newest = Math.max(...matched.map(entry => entry.mtimeMs))
      const finishedMs = Date.parse(step.finishedAt)
      // Normal completion: artifacts slightly predate the detected finish.
      if (newest <= finishedMs + 800) continue
      const previous = step.writebacks?.at(-1)
      // Debounce one write-back wave: additional file rewrites within 60s do
      // not start a new count for the same step.
      if (previous !== undefined && newest <= previous.mtimeMs + 60_000) continue

      const reason = this.writebackReason(step, matched.map(entry => entry.file), run)
      detected.push({ step, parent, order, reason, newest })
    }

    if (detected.length === 0) return false

    // Record all, but only the earliest re-opened step becomes the visual
    // "current" running step; later steps re-open on their own when their own
    // artifacts are regenerated.
    detected.sort((a, b) => a.order - b.order)
    const earliest = detected[0]

    for (const item of detected) {
      const seq = (item.step.writebacks?.length ?? 0) + 1
      const record: StepWriteback = {
        seq,
        at: new Date().toISOString(),
        reason: item.reason,
        mtimeMs: item.newest,
      }
      item.step.writebacks = [...(item.step.writebacks ?? []), record]
      item.step.note = `回写 #${seq}：${item.reason.slice(0, 160)}`
    }

    // Re-open the earliest re-run step and reset every later stage so the
    // diagram matches the actual workflow: a review finding hands back to
    // develop, so test/review/closeout are no longer valid until re-run.
    const reStep = earliest.step
    const reParent = earliest.parent
    if (reStep.status === 'done') {
      // Reset later main steps (and their substeps) first, then the re-opened
      // step's own substeps when it is a composite step like develop.
      resetAfter(run.steps, reStep.id)
      if (reStep.id === 'develop' && reStep.substeps !== undefined) {
        for (const sub of reStep.substeps) {
          sub.status = 'pending'
          sub.startedAt = undefined
          sub.finishedAt = undefined
          sub.note = undefined
          sub.error = undefined
        }
      }
      reStep.status = 'running'
      reStep.startedAt = new Date().toISOString()
      if (reParent !== undefined && reParent.status === 'done') {
        reParent.status = 'running'
        if (reParent.startedAt === undefined) reParent.startedAt = reStep.startedAt
      }
      run.status = 'running'
    }

    return true
  }

  /** Best-effort reason for a write-back from the regenerated files + recent opencode lines. */
  private writebackReason(step: WorkflowStep, touchedFiles: string[], run: WorkflowRun): string {
    const fileText = touchedFiles.slice(0, 4).join(', ')
    let base: string

    switch (step.id) {
      case 'requirement':
      case 'design':
        base = '设计/需求阶段回写（澄清、门禁未过或设计缺陷）'
        break
      case 'develop':
      case 'develop.implement':
      case 'develop.patch':
      case 'develop.pre-review':
      case 'develop.compile':
        base = '开发回写（source_bug / review findings / STC 失败证据或编译修复）'
        break
      case 'test':
        base = '测试回写（源码 bug 修复后复测或用例更新）'
        break
      case 'review':
        base = '审查复审回写'
        break
      case 'verify':
        base = '部署/STC 验证回写'
        break
      case 'closeout':
        base = '归档回写'
        break
      default:
        base = '检测到产物重新生成'
    }

    const snippet = writebackEvidenceSnippet(run.logTail)
    const parts = [`${base}。更新文件: ${fileText}`, snippet !== '' ? `最近事件: ${snippet}` : '']
    return parts.filter(part => part !== '').join('；').slice(0, 500)
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
    this.pushLog(run, this.runner.kind === 'harness'
      ? `[harness turn idle] code=${code} signal=${signal}`
      : `[opencode exited] code=${code} signal=${signal}`)

    this.reconcile(run)

    if (run.status === 'running' || run.status === 'waiting_user') {
      // The executor settled before the chain did. If the next barrier is a
      // gate we are already waiting on, leave it waiting; otherwise either
      // close the run (terminal gate already done) or attribute failure to the
      // current unfinished step so the run never lingers in `running`.
      const nextWaiting = run.steps.find(s => s.status === 'waiting_user')
      if (nextWaiting === undefined) {
        const hasAnyRunning = (steps: WorkflowStep[]): boolean => steps.some(s =>
          s.status === 'running'
          || (s.substeps?.some(sub => sub.status === 'running') ?? false),
        )
        // A detected write-back re-opens the earliest affected step; the run
        // must stay `running` there instead of being failed for idling after
        // the review→develop hand-back.
        const runClosed = run.designOnly && run.steps.find(s => s.id === 'design-gate')?.status === 'done'
          ? (run.status = 'done', run.finishedAt = run.finishedAt ?? new Date().toISOString(), true)
          : false
        if (!runClosed && !hasAnyRunning(run.steps)) {
          const failure = this.runner.kind === 'harness'
            ? 'Harness Agent 已空闲但当前步骤产物未满足完成条件'
            : `opencode 进程退出 (code=${code})`
          const failed = attachFailure(run.steps, failure)
          run.status = failed === undefined ? 'done' : 'failed'
          run.error = this.runner.kind === 'harness'
            ? '执行已结束，但未推进到下一个门禁或完成态'
            : `opencode 进程非正常退出 (code=${code})`
        }
      }
    }
    this.store.put(run)
    this.store.persist(run.repoPath)
  }

  private async startSegment(run: WorkflowRun, segment: 0 | 1 | 2 | 3, hostAgent?: unknown): Promise<boolean> {
    const prompt = this.runner.kind === 'harness'
      ? this.buildHarnessPrompt(run, segment)
      : this.buildPrompt(run, segment)
    return await this.runner.start({
      repoPath: run.repoPath,
      sessionId: run.runId,
      title: `dsh-ub-workflow:${run.module ?? ''}:${SEGMENT_TITLES[segment]}:${run.runId.slice(0, 8)}`,
      prompt,
      opencodeBin: this.opencodeBin,
      hostAgent,
      onEvent: event => { this.onEvent(run.runId, event) },
      onExit: (code, signal) => { this.onExit(run.runId, code, signal) },
      onLogLine: line => {
        const active = this.store.findActive(run.repoPath)
        if (active !== undefined && active.runId === run.runId) this.pushLog(active, line)
      },
    })
  }

  /** Plain-human prompt for the Harness Agent (original conversation turn). */
  private buildHarnessPrompt(run: WorkflowRun, segment: 0 | 1 | 2 | 3): string {
    const context: string[] = []
    if (run.module !== undefined && run.module !== '') context.push(`模块：${run.module}`)
    context.push(`模式：${run.designOnly ? 'design-only' : run.mode}${run.deploy ? ' + deploy' : ''}`)
    if (run.changeId !== undefined && run.changeId !== '') context.push(`change-id：${run.changeId}`)

    const change = run.changeId ?? ''

    if (segment === 0) {
      return [
        '请执行 UnifiedBus（UB）内核驱动 AI 开发工作流。',
        '',
        '本轮任务：',
        run.requirement,
        '',
        '工作流参数：',
        ...(context.length > 0 ? context.map(line => `- ${line}`) : []),
        '',
        '第一步是“路由与流程计划”：先阅读仓库内的 docs/references/skills，确认模块归属、判定流程类型、生成阶段链与 workspace 建立计划。',
        `将路由结论写入仓库 ub-workspace/changes/${change}/.knowledge/events.ndjson（JSON Lines，每行一个事件对象）。`,
        '完成路由计划后停止本轮，等待用户确认；不要开始需求分析，不要创建 requirement_analysis.md。',
      ].join('\n')
    }

    if (segment === 1) {
      return [
        '用户已在 UB 工作流界面确认 routing-plan 通过。',
        '',
        '现在从建立 workspace 开始执行：需求分析 → 详细设计（含 delta spec 与 STC）。',
        `所有工作产物必须写入仓库 ub-workspace/changes/${change}/ 目录下（requirement_analysis.md、detailed_design.md、delta/*.md 等）。`,
        '到达 design-gate 后立即停止本轮，等待用户确认；不要继续进入开发阶段。',
      ].join('\n')
    }

    if (segment === 2) {
      const stopAtDeploy = run.mode === 'full' && run.deploy
        ? '执行 verify 阶段后停在 deploy-ok 门禁，等待用户确认，不要继续 STC/closeout。'
        : '继续执行后续全部阶段：编码实现 → 测试 → 代码审查 →（full 模式含 verify）→ closeout，直至工作流结束。'
      return [
        '用户已在 UB 工作流界面确认 design-gate 通过。',
        '',
        stopAtDeploy,
        `后续产物仍写入 ub-workspace/changes/${change}/ 目录。`,
        '其余自动门禁按 UB 工作流规则自动推进；不要在确认过的 design-gate 上再次询问。',
      ].join('\n')
    }

    return [
      '用户已在 UB 工作流界面确认 deploy-ok 通过。',
      '',
      '请继续执行 STC 验证与 closeout（workflow 报告与归档），直至工作流结束。',
    ].join('\n')
  }

  private buildPrompt(run: WorkflowRun, segment: 0 | 1 | 2 | 3): string {
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
        '请执行 0d 路由与流程计划：识别模块、判定流程类型、生成阶段链与 workspace 建立计划，',
        '将结论写入 ub-workspace/changes/<change-id>/.knowledge/events.ndjson；完成后停止等待用户确认，',
        '不要进入 0e 需求分析。',
      ].filter(line => line !== '').join('\n')
    }

    if (segment === 1) {
      return [
        params.join(' '),
        run.requirement,
        '',
        '[dsh-ub-workflow 控制台指令（优先级高于默认流程）]',
        '用户已确认 routing-plan。请从 0e 建立 workspace 开始，dispatch 至 design-gate 后停下等待用户确认。',
      ].filter(line => line !== '').join('\n')
    }

    if (segment === 2) {
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

const WRITEBACK_HINTS = [
  'resume', 'source_bug', 'findings', 'stc_exec_report', 'compile_fix',
  'root_cause', 'design_defect', '澄清', '回退', '修复', '阻塞', 'blocking',
] as const

/** Pull a short evidence snippet out of the recent opencode output, if any. */
function writebackEvidenceSnippet(logTail: readonly string[]): string {
  for (let i = logTail.length - 1; i >= 0; i -= 1) {
    const line = logTail[i] ?? ''
    if (WRITEBACK_HINTS.some(hint => line.toLowerCase().includes(hint.toLowerCase()))) {
      return line.trim().slice(0, 240)
    }
  }
  return ''
}