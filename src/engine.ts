/**
 * WorkflowEngine wires the pure state machine to the store, the opencode
 * runner, and the artifact watcher. It is the host-side conductor:
 * The supported production path is a host-confirmed, read-only Explore run.
 * Historical development chains remain renderable, while every execution and
 * recovery boundary rejects them until DSH owns each upstream question and permission gate.
 */

import { applyArtifactEvidence } from './core/artifacts.ts'
import { isSafeWorkflowId } from './core/ids.ts'
import { parseOpencodeLine, type ParsedOpencodeEvent } from './core/opencodeEvents.ts'
import { validateDevelopInputs, validateRequirement } from './core/inputValidation.ts'
import { allSteps, buildStageChain, STEP_META } from './core/stages.ts'
import { attachFailure, markStepStatus, resetAfter, walkChain } from './core/stateMachine.ts'
import { isSupportedWorkflowIntent, UNSUPPORTED_WORKFLOW_MESSAGE } from './core/supportPolicy.ts'
import { normalizePollMs } from './core/timing.ts'
import type {
  RunInput,
  RunMode,
  StepId,
  WorkflowArtifactPreview,
  WorkflowRun,
  WorkflowSegment,
  WorkflowSourceRoot,
} from './core/types.ts'
import { applyWorkflowEventEvidence, parseWorkflowEventLine, type WorkflowEvidenceEvent } from './core/workflowEvents.ts'
import {
  isFreshChangeWorkspace,
  initializeFreshChangeWorkspace,
  auditChangeEntries,
  captureUtEvidenceSnapshots,
  listChangeFiles,
  readEvidenceBoundArtifactPreviews,
  readChangeArtifactMetadata,
  readChangeEventLines,
  readExploreNoteReceipt,
  readUtEvidenceSnapshotMetadata,
  resolveChangeId,
  validatedKnowledgeArtifactFiles,
} from './artifact-watcher.ts'
import { OpenCodeServerRunner } from './serverRunner.ts'
import { WorkflowStore } from './store.ts'
import { isSupportedModule, loadModuleCodeRoots, loadModuleTestTimings } from './moduleManifest.ts'
import { adoptRunLease, claimRunLease, isCurrentRunLease, releaseRunLease, type RunLease } from './runLease.ts'
import { captureSourceFingerprint } from './sourceFingerprint.ts'

const MIN_EXPLORE_SECTION_CHARS = 48

function exploreSection(content: string, title: string): string | undefined {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${title}`)
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/.test(lines[index]!.trim())) {
      end = index
      break
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  const visible = body.replace(/[\s`*_>#\-[\]()]/g, '')
  return visible.length >= MIN_EXPLORE_SECTION_CHARS ? body : undefined
}

function validExploreNote(content: string): boolean {
  const domain = exploreSection(content, 'Domain Exploration')
  const structure = exploreSection(content, 'Code Structure')
  if (domain === undefined || structure === undefined) return false
  const searchBasis = /text(?:ual)?\s+search|\bgrep\b|\bglob\b|文本(?:检索|搜索)/i.test(content)
  const codegraphLimit = /(?:\bno\b|\bnot\b|\bwithout\b|did not|does not|cannot|can't|非|未|不|没有)[^\n.。]{0,64}codegraph|codegraph[^\n.。]{0,64}(?:not used|unavailable|未使用|不可用|未启用)/i.test(content)
  return searchBasis && codegraphLimit
}

export interface EngineOptions {
  /** Writable workspace root that owns state and ub-workspace. */
  repoPath: string
  /** Read-only ub-drv-develop workflow bundle. */
  workflowPath: string
  /** Fallback root used to resolve portable manifest code_roots. */
  sourcePath: string
  /** Absolute overrides for manifest roots stored in independent checkouts. */
  sourceRootOverrides?: Readonly<Record<string, string>>
  store: WorkflowStore
  runner: OpenCodeServerRunner
  opencodeBin?: string
  pollMs?: number
  logTailLimit?: number
  onLog?: (line: string) => void
  loadTestTimings?: typeof loadModuleTestTimings
  loadCodeRoots?: typeof loadModuleCodeRoots
  captureSourceFingerprint?: typeof captureSourceFingerprint
}

function sameSourceRoots(left: readonly WorkflowSourceRoot[], right: readonly WorkflowSourceRoot[]): boolean {
  return left.length === right.length && left.every((root, index) => (
    root.manifestPath === right[index]?.manifestPath && root.path === right[index]?.path
  ))
}

const SEGMENT_TITLES = [
  'readonly-exploration',
  'unsupported-design',
  'unsupported-development',
  'unsupported-deployment',
  'unsupported-closeout',
] as const

function evidencePrefix(event: WorkflowEvidenceEvent): string {
  const separator = event.event_type.lastIndexOf('.')
  return separator < 0 ? event.event_type : event.event_type.slice(0, separator)
}

function eventAllowedInSegment(run: WorkflowRun, event: WorkflowEvidenceEvent): boolean {
  const prefix = evidencePrefix(event)
  if (event.event_type === 'workflow.started') return true
  if (run.mode === 'explore') return prefix === 'explore'
  const cumulative = new Set(['requirement'])
  if (run.segment >= 1) for (const value of ['design', 'stc']) cumulative.add(value)
  if (run.segment >= 2) {
    for (const value of ['develop', 'patch', 'compile', 'verification', 'review']) cumulative.add(value)
  }
  if (run.segment === 2) cumulative.add('workflow')
  return cumulative.has(prefix)
}

function forbiddenDeploymentTool(event: ParsedOpencodeEvent): boolean {
  if (event.toolName === undefined) return false
  const tool = event.toolName.toLowerCase()
  const text = event.text ?? ''
  if (tool === 'task') return /\bub-(?:verify|deploy)\b/i.test(text)
  return (tool === 'bash' || tool === 'shell')
    && /deploy_and_reset|(?:rpm|dnf|yum)\s+(?:-i|-u|install|upgrade)/i.test(text)
}

export class WorkflowEngine {
  private readonly repoPath: string
  private readonly workflowPath: string
  private readonly sourcePath: string
  private readonly sourceRootOverrides: Readonly<Record<string, string>>
  private readonly store: WorkflowStore
  private readonly runner: OpenCodeServerRunner
  private readonly opencodeBin?: string
  private readonly pollMs: number
  private readonly logTailLimit: number
  private readonly onLog?: (line: string) => void
  private readonly loadTestTimings: typeof loadModuleTestTimings
  private readonly loadCodeRoots: typeof loadModuleCodeRoots
  private readonly fingerprintSource: typeof captureSourceFingerprint
  private timer: ReturnType<typeof setInterval> | null = null
  private activeRunId: string | undefined
  private readonly leases = new Map<string, RunLease>()
  private readonly resolvingGates = new Set<string>()
  private readonly finishingRuns = new Set<string>()

  constructor(options: EngineOptions) {
    this.repoPath = options.repoPath
    this.workflowPath = options.workflowPath
    this.sourcePath = options.sourcePath
    this.sourceRootOverrides = Object.freeze({ ...(options.sourceRootOverrides ?? {}) })
    this.store = options.store
    this.runner = options.runner
    this.opencodeBin = options.opencodeBin
    this.pollMs = normalizePollMs(options.pollMs)
    this.logTailLimit = options.logTailLimit ?? 80
    this.onLog = options.onLog
    this.loadTestTimings = options.loadTestTimings ?? loadModuleTestTimings
    this.loadCodeRoots = options.loadCodeRoots ?? loadModuleCodeRoots
    this.fingerprintSource = options.captureSourceFingerprint ?? captureSourceFingerprint
  }

  /** The writable workspace root this engine instance was created for. */
  get currentRepoPath(): string {
    return this.repoPath
  }

  get processBusy(): boolean {
    return this.runner.running
  }

  stopActiveProcess(): void {
    const active = this.store.findActive(this.repoPath)
    if (active !== undefined) {
      void this.stopRun(active.runId)
      return
    }
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
    const active = this.store.findActive(this.repoPath)
    if (active !== undefined) void this.stopRun(active.runId)
    this.runner.dispose()
  }

  /** Create a run from user input (does not spawn). */
  createRun(input: RunInput): WorkflowRun {
    if (!isSupportedWorkflowIntent(input)) throw new Error(UNSUPPORTED_WORKFLOW_MESSAGE)
    if (input.repoPath !== this.repoPath) throw new Error('运行必须使用当前引擎配置的 workspace root')
    if (!isSupportedModule(input.module)) {
      throw new Error('read-only Explore requires a supported module')
    }
    const validatedRequirement = validateRequirement(input.requirement)
    if (!validatedRequirement.ok) throw new Error(validatedRequirement.error)
    const now = new Date().toISOString()
    const mode: RunMode = input.mode
    const designOnly = input.designOnly === true
    const deploy = false
    const runId = input.runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const changeId = input.changeId ?? this.defaultChangeId(input.module, validatedRequirement.value, runId)
    const sourceRoots = this.loadCodeRoots(
      this.workflowPath,
      this.sourcePath,
      input.module,
      this.sourceRootOverrides,
    )
    const testTimings = mode === 'explore' || designOnly
      ? []
      : this.loadTestTimings(this.workflowPath, input.module)
    const steps = buildStageChain({ mode, designOnly, deploy, testTimings })
    const claimed = claimRunLease(this.repoPath, changeId, runId)
    if (!claimed.ok) throw new Error(`该仓库已有其他工作流持有运行锁：${claimed.reason}`)
    this.leases.set(runId, claimed.lease)

    const run: WorkflowRun = {
      runId,
      ownerPid: process.pid,
      repoPath: this.repoPath,
      workflowPath: this.workflowPath,
      sourceRoots,
      sessionId: input.sessionId,
      changeId,
      module: input.module,
      mode,
      designOnly,
      deploy,
      testTimings,
      requirement: validatedRequirement.value,
      status: 'idle',
      steps,
      segment: 0,
      createdAt: now,
      updatedAt: now,
      logTail: [],
    }

    this.store.put(run)
    try {
      this.store.persist(run.repoPath)
    } catch (error) {
      this.store.delete(run.runId)
      releaseRunLease(claimed.lease)
      this.leases.delete(run.runId)
      throw error
    }
    return run
  }

  /** Bounded, symlink-safe evidence previews for a visible step or gate. */
  previewStepArtifacts(runId: string, stepId: StepId): { artifacts: WorkflowArtifactPreview[]; evidenceIds: string[] } {
    const run = this.store.get(runId)
    if (run?.changeId === undefined) return { artifacts: [], evidenceIds: [] }
    const requested = allSteps(run.steps).find(step => step.id === stepId)
    if (requested === undefined) return { artifacts: [], evidenceIds: [] }
    const evidenceStepId: StepId = stepId === 'requirement-clarify'
      ? 'requirement'
      : stepId === 'design-gate'
        ? 'design'
        : stepId === 'deploy-authorize'
          ? 'review'
          : stepId === 'deploy-ok'
            ? 'verify-deploy'
            : stepId
    const evidenceStep = allSteps(run.steps).find(step => step.id === evidenceStepId)
    const evidenceIds = evidenceStep?.evidenceId === undefined
      ? []
      : [evidenceStep.evidenceId, ...(evidenceStep.supportingEvidenceIds ?? [])]
    const eventLines = readChangeEventLines(run.repoPath, run.changeId)
    const parsed = eventLines.map(line => parseWorkflowEventLine(line, run.changeId!))
    if (eventLines.length === 0 || parsed.some(event => event === undefined)) {
      return { artifacts: [], evidenceIds: [] }
    }
    const events = parsed.filter((event): event is WorkflowEvidenceEvent => event !== undefined)
    if (new Set(events.map(event => event.event_id)).size !== events.length) {
      return { artifacts: [], evidenceIds: [] }
    }
    const artifacts = readEvidenceBoundArtifactPreviews(
      run.repoPath,
      run.changeId,
      evidenceStep?.artifactHints ?? [],
      evidenceIds,
      events,
    )
    return artifacts === undefined ? { artifacts: [], evidenceIds: [] } : { artifacts, evidenceIds }
  }

  /** Validate a run and expose its concrete routing plan for explicit confirmation. */
  launch(run: WorkflowRun): boolean {
    if (!isSupportedWorkflowIntent(run)) return this.failUnsupportedWorkflow(run)
    if (run.ownerPid !== process.pid || !this.ownsRunLease(run)) return false
    if (run.changeId !== undefined && !isFreshChangeWorkspace(run.repoPath, run.changeId)) {
      const now = new Date().toISOString()
      run.status = 'failed'
      run.error = `change workspace 已存在内容或路径不安全，拒绝复用：${run.changeId}`
      run.finishedAt = now
      run.updatedAt = now
      this.persist(run)
      return false
    }
    if (this.store.anyActive(run.repoPath, run.runId)) {
      const now = new Date().toISOString()
      run.status = 'failed'
      run.error = '该仓库已有进行中的工作流'
      run.finishedAt = now
      run.updatedAt = now
      this.persist(run)
      return false
    }
    if (this.runner.running) {
      const now = new Date().toISOString()
      run.status = 'failed'
      run.error = '上一工作流进程仍在退出，请稍后重试'
      run.finishedAt = now
      run.updatedAt = now
      this.persist(run)
      return false
    }
    const now = new Date().toISOString()
    run.status = 'waiting_user'
    run.startedAt = now
    run.updatedAt = now
    run.segment = 0
    const route = run.steps.find(step => step.id === 'routing-plan')
    if (route !== undefined) {
      route.status = 'waiting_user'
      route.startedAt = now
      route.note = [
        `module=${run.module ?? 'UNRESOLVED'}`,
        `mode=${run.designOnly ? 'design-only' : run.mode}${run.deploy ? '+deploy' : ''}`,
        `change-id=${run.changeId ?? 'UNRESOLVED'}`,
        `workflow-bundle=${run.workflowPath === undefined ? 'UNRESOLVED' : 'FROZEN'}`,
        `source-roots=${run.sourceRoots?.length ?? 0} (review exact mappings below)`,
        `workspace=ub-workspace/changes/${run.changeId ?? 'UNRESOLVED'}`,
        `stages=${run.steps.map(step => step.title).join(' → ')}`,
      ].join(' · ')
    }
    this.persist(run)
    this.startPolling()
    return true
  }

  /** Stop a run and kill the underlying process. */
  stopRun(runId: string): boolean {
    const run = this.store.get(runId)
    if (run === undefined || run.ownerPid !== process.pid || !['idle', 'running', 'waiting_user'].includes(run.status)) return false
    if (!this.ensureRunLease(run)) return false
    this.stopProcessFor(runId)
    run.status = 'stopped'
    const now = new Date().toISOString()
    run.updatedAt = now
    run.finishedAt = now
    run.exitCode = null
    for (const step of allSteps(run.steps)) {
      if (step.status === 'running' || step.status === 'waiting_user') {
        step.status = 'skipped'
      }
    }
    this.persist(run)
    return true
  }

  /** Confirm or cancel a waiting user gate. */
  async resolveGate(
    runId: string,
    stepId: StepId,
    action: 'confirm' | 'cancel' | 'revise',
    response?: string,
    reviewedEvidenceIds?: string[],
  ): Promise<boolean> {
    if (this.resolvingGates.has(runId)) return false
    this.resolvingGates.add(runId)
    try {
      return await this.resolveGateUnlocked(runId, stepId, action, response, reviewedEvidenceIds)
    } finally {
      this.resolvingGates.delete(runId)
    }
  }

  private async resolveGateUnlocked(
    runId: string,
    stepId: StepId,
    action: 'confirm' | 'cancel' | 'revise',
    response?: string,
    reviewedEvidenceIds?: string[],
  ): Promise<boolean> {
    const run = this.store.get(runId)
    if (run === undefined || run.ownerPid !== process.pid || run.status !== 'waiting_user') return false
    if (!isSupportedWorkflowIntent(run)) return this.failUnsupportedWorkflow(run)
    let step = run.steps.find(s => s.id === stepId)
    if (step === undefined || step.gate === undefined || step.status !== 'waiting_user') return false

    const now = new Date().toISOString()

    if (!this.ensureRunLease(run)) return false
    const rejectInput = (message: string): false => {
      step!.error = message
      run.error = message
      this.persist(run)
      return false
    }

    if (action === 'cancel') {
      this.stopProcessFor(runId)
      markStepStatus(run.steps, stepId, 'failed', now, '用户取消')
      run.status = 'stopped'
      run.updatedAt = now
      run.finishedAt = now
      this.persist(run)
      return true
    }

    const normalizedResponse = response?.trim()
    if (action === 'revise') {
      if (stepId !== 'design-gate' || normalizedResponse === undefined || normalizedResponse === '') {
        return rejectInput('请填写明确的重新设计意见')
      }
      if (run.opencodeSessionId === undefined) return rejectInput('未捕获可续跑的 OpenCode 会话')
      const beforeTransition = structuredClone(run)
      run.gateResponses ??= {}
      run.gateResponses['design-gate'] = normalizedResponse
      const design = run.steps.find(candidate => candidate.id === 'design')
      if (design === undefined) return false
      design.status = 'pending'
      design.startedAt = undefined
      design.finishedAt = undefined
      design.note = '按用户修改意见重新设计'
      design.error = undefined
      design.evidenceId = undefined
      design.supportingEvidenceIds = undefined
      run.designSummaryBaseline = undefined
      resetAfter(run.steps, 'design')
      if (run.gateEvidence !== undefined) delete run.gateEvidence['design-gate']
      run.segment = 1
      run.status = 'running'
      run.error = undefined
      run.finishedAt = undefined
      try {
        this.persist(run)
      } catch (error) {
        this.restoreRun(run, beforeTransition)
        throw error
      }
      this.stopProcessFor(runId)
      const started = this.startSegment(run, 1)
      if (!started) {
        run.status = 'failed'
        run.error = 'opencode 重新设计启动失败'
        run.finishedAt = new Date().toISOString()
      }
      if (!started) this.persist(run)
      return started
    }

    // A gate click is a decision boundary. Re-read current hashes/files here,
    // rather than trusting the last polling tick, so a changed prerequisite
    // cannot be confirmed inside the polling interval.
    if (stepId !== 'routing-plan') this.reconcile(run)
    step = run.steps.find(s => s.id === stepId)
    const gateIndex = run.steps.findIndex(s => s.id === stepId)
    const invalidPrerequisite = gateIndex < 0
      ? undefined
      : run.steps.slice(0, gateIndex).find(s => s.status !== 'done' && s.status !== 'skipped')
    if ((run.status as WorkflowRun['status']) === 'failed') return false
    if (step === undefined || step.status !== 'waiting_user' || invalidPrerequisite !== undefined) {
      const error = `门禁前置证据已失效：${invalidPrerequisite?.title ?? STEP_META[stepId].title}`
      if (invalidPrerequisite !== undefined) {
        invalidPrerequisite.status = 'failed'
        invalidPrerequisite.error = error
        invalidPrerequisite.finishedAt = now
      }
      run.status = 'failed'
      run.error = error
      run.finishedAt = now
      this.persist(run)
      return false
    }

    if (step.interaction === 'response' && (normalizedResponse === undefined || normalizedResponse === '')) {
      return rejectInput('该门禁需要填写回复或参数')
    }

    if (stepId === 'routing-plan' && run.changeId !== undefined) {
      if (!isFreshChangeWorkspace(run.repoPath, run.changeId)) {
        const error = `确认前 change workspace 已被占用，拒绝启动：${run.changeId}`
        step.status = 'failed'
        step.error = error
        step.finishedAt = now
        run.status = 'failed'
        run.error = error
        run.finishedAt = now
        this.persist(run)
        return false
      }
      if (run.mode === 'explore') {
        try {
          this.requireCurrentSourceMapping(run)
        } catch (error) {
          const message = `源码映射在确认前失效：${error instanceof Error ? error.message : String(error)}`
          step.status = 'failed'
          step.error = message
          step.finishedAt = now
          run.status = 'failed'
          run.error = message
          run.finishedAt = now
          this.persist(run)
          return false
        }
        const lease = this.leases.get(run.runId)
        const baseline = await this.fingerprintSource(run.sourceRoots!.map(root => root.path), run.repoPath)
        if (lease === undefined || !this.asyncRunIsCurrent(run, lease, ['waiting_user'])
          || step.status !== 'waiting_user') return false
        if (!baseline.ok) {
          step.status = 'failed'
          step.error = baseline.error
          step.finishedAt = now
          run.status = 'failed'
          run.error = baseline.error
          run.finishedAt = now
          this.persist(run)
          return false
        }
        run.sourceFingerprint = baseline.fingerprint
        if (initializeFreshChangeWorkspace(run.repoPath, run.changeId) === undefined) {
          const error = `无法安全建立 Explore workspace：${run.changeId}`
          step.status = 'failed'
          step.error = error
          step.finishedAt = now
          run.status = 'failed'
          run.error = error
          run.finishedAt = now
          this.persist(run)
          return false
        }
      }
    }

    if (stepId === 'design-gate' && !run.designOnly) {
      const validated = validateDevelopInputs(normalizedResponse ?? '')
      if (!validated.ok) return rejectInput(validated.error)
    }
    if (stepId !== 'routing-plan' && run.opencodeSessionId === undefined) {
      const error = '未从 OpenCode 输出捕获会话 ID，无法安全续跑'
      step.status = 'failed'
      step.error = error
      step.finishedAt = now
      run.status = 'failed'
      run.error = error
      run.finishedAt = now
      this.persist(run)
      return false
    }

    const beforeTransition = structuredClone(run)
    if (normalizedResponse !== undefined && normalizedResponse !== '' && step.gate !== undefined) {
      run.gateResponses ??= {}
      run.gateResponses[step.gate] = normalizedResponse
    }

    if (stepId === 'design-gate') {
      const design = run.steps.find(candidate => candidate.id === 'design')
      if (design?.status !== 'done' || design.evidenceId === undefined) {
        const error = '详细设计缺少可绑定的终态事件，无法确认门禁'
        step.status = 'failed'
        step.error = error
        step.finishedAt = now
        run.status = 'failed'
        run.error = error
        run.finishedAt = now
        this.persist(run)
        return false
      }
      const current = [design.evidenceId, ...(design.supportingEvidenceIds ?? [])]
      if (JSON.stringify(reviewedEvidenceIds ?? []) !== JSON.stringify(current)) {
        return rejectInput('设计证据已更新，请重新审阅最新预览后再确认')
      }
      run.gateEvidence ??= {}
      run.gateEvidence['design-gate'] = current
      if (run.designOnly && run.changeId !== undefined) {
        const existing = readChangeArtifactMetadata(
          run.repoPath,
          run.changeId,
          ['design_only_summary.md'],
          { maxArtifacts: 1, maxTotalBytes: 4 * 1024 * 1024 },
        )[0]
        run.designSummaryBaseline = existing === undefined
          ? 'absent'
          : `${existing.size}:${existing.sha256}`
      }
    }

    step.error = undefined
    run.error = undefined
    markStepStatus(run.steps, stepId, 'done', now, '用户已确认')

    const nextSegment = stepId === 'routing-plan'
      ? 0
      : stepId === 'requirement-clarify'
      ? 1
      : stepId === 'design-gate'
        ? 2
        : run.segment
    if (nextSegment > 2) return rejectInput('当前版本不支持 live deployment 段')
    run.segment = nextSegment
    run.status = 'running'
    run.updatedAt = now
    try {
      this.persist(run)
    } catch (error) {
      this.restoreRun(run, beforeTransition)
      throw error
    }
    if (stepId !== 'routing-plan') this.stopProcessFor(runId)
    const spawn = this.startSegment(run, nextSegment)
    if (!spawn) {
      run.status = 'failed'
      run.error = 'opencode 续跑启动失败'
      run.finishedAt = new Date().toISOString()
    }
    if (!spawn) this.persist(run)
    return spawn
  }

  /** Poll artifacts and advance the chain. Called on an interval and after events. */
  tick(): void {
    const run = this.store.findActive(this.repoPath)
    if (run === undefined || run.status === 'done' || run.status === 'stopped') return
    if (this.resolvingGates.has(run.runId) || this.finishingRuns.has(run.runId)) return
    if (run.ownerPid !== process.pid) {
      try {
        this.store.loadRepo(this.repoPath)
      } catch (error) {
        this.onLog?.(`[foreign run refresh failed] ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (!isSupportedWorkflowIntent(run)) {
      this.failUnsupportedWorkflow(run)
      return
    }
    if (!this.hasFrozenSourceMapping(run)) {
      this.failProtocol(run, '活动 Explore 运行缺少可信的 workflow/source root 冻结映射')
      return
    }
    if (run.status === 'idle') return
    if (!this.ownsRunLease(run)) return
    if (run.status === 'running' || run.status === 'waiting_user') {
      try {
        this.reconcile(run)
      } catch (error) {
        this.failFromInternalError(run, error)
      }
    }
  }

  private reconcile(run: WorkflowRun, forcePersist = false): void {
    const baseline = JSON.stringify(run)
    const commit = (): void => {
      if (forcePersist || JSON.stringify(run) !== baseline) this.persist(run)
    }
    const now = new Date().toISOString()
    const resolvedChangeId = resolveChangeId(run.repoPath, run.changeId)
    if (resolvedChangeId !== undefined && run.changeId !== resolvedChangeId) {
      run.changeId = resolvedChangeId
    }

    if (resolvedChangeId !== undefined) {
      const rawFiles = listChangeFiles(run.repoPath, resolvedChangeId)
      const eventLines = readChangeEventLines(run.repoPath, resolvedChangeId)
      const parsedEvents = eventLines.map(line => parseWorkflowEventLine(line, resolvedChangeId))
      const eventIds = parsedEvents.flatMap(event => event === undefined ? [] : [event.event_id])
      const eventStreamValid = eventLines.length > 0
        && parsedEvents.every(event => event !== undefined)
        && new Set(eventIds).size === eventIds.length
      const events = eventStreamValid
        ? parsedEvents.filter((event): event is WorkflowEvidenceEvent => event !== undefined)
        : []
      if (rawFiles.includes('.knowledge/events.ndjson') && !eventStreamValid) {
        const error = '工作流事件流损坏、超限、重复或不符合上游终态协议'
        attachFailure(run.steps, error, now)
        run.status = 'failed'
        run.error = error
        run.finishedAt = now
        this.stopProcessFor(run.runId)
        commit()
        return
      }
      if (run.module === undefined && events[0] !== undefined) run.module = events[0].module
      const moduleMismatch = run.module === undefined
        ? undefined
        : events.find(event => event.module !== run.module)
      if (moduleMismatch !== undefined) {
        const error = `工作流事件模块不一致：期望 ${run.module}，收到 ${moduleMismatch.module}`
        attachFailure(run.steps, error, now)
        run.status = 'failed'
        run.error = error
        run.finishedAt = now
        this.stopProcessFor(run.runId)
        commit()
        return
      }
      const outOfSegment = events.find(event => !eventAllowedInSegment(run, event))
      if (outOfSegment !== undefined) {
        const error = `事件 ${outOfSegment.event_type} 越过当前 OpenCode 段 ${run.segment} 的执行边界`
        attachFailure(run.steps, error, now)
        run.status = 'failed'
        run.error = error
        run.finishedAt = now
        this.stopProcessFor(run.runId)
        commit()
        return
      }
      const validKnowledge = new Set(validatedKnowledgeArtifactFiles(
        run.repoPath,
        resolvedChangeId,
        events,
        eventStreamValid,
      ))
      const knowledgeFiles = new Set([
        '.knowledge/events.ndjson',
        '.knowledge/retrieved.json',
        '.knowledge/episode.json',
        '.knowledge/candidates.json',
        '.knowledge/registry-receipt.json',
      ])
      const files = rawFiles
        .filter(file => !knowledgeFiles.has(file) || validKnowledge.has(file))
      const currentArtifacts = readChangeArtifactMetadata(
        run.repoPath,
        resolvedChangeId,
        events.flatMap(event => event.artifacts.map(artifact => artifact.path)),
      )
      captureUtEvidenceSnapshots(run.repoPath, run.runId, resolvedChangeId, events)
      const artifacts = [
        ...currentArtifacts,
        ...readUtEvidenceSnapshotMetadata(run.repoPath, run.runId, events),
      ]
      const artifactChanged = applyArtifactEvidence(run.steps, files, now)
      const eventChanged = applyWorkflowEventEvidence(run.steps, events, artifacts, files)
      void artifactChanged
      void eventChanged

      // A design-only summary is a post-gate closeout. A file prepared in an
      // earlier segment cannot satisfy it; segment 2 must create or change the
      // bytes relative to the signature captured at design-gate confirmation.
      if (run.designOnly) {
        const summary = run.steps.find(step => step.id === 'design-summary')
        const metadata = readChangeArtifactMetadata(
          run.repoPath,
          resolvedChangeId,
          ['design_only_summary.md'],
          { maxArtifacts: 1, maxTotalBytes: 4 * 1024 * 1024 },
        )[0]
        const currentSignature = metadata === undefined ? undefined : `${metadata.size}:${metadata.sha256}`
        if (summary?.status === 'done' && (run.segment < 2
          || run.designSummaryBaseline === undefined
          || currentSignature === undefined
          || currentSignature === run.designSummaryBaseline)) {
          summary.status = 'pending'
          summary.startedAt = undefined
          summary.finishedAt = undefined
          summary.note = undefined
          summary.error = undefined
          summary.evidenceId = undefined
          summary.supportingEvidenceIds = undefined
        }
      }

      const design = run.steps.find(step => step.id === 'design')
      const designGate = run.steps.find(step => step.id === 'design-gate')
      const confirmedEvidence = run.gateEvidence?.['design-gate'] ?? []
      const currentEvidence = design?.evidenceId === undefined
        ? []
        : [design.evidenceId, ...(design.supportingEvidenceIds ?? [])]
      if (designGate?.status === 'done'
        && (design?.status !== 'done'
          || currentEvidence.length !== confirmedEvidence.length
          || currentEvidence.some((id, index) => id !== confirmedEvidence[index]))) {
        const error = '已确认的设计或 STC 证据已变化，工作流已安全阻断'
        resetAfter(run.steps, 'design')
        if (design !== undefined) markStepStatus(run.steps, 'design', 'failed', now, error)
        if (run.gateResponses !== undefined) delete run.gateResponses['design-gate']
        if (run.gateEvidence !== undefined) delete run.gateEvidence['design-gate']
        run.status = 'failed'
        run.finishedAt = now
        run.error = error
        this.stopProcessFor(run.runId)
        commit()
        return
      }

    }

    const failedSteps = allSteps(run.steps).filter(step => step.status === 'failed')
    const failedStep = failedSteps.find(step => step.error !== undefined) ?? failedSteps[0]
    if (failedStep !== undefined) {
      // Let opencode finish its mandatory failure closeout while it is alive;
      // once it exits, the run becomes terminal without blaming a later step.
      if (!this.runner.running) {
        run.status = 'failed'
        run.error = failedStep.error ?? failedStep.note ?? `${failedStep.title}失败`
        run.finishedAt = run.finishedAt ?? now
      }
      commit()
      return
    }

    const confirmedGates = new Set<StepId>(
      run.steps.filter(s => s.gate !== undefined && s.status === 'done').map(s => s.id),
    )
    const outcome = walkChain(run.steps, { designOnly: run.designOnly, confirmedGates, now })

    if (outcome.stoppedOnGate !== undefined) {
      if (this.runner.running) {
        // The artifact can appear before OpenCode has flushed its terminal
        // event and durable session state. Keep the gate closed until the
        // child reaches idle and exits; onExit immediately reconciles again.
        const gate = run.steps.find(step => step.id === outcome.stoppedOnGate)
        if (gate !== undefined) gate.status = 'pending'
        run.status = 'running'
        commit()
        return
      }
      run.status = 'waiting_user'
      commit()
      return
    }

    if (outcome.stoppedOnDone === true) {
      if (!this.runner.running) {
        run.status = 'done'
        run.finishedAt = run.finishedAt ?? now
        run.exitCode = run.exitCode ?? 0
      }
      // While the server is still flushing, keep the chain complete but the
      // run non-terminal; no state file write is needed unless data changed.
      commit()
      return
    }

    if (run.status === 'waiting_user') run.status = 'running'
    commit()
  }

  /** Forward a parsed opencode event into the run log and current step notes. */
  onEvent(runId: string, event: ParsedOpencodeEvent): void {
    const run = this.store.get(runId)
    if (run === undefined || run.ownerPid !== process.pid || !this.ownsRunLease(run)) return
    if (!isSupportedWorkflowIntent(run)) {
      this.failUnsupportedWorkflow(run)
      return
    }
    if (event.sessionId !== undefined
      && event.sessionId.startsWith('ses_')
      && isSafeWorkflowId(event.sessionId)) {
      if (run.opencodeSessionId === undefined) {
        run.opencodeSessionId = event.sessionId
      } else if (run.opencodeSessionId !== event.sessionId) {
        this.pushLog(run, `[session mismatch ignored] expected=${run.opencodeSessionId}`)
      }
    }
    if (forbiddenDeploymentTool(event)) {
      this.failProtocol(run, `当前版本禁止 live deployment 动作：${event.toolName ?? 'unknown tool'}`)
      return
    }
    const text = event.toolName !== undefined
      ? `tool:${event.toolName}${event.text !== undefined ? ` ${event.text}` : ''}`
      : event.text
    if (text !== undefined && text !== '') {
      this.pushLog(run, text.slice(0, 400))
      const active = run.steps.find(s => s.status === 'running')
      if (active !== undefined) active.note = text.slice(0, 400)
    }
    try {
      this.reconcile(run, true)
    } catch (error) {
      this.failFromInternalError(run, error)
    }
  }

  async onExit(runId: string, code: number | null, signal: string | null): Promise<void> {
    if (this.finishingRuns.has(runId)) return
    this.finishingRuns.add(runId)
    try {
      await this.onExitUnlocked(runId, code, signal)
    } finally {
      this.finishingRuns.delete(runId)
    }
  }

  private async onExitUnlocked(runId: string, code: number | null, signal: string | null): Promise<void> {
    if (this.activeRunId !== runId) return
    this.activeRunId = undefined
    const run = this.store.get(runId)
    if (run === undefined || run.ownerPid !== process.pid || !this.ownsRunLease(run)) return
    const lease = this.leases.get(runId)
    if (lease === undefined) return
    if (!isSupportedWorkflowIntent(run)) {
      this.failUnsupportedWorkflow(run)
      return
    }
    const exitedAt = new Date().toISOString()
    run.exitCode = code
    run.updatedAt = exitedAt
    this.pushLog(run, `[opencode exited] code=${code} signal=${signal}`)

    if (run.mode === 'explore') {
      if (!this.hasFrozenSourceMapping(run)) {
        const error = 'Explore 运行缺少可信的 workflow/source root 冻结映射'
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      const current = await this.fingerprintSource(run.sourceRoots.map(root => root.path), run.repoPath)
      if (!this.asyncRunIsCurrent(run, lease, ['running', 'waiting_user', 'failed'])) return
      if (!current.ok || run.sourceFingerprint === undefined || current.fingerprint !== run.sourceFingerprint) {
        const error = current.ok ? 'Explore 运行修改了源码，已拒绝结果' : current.error
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      const exploreAudit = run.changeId === undefined
        ? { ok: false as const, error: 'Explore 运行缺少 change-id' }
        : auditChangeEntries(run.repoPath, run.changeId)
      if (!exploreAudit.ok) {
        const error = `Explore workspace 审计失败：${exploreAudit.error}`
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      const allowedExploreFiles = new Set(['exploration_notes.md'])
      const forbidden = exploreAudit.entries.find(entry => entry.kind !== 'file' || !allowedExploreFiles.has(entry.path))
      if (forbidden !== undefined) {
        const error = `Explore 运行产生了禁止或不完整的 workspace 产物：${forbidden.path} (${forbidden.kind})`
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      const noteEntry = exploreAudit.entries.find(entry => entry.path === 'exploration_notes.md' && entry.kind === 'file')
      const note = run.changeId === undefined ? undefined : readExploreNoteReceipt(run.repoPath, run.changeId)
      if (noteEntry === undefined || note === undefined || noteEntry.size !== note.size) {
        const error = 'Explore 运行未生成可稳定读取的 UTF-8 exploration_notes.md'
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      if (!validExploreNote(note.content)) {
        const error = 'Explore 笔记格式或内容不足：必须包含有实质内容的 Domain Exploration 与 Code Structure 两节，并声明文本检索而非 codegraph 的范围'
        this.failExploreStep(run, error, exitedAt)
        run.status = 'failed'
        run.error = error
        run.finishedAt = exitedAt
        this.persist(run)
        return
      }
      if (code === 0 && signal === null) {
        const successNote = `OpenCode 正常退出；源码与 workspace 审计通过；note=${note.size}B sha256=${note.sha256}`
        markStepStatus(
          run.steps,
          'explore',
          'done',
          exitedAt,
          successNote,
        )
        const exploreStep = run.steps.find(step => step.id === 'explore')
        if (exploreStep !== undefined) exploreStep.note = successNote
      }
    }

    this.reconcile(run)

    if (code !== 0 || signal !== null) {
      const error = `opencode 进程非正常退出 (code=${code}, signal=${signal})`
      if (run.status !== 'failed') {
        const failed = attachFailure(run.steps, error, exitedAt)
        if (failed === undefined) {
          const terminal = run.steps.at(-1)
          if (terminal !== undefined) {
            terminal.status = 'failed'
            terminal.error = error
            terminal.finishedAt = exitedAt
          }
        }
        run.error = error
      }
      run.status = 'failed'
      run.finishedAt = run.finishedAt ?? exitedAt
      this.persist(run)
      return
    }

    if (run.status === 'running' || run.status === 'waiting_user') {
      // Process ended before the chain did. If the next barrier is a gate we
      // are already waiting on, leave it waiting; otherwise attribute failure
      // to the current step.
      const nextWaiting = run.steps.find(s => s.status === 'waiting_user')
      if (nextWaiting === undefined) {
        const error = `opencode 进程在流程完成前退出 (code=${code}, signal=${signal})`
        const failed = attachFailure(run.steps, error)
        run.status = failed === undefined ? 'done' : 'failed'
        if (failed !== undefined) {
          run.error = error
          run.finishedAt = exitedAt
        }
      }
    }
    this.persist(run)
  }

  private startSegment(run: WorkflowRun, segment: WorkflowSegment): boolean {
    if (!isSupportedWorkflowIntent(run) || segment !== 0) return false
    if (!this.hasFrozenSourceMapping(run)) return false
    if (segment > 0 && run.opencodeSessionId === undefined) return false
    const started = this.runner.start({
      workflowId: run.runId,
      changeId: run.changeId ?? '',
      module: run.module ?? '',
      repoPath: run.repoPath,
      workflowPath: run.workflowPath,
      sourceRoots: run.sourceRoots,
      sessionId: segment === 0 ? undefined : run.opencodeSessionId,
      agent: 'ub-leader',
      title: `dsh-ub-workflow:${run.module ?? ''}:${SEGMENT_TITLES[segment]}:${run.runId.slice(0, 8)}`,
      prompt: this.buildPrompt(run, segment),
      opencodeBin: this.opencodeBin,
      onEvent: event => { this.guardCallback(run.runId, () => { this.onEvent(run.runId, event) }) },
      onExit: (code, signal) => {
        this.guardAsyncCallback(run.runId, async () => { await this.onExit(run.runId, code, signal) })
      },
      onStopped: () => { this.releaseTerminalLeaseIfStopped(run.runId) },
      onLogLine: line => {
        this.guardCallback(run.runId, () => {
          const active = this.store.findActive(run.repoPath)
          if (active !== undefined && active.runId === run.runId) this.pushLog(active, line)
        })
      },
    })
    if (started) this.activeRunId = run.runId
    return started
  }

  private buildPrompt(run: WorkflowRun, segment: WorkflowSegment): string {
    const routingParams: string[] = []
    if (run.module !== undefined && run.module !== '') routingParams.push(`--module ${run.module}`)
    if (run.designOnly) routingParams.push('--stage design')
    else routingParams.push(`--mode ${run.mode}`)
    if (run.changeId !== undefined && run.changeId !== '') routingParams.push(`--change-id ${run.changeId}`)

    if (segment === 0) {
      if (run.mode === 'explore') {
        const sourceMap = (run.sourceRoots ?? [])
          .map(root => `source_root ${JSON.stringify(root.manifestPath)} => ${JSON.stringify(root.path)}`)
        return [
          routingParams.join(' '),
          run.requirement,
          '',
          '[dsh-ub-workflow 控制台指令（优先级高于默认流程）]',
          `workflow_bundle ${JSON.stringify(run.workflowPath ?? '')}`,
          ...sourceMap,
          '用户已在控制台确认探索流程；DSH 宿主已以无 shell 的受控 0e 变体建立 workspace。',
          '不要重复路由、不要运行 knowledge_capture.py / knowledge_registry.py / codegraph 或任何 shell 命令，',
          '不要调用 question 或 task。请使用 read / glob / grep 读取源码和冻结 references，',
          '不得把 workspace 根目录作为 read / glob / grep 的目标；仅可按上面的冻结映射读取明确的物理源码目录与冻结 references，',
          `并且只写 ub-workspace/changes/${run.changeId ?? ''}/exploration_notes.md。`,
          '笔记必须使用“## Domain Exploration”与“## Code Structure”标题，每节写入实质内容，并清楚标注基于文本检索而非 codegraph。',
          '完成探索后直接退出；不得进入主干开发阶段，也不得修改源码或生成 patch。',
        ].filter(line => line !== '').join('\n')
      }
      return [
        routingParams.join(' '),
        run.requirement,
        '',
        '[dsh-ub-workflow 控制台指令（优先级高于默认流程）]',
        '用户已在控制台启动表单中确认 0d 流程计划。请直接从 0e 建立 workspace 开始执行，',
        '只完成 ub-design 的第一次返回：落盘 requirement_analysis.md 草案，给出澄清问题与内容清单草案，',
        '然后在 requirement-clarify 门禁停下。不要继续详细设计。',
      ].filter(line => line !== '').join('\n')
    }

    if (segment === 1) {
      const revision = run.gateResponses?.['design-gate']
      if (revision !== undefined && revision !== '') {
        return [
          '用户未通过 design-gate，并提交以下重新设计指令。请原文透传给同一 ub-design 会话：',
          revision,
          '',
          '这是 ub-design 的条件第三次 resume。更新详细设计、delta spec 与 STC 证据后，',
          '重新提交 design-gate 并停下，不得进入 develop。',
        ].join('\n')
      }
      const response = run.gateResponses?.['requirement-clarify'] ?? ''
      return [
        '用户已回复 requirement-clarify 门禁。请把以下原文作为澄清答案与内容清单修正意见：',
        response,
        '',
        'resume ub-design，定稿 requirement_analysis.md，完成 detailed_design.md、delta spec 与 STC 设计；',
        '提交 design-gate 后停下等待用户确认，不要进入 develop。',
      ].join('\n')
    }

    if (segment === 2) {
      if (run.designOnly) {
        return [
          '用户已在控制台确认 design-gate 通过。',
          '请按 ub-workflow 的只设计流程终止协议生成非空 design_only_summary.md，',
          '总结需求、详细设计、STC 设计与用户确认状态；完成后直接退出，不得进入 develop。',
        ].join('\n')
      }
      const developInputs = run.gateResponses?.['design-gate'] ?? ''
      return [
        '用户已在控制台确认 design-gate 通过，并确认以下 ub-develop 参数（原文）：',
        developInputs,
        '',
        `本次界面冻结的 manifest test_timing：${run.testTimings.join(', ')}。`,
        '继续执行后续全部阶段：develop → test → review → closeout。不得 dispatch ub-verify 或执行部署。',
        '无需再次询问 design-gate；其余自动门禁按 workflow-gates.md 自动推进即可。',
      ].join('\n')
    }

    throw new Error(`unsupported workflow segment ${segment}`)
  }

  private defaultChangeId(module: string | undefined, requirement: string, runId: string): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const slug = requirement
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 4)
      .join('-')
    const mod = module ?? 'auto'
    const unique = runId.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(-6) || 'run'
    return `${`${mod}-${slug || 'change'}-${date}`.slice(0, 73)}-${unique}`
  }

  private pushLog(run: WorkflowRun, line: string): void {
    run.logTail.push(line.slice(0, 1200))
    if (run.logTail.length > this.logTailLimit) run.logTail.splice(0, run.logTail.length - this.logTailLimit)
    this.onLog?.(line)
  }

  private failExploreStep(run: WorkflowRun, error: string, at: string): void {
    const explore = run.steps.find(step => step.id === 'explore')
    if (explore === undefined) {
      attachFailure(run.steps, error, at)
      return
    }
    explore.status = 'failed'
    explore.error = error
    explore.note = error
    explore.finishedAt = at
  }

  private hasFrozenSourceMapping(run: WorkflowRun): run is WorkflowRun & {
    workflowPath: string
    sourceRoots: WorkflowSourceRoot[]
  } {
    return run.workflowPath === this.workflowPath
      && Array.isArray(run.sourceRoots)
      && run.sourceRoots.length > 0
  }

  private requireCurrentSourceMapping(run: WorkflowRun): void {
    if (!this.hasFrozenSourceMapping(run) || run.module === undefined) {
      throw new Error('运行未保存 workflow/source root 映射')
    }
    const current = this.loadCodeRoots(
      this.workflowPath,
      this.sourcePath,
      run.module,
      this.sourceRootOverrides,
    )
    if (!sameSourceRoots(run.sourceRoots, current)) {
      throw new Error('manifest 到物理 source root 的映射已变化')
    }
  }

  private guardCallback(runId: string, callback: () => void): void {
    try {
      callback()
    } catch (error) {
      const run = this.store.get(runId)
      if (run !== undefined) this.failFromInternalError(run, error)
    }
  }

  private guardAsyncCallback(runId: string, callback: () => Promise<void>): void {
    void callback().catch(error => {
      const run = this.store.get(runId)
      if (run !== undefined && run.ownerPid === process.pid && run.status !== 'stopped'
        && this.ownsRunLease(run)) this.failFromInternalError(run, error)
    })
  }

  private asyncRunIsCurrent(
    run: WorkflowRun,
    lease: RunLease,
    statuses: readonly WorkflowRun['status'][],
  ): boolean {
    return this.store.get(run.runId) === run
      && run.ownerPid === process.pid
      && statuses.includes(run.status)
      && this.leases.get(run.runId) === lease
      && isCurrentRunLease(lease)
  }

  private failFromInternalError(run: WorkflowRun, error: unknown): void {
    const message = `工作流内部错误：${error instanceof Error ? error.message : String(error)}`
    const now = new Date().toISOString()
    attachFailure(run.steps, message, now)
    run.status = 'failed'
    run.error = message
    run.finishedAt = now
    try { this.stopProcessFor(run.runId) } catch {}
    try { this.persist(run) } catch (persistError) {
      try { this.onLog?.(`[persist failure] ${persistError instanceof Error ? persistError.message : String(persistError)}`) } catch {}
    }
  }

  private failProtocol(run: WorkflowRun, message: string): void {
    const now = new Date().toISOString()
    attachFailure(run.steps, message, now)
    run.status = 'failed'
    run.error = message
    run.finishedAt = now
    this.stopProcessFor(run.runId)
    this.persist(run)
  }

  private persist(run: WorkflowRun): void {
    run.updatedAt = new Date().toISOString()
    this.store.put(run)
    this.store.persist(run.repoPath)
    if ((run.status === 'done' || run.status === 'failed' || run.status === 'stopped') && !this.runner.running) {
      const lease = this.leases.get(run.runId)
      if (lease !== undefined && releaseRunLease(lease)) this.leases.delete(run.runId)
    }
  }

  private restoreRun(run: WorkflowRun, snapshot: WorkflowRun): void {
    const target = run as unknown as Record<string, unknown>
    for (const key of Object.keys(target)) delete target[key]
    Object.assign(target, snapshot)
    this.store.put(run)
  }

  private failUnsupportedWorkflow(run: WorkflowRun): false {
    const error = UNSUPPORTED_WORKFLOW_MESSAGE
    const now = new Date().toISOString()
    attachFailure(run.steps, error, now)
    run.status = 'failed'
    run.error = error
    run.finishedAt = now
    this.stopProcessFor(run.runId)
    this.persist(run)
    return false
  }

  private releaseTerminalLeaseIfStopped(runId: string): void {
    if (this.runner.running) return
    const run = this.store.get(runId)
    if (run === undefined || (run.status !== 'done' && run.status !== 'failed' && run.status !== 'stopped')) return
    const lease = this.leases.get(runId)
    if (lease !== undefined && releaseRunLease(lease)) this.leases.delete(runId)
  }

  private ensureRunLease(run: WorkflowRun): boolean {
    const current = this.leases.get(run.runId)
    if (current !== undefined) {
      if (isCurrentRunLease(current)) return true
      this.leases.delete(run.runId)
      this.stopProcessFor(run.runId)
      return false
    }
    if (run.changeId === undefined) return false
    const adopted = adoptRunLease(run.repoPath, run.changeId, run.runId)
    if (adopted !== undefined) {
      this.leases.set(run.runId, adopted)
      return true
    }
    const claimed = claimRunLease(run.repoPath, run.changeId, run.runId)
    if (!claimed.ok) return false
    run.ownerPid = process.pid
    this.leases.set(run.runId, claimed.lease)
    return true
  }

  private ownsRunLease(run: WorkflowRun): boolean {
    const lease = this.leases.get(run.runId)
    if (lease !== undefined && isCurrentRunLease(lease)) return true
    if (lease !== undefined) this.leases.delete(run.runId)
    this.stopProcessFor(run.runId)
    return false
  }

  private stopProcessFor(runId: string): void {
    if (this.activeRunId !== runId) return
    this.activeRunId = undefined
    this.runner.stop()
  }
}
