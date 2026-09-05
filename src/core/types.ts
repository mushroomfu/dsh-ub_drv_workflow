/**
 * Framework-free workflow types shared by the host engine, the core logic,
 * and (after serialization) the browser client.
 */

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'done'
  | 'failed'
  | 'skipped'

export type RunStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'done'
  | 'failed'
  | 'stopped'

/** Stable semantic step ids (not translated, stored in state files). */
export type StepId =
  | 'routing-plan'
  | 'requirement'
  | 'requirement-clarify'
  | 'design'
  | 'design-gate'
  | 'design-summary'
  | 'develop'
  | 'develop.implement'
  | 'develop.patch'
  | 'develop.pre-review'
  | 'develop.compile'
  | 'test.pre-dev'
  | 'test.post-dev'
  | 'test.regression'
  | 'review'
  | 'deploy-authorize'
  | 'verify-deploy'
  | 'verify'
  | 'deploy-ok'
  | 'verify-stc'
  | 'closeout'
  | 'explore'

export type RunMode = 'dev' | 'full' | 'explore'
export type StageOption = 'design-only'
export type TestTiming = 'pre-dev' | 'post-dev' | 'regression'
export type WorkflowSegment = 0 | 1 | 2 | 3 | 4

/** A hard user gate owned by the plugin (confirmation flows through the UI). */
export type UserGateId = 'routing-plan' | 'requirement-clarify' | 'design-gate' | 'deploy-authorize' | 'deploy-ok'

export type GateInteraction = 'confirm' | 'response'

export interface WorkflowArtifactPreview {
  path: string
  content: string
  size: number
  truncated: boolean
}

/** One portable manifest code_root frozen to the physical source directory used by a run. */
export interface WorkflowSourceRoot {
  manifestPath: string
  path: string
}

export interface WorkflowStep {
  /** Stable semantic id, serialized to disk. */
  id: StepId
  title: string
  description: string
  status: StepStatus
  /** True when the step requires a user decision (hard gate) before the next one may run. */
  needsUser: boolean
  /** Gate identity for gates the plugin itself confirms and forwards to opencode. */
  gate?: UserGateId
  /** Whether the gate needs a simple decision or a written user response. */
  interaction?: GateInteraction
  /**
   * Artifacts (relative to the run's change workspace) that mark the step as
   * complete. Multiple paths are AND-ed; `*` globs match any file directly
   * under that directory.
   */
  artifactHints: string[]
  substeps?: WorkflowStep[]
  startedAt?: string
  finishedAt?: string
  note?: string
  error?: string
  /** Canonical durable event that currently authorizes this step status. */
  evidenceId?: string
  /** Additional terminal events that must remain valid with `evidenceId`. */
  supportingEvidenceIds?: string[]
}

export interface WorkflowRun {
  runId: string
  /** Host process that owns mutations for this live run. */
  ownerPid?: number
  /** Exact session id emitted by OpenCode; absent until the fresh run starts. */
  opencodeSessionId?: string
  repoPath: string
  /** Immutable workflow bundle checkout that supplied agents, skills, references, and the manifest. */
  workflowPath?: string
  /** Physical source directories resolved from the selected module manifest. */
  sourceRoots?: WorkflowSourceRoot[]
  sessionId?: string
  changeId?: string
  module?: string
  mode: RunMode
  /** Design-only runs finish after the confirmed design summary is written. */
  designOnly: boolean
  deploy: boolean
  /** Manifest test timings frozen at launch so the visible chain stays auditable. */
  testTimings: TestTiming[]
  requirement: string
  status: RunStatus
  steps: WorkflowStep[]
  /** Which opencode segment the engine is currently in (see runner). */
  segment: WorkflowSegment
  /** Explore-only Git baseline used to verify that source stayed read-only. */
  sourceFingerprint?: string
  /** Gate-time signature of a pre-existing design-only summary, or `absent`. */
  designSummaryBaseline?: string
  /** Durable user answers forwarded when a hard gate resumes the opencode session. */
  gateResponses?: Partial<Record<UserGateId, string>>
  /** Durable event id that was current when a user confirmed each evidence-bound gate. */
  gateEvidence?: Partial<Record<UserGateId, string[]>>
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  pid?: number
  exitCode?: number | null
  /** Tail of the opencode output. */
  logTail: string[]
  /** Last error summary shown on the failed step. */
  error?: string
}

export interface RunInput {
  runId?: string
  repoPath: string
  sessionId?: string
  changeId?: string
  module?: string
  requirement: string
  mode: RunMode
  designOnly?: boolean
  deploy?: boolean
}

/** JSON-safe snapshot returned by the loopback state route. */
export interface WorkflowStateSnapshot {
  repoPath: string
  activeRun: WorkflowRun | null
  runs: Array<{
    runId: string
    createdAt: string
    status: RunStatus
    mode: RunMode
    changeId?: string
    module?: string
  }>
}
