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
  | 'design'
  | 'design-gate'
  | 'develop'
  | 'develop.implement'
  | 'develop.patch'
  | 'develop.pre-review'
  | 'develop.compile'
  | 'test'
  | 'review'
  | 'verify'
  | 'deploy-ok'
  | 'closeout'
  | 'explore'

export type RunMode = 'dev' | 'full' | 'explore'
export type StageOption = 'design-only'

/** A hard user gate owned by the plugin (confirmation flows through the UI). */
export type UserGateId = 'routing-plan' | 'design-gate' | 'deploy-ok'

/** One detected write-back (resume/rollback) of a completed step. */
export interface StepWriteback {
  /** 1-based write-back sequence for the step. */
  seq: number
  at: string
  /** Human-readable reason inferred from the regenerated artifact plus recent opencode output. */
  reason: string
  /** Latest matched artifact mtime that triggered the detection (epoch ms). */
  mtimeMs: number
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
  /** Summary of what the step produced (filled once the step completes). */
  result?: string
  /** Absolute directory holding this step's main artifacts. */
  outputDir?: string
  /** Detected write-backs (resume/rollback) of this step after its first completion. */
  writebacks?: StepWriteback[]
}

export interface WorkflowRun {
  runId: string
  repoPath: string
  sessionId?: string
  changeId?: string
  module?: string
  mode: RunMode
  /** Design-only runs finish after the design gate. */
  designOnly: boolean
  deploy: boolean
  requirement: string
  status: RunStatus
  steps: WorkflowStep[]
  /** Which opencode segment the engine is currently in (see runner). */
  segment: 0 | 1 | 2
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