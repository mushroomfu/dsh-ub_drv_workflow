/**
 * WorkflowStore: authoritative in-memory run registry with JSON persistence
 * under `<repo>/ub-workspace/.dsh-ub-workflow/runs.json`, which the upstream
 * repository already excludes from source control.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { isSafeWorkflowId } from './core/ids.ts'
import { buildStageChain, STEP_META } from './core/stages.ts'
import { isSupportedWorkflowIntent, UNSUPPORTED_WORKFLOW_MESSAGE } from './core/supportPolicy.ts'
import type { TestTiming, WorkflowRun, WorkflowStateSnapshot, WorkflowStep } from './core/types.ts'
import { loadModuleTestTimings } from './moduleManifest.ts'
import { adoptRunLease, hasLiveRunLease, releaseRunLease } from './runLease.ts'
import { processStartIdentity } from './processIdentity.ts'

const RUNS_FILE = 'runs.json'
const DIR_NAME = '.dsh-ub-workflow'
const STATE_VERSION = 2
const MAX_STATE_BYTES = 5 * 1024 * 1024
const MAX_PERSISTED_RUNS = 100
const STORE_LOCK = 'persist.lock'
const STORE_LOCK_OWNER = 'owner.json'
const MAX_STORE_LOCK_OWNER_BYTES = 4_096
const RUN_STATUSES = new Set(['idle', 'running', 'waiting_user', 'done', 'failed', 'stopped'])
const STEP_STATUSES = new Set(['pending', 'running', 'waiting_user', 'done', 'failed', 'skipped'])
const RUN_MODES = new Set(['dev', 'full', 'explore'])
const STEP_IDS = new Set(Object.keys(STEP_META))
const GATE_IDS = new Set(['routing-plan', 'requirement-clarify', 'design-gate', 'deploy-authorize', 'deploy-ok'])
const TEST_TIMINGS = new Set(['pre-dev', 'post-dev', 'regression'])
const TEST_TIMING_ORDER: readonly TestTiming[] = ['pre-dev', 'post-dev', 'regression']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pathAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

function isOptionalString(value: unknown, maxLength = 20_000): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isAbsolutePersistedPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/.test(value)
    && (isAbsolute(value) || win32.isAbsolute(value))
}

function hasValidPersistedSourceScope(value: Record<string, unknown>): boolean {
  if (value.workflowPath === undefined && value.sourceRoots === undefined) return true
  if (!isAbsolutePersistedPath(value.workflowPath)
    || !Array.isArray(value.sourceRoots)
    || value.sourceRoots.length === 0
    || value.sourceRoots.length > 16) return false
  const manifestPaths = new Set<string>()
  const physicalPaths = new Set<string>()
  for (const root of value.sourceRoots) {
    if (!isRecord(root)
      || typeof root.manifestPath !== 'string'
      || root.manifestPath.length === 0
      || root.manifestPath.length > 512
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(root.manifestPath)
      || root.manifestPath.includes('//')
      || root.manifestPath.split('/').some(segment => segment === '.' || segment === '..')
      || !isAbsolutePersistedPath(root.path)) return false
    const manifestKey = root.manifestPath.toLowerCase()
    const physicalKey = process.platform === 'win32' ? root.path.toLowerCase() : root.path
    if (manifestPaths.has(manifestKey) || physicalPaths.has(physicalKey)) return false
    manifestPaths.add(manifestKey)
    physicalPaths.add(physicalKey)
  }
  return true
}

function isPersistedStep(value: unknown, depth = 0): value is WorkflowStep {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !STEP_IDS.has(value.id)
    || typeof value.title !== 'string'
    || value.title.length > 500
    || typeof value.description !== 'string'
    || value.description.length > 2_000
    || typeof value.status !== 'string'
    || !STEP_STATUSES.has(value.status)
    || typeof value.needsUser !== 'boolean'
    || !Array.isArray(value.artifactHints)
    || value.artifactHints.length > 32
    || !value.artifactHints.every(hint => typeof hint === 'string' && hint.length <= 512)
    || !isOptionalString(value.note, 2_000)
    || !isOptionalString(value.error, 2_000)
    || (value.evidenceId !== undefined
      && (typeof value.evidenceId !== 'string' || !/^ke-[0-9a-f]{24}$/.test(value.evidenceId)))
    || (value.supportingEvidenceIds !== undefined
      && (!Array.isArray(value.supportingEvidenceIds)
        || value.supportingEvidenceIds.length > 8
        || !value.supportingEvidenceIds.every(id => typeof id === 'string' && /^ke-[0-9a-f]{24}$/.test(id))))
    || (value.startedAt !== undefined && !isTimestamp(value.startedAt))
    || (value.finishedAt !== undefined && !isTimestamp(value.finishedAt))
    || (value.gate !== undefined && (typeof value.gate !== 'string' || !GATE_IDS.has(value.gate)))
    || (value.interaction !== undefined && value.interaction !== 'confirm' && value.interaction !== 'response')) {
    return false
  }
  if (value.substeps === undefined) return true
  return depth === 0
    && Array.isArray(value.substeps)
    && value.substeps.length <= 16
    && value.substeps.every(step => isPersistedStep(step, depth + 1))
}

function hasCanonicalTestTimings(value: Record<string, unknown>): value is Record<string, unknown> & { testTimings: TestTiming[] } {
  if (!Array.isArray(value.testTimings)
    || !value.testTimings.every(timing => typeof timing === 'string' && TEST_TIMINGS.has(timing))) return false
  const timings = value.testTimings as TestTiming[]
  if (new Set(timings).size !== timings.length) return false
  if (timings.some((timing, index) => TEST_TIMING_ORDER.indexOf(timing) <= TEST_TIMING_ORDER.indexOf(timings[index - 1]!))) {
    return false
  }
  const noTests = value.mode === 'explore' || value.designOnly === true
  return noTests ? timings.length === 0 : timings.includes('post-dev')
}

function sameStepShape(actual: WorkflowStep, canonical: WorkflowStep): boolean {
  const sameHints = actual.artifactHints.length === canonical.artifactHints.length
    && actual.artifactHints.every((hint, index) => hint === canonical.artifactHints[index])
  const actualChildren = actual.substeps ?? []
  const canonicalChildren = canonical.substeps ?? []
  return actual.id === canonical.id
    && actual.title === canonical.title
    && actual.description === canonical.description
    && actual.needsUser === canonical.needsUser
    && actual.gate === canonical.gate
    && actual.interaction === canonical.interaction
    && sameHints
    && actualChildren.length === canonicalChildren.length
    && actualChildren.every((step, index) => sameStepShape(step, canonicalChildren[index]!))
}

function isPersistedRun(value: unknown, repoPath: string): value is WorkflowRun {
  if (!isRecord(value)
    || !isSafeWorkflowId(value.runId)
    || value.repoPath !== repoPath
    || !hasValidPersistedSourceScope(value)
    || typeof value.requirement !== 'string'
    || value.requirement.length > 20_000
    || typeof value.mode !== 'string'
    || !RUN_MODES.has(value.mode)
    || typeof value.designOnly !== 'boolean'
    || typeof value.deploy !== 'boolean'
    || (value.deploy === true && value.mode !== 'full')
    || !hasCanonicalTestTimings(value)
    || typeof value.status !== 'string'
    || !RUN_STATUSES.has(value.status)
    || !Number.isInteger(value.segment)
    || (value.segment as number) < 0
    || (value.segment as number) > 4
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || (value.startedAt !== undefined && !isTimestamp(value.startedAt))
    || (value.finishedAt !== undefined && !isTimestamp(value.finishedAt))
    || !isOptionalString(value.sessionId, 256)
    || (value.changeId !== undefined && !isSafeWorkflowId(value.changeId))
    || !isOptionalString(value.module, 64)
    || (value.opencodeSessionId !== undefined
      && (!isSafeWorkflowId(value.opencodeSessionId) || !value.opencodeSessionId.startsWith('ses_')))
    || (value.pid !== undefined && (!Number.isInteger(value.pid) || (value.pid as number) <= 0))
    || (value.ownerPid !== undefined && (!Number.isInteger(value.ownerPid) || (value.ownerPid as number) <= 0))
    || (value.exitCode !== undefined && value.exitCode !== null && !Number.isInteger(value.exitCode))
    || (value.sourceFingerprint !== undefined
      && (value.mode !== 'explore' || typeof value.sourceFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(value.sourceFingerprint)))
    || (value.designSummaryBaseline !== undefined
      && (value.designOnly !== true || typeof value.designSummaryBaseline !== 'string'
        || (value.designSummaryBaseline !== 'absent'
          && !/^\d+:[0-9a-f]{64}$/.test(value.designSummaryBaseline))))
    || !isOptionalString(value.error, 2_000)
    || !Array.isArray(value.logTail)
    || !value.logTail.every(line => typeof line === 'string')
    || !Array.isArray(value.steps)
    || value.steps.length === 0
    || value.steps.length > 32
    || !value.steps.every(step => isPersistedStep(step))) {
    return false
  }
  const canonical = buildStageChain({
    mode: value.mode as WorkflowRun['mode'],
    designOnly: value.designOnly as boolean,
    deploy: value.deploy as boolean,
    testTimings: value.testTimings,
  })
  if ((value.steps as WorkflowStep[]).length !== canonical.length
    || !(value.steps as WorkflowStep[]).every((step, index) => sameStepShape(step, canonical[index]!))) return false
  const canonicalGates = new Set<string>(canonical.flatMap(step => step.gate === undefined ? [] : [step.gate]))
  if (value.gateResponses !== undefined) {
    if (!isRecord(value.gateResponses)) return false
    for (const [gate, response] of Object.entries(value.gateResponses)) {
      if (!GATE_IDS.has(gate) || !canonicalGates.has(gate)
        || typeof response !== 'string' || response.length > 20_000) return false
    }
  }
  if (value.gateEvidence !== undefined) {
    if (!isRecord(value.gateEvidence)) return false
    for (const [gate, eventIds] of Object.entries(value.gateEvidence)) {
      if (!GATE_IDS.has(gate) || !canonicalGates.has(gate)
        || !Array.isArray(eventIds)
        || eventIds.length > 8
        || !eventIds.every(id => typeof id === 'string' && /^ke-[0-9a-f]{24}$/.test(id))) return false
    }
  }
  if (value.pendingQuestion !== undefined) {
    const request = value.pendingQuestion
    if (!isRecord(request)
      || typeof request.requestId !== 'string' || !/^que[A-Za-z0-9_-]{1,124}$/.test(request.requestId)
      || typeof request.ownerSessionId !== 'string' || !request.ownerSessionId.startsWith('ses')
      || typeof request.rootSessionId !== 'string' || !request.rootSessionId.startsWith('ses')
      || !Number.isInteger(request.segment) || (request.segment as number) < 0 || (request.segment as number) > 4
      || !Number.isInteger(request.generation) || (request.generation as number) < 1
      || !Array.isArray(request.questions) || request.questions.length === 0 || request.questions.length > 3
      || !isTimestamp(request.askedAt)) return false
    for (const question of request.questions) {
      if (!isRecord(question)
        || typeof question.header !== 'string' || question.header.trim() === '' || question.header.length > 30
        || typeof question.question !== 'string' || question.question.trim() === '' || question.question.length > 4_096
        || typeof question.multiple !== 'boolean'
        || typeof question.custom !== 'boolean'
        || !Array.isArray(question.options) || question.options.length > 20
        || !question.options.every(option => isRecord(option)
          && typeof option.label === 'string' && option.label.trim() !== '' && option.label.length <= 256
          && typeof option.description === 'string' && option.description.length <= 2_000)) return false
      const labels = question.options.map(option => (option as { label: string }).label)
      if ((question.custom === false && labels.length === 0) || new Set(labels).size !== labels.length) return false
    }
  }
  return true
}

function stateDirOf(repoPath: string): string {
  return join(repoPath, 'ub-workspace', DIR_NAME)
}

function stateFileOf(repoPath: string): string {
  return join(stateDirOf(repoPath), RUNS_FILE)
}

function legacyStateFileOf(repoPath: string): string {
  return join(repoPath, DIR_NAME, RUNS_FILE)
}

function ensureRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`)
}

function ensureSafeStateDirectory(repoPath: string): string {
  const workspace = join(repoPath, 'ub-workspace')
  ensureRealDirectory(workspace, 'ub-workspace')
  const stateDir = stateDirOf(repoPath)
  ensureRealDirectory(stateDir, 'workflow state directory')
  return stateDir
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isReadableStateFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0
  } catch {
    return false
  }
}

function copyStepState(target: WorkflowStep, source: Record<string, unknown>): void {
  const record = target as unknown as Record<string, unknown>
  for (const key of ['status', 'startedAt', 'finishedAt', 'note', 'error', 'evidenceId'] as const) {
    if (source[key] !== undefined) record[key] = source[key]
  }
  if (Array.isArray(source.supportingEvidenceIds)) {
    target.supportingEvidenceIds = source.supportingEvidenceIds.filter(id => typeof id === 'string') as string[]
  }
}

/** Explicit migration for the pre-timing, single-test state schema. */
function migrateV1Run(value: unknown, repoPath: string): unknown {
  if (!isRecord(value) || value.repoPath !== repoPath) return value
  let timings: TestTiming[] = ['post-dev']
  try {
    timings = loadModuleTestTimings(repoPath, typeof value.module === 'string' ? value.module : undefined)
  } catch {
    // v1 represented only one generic test. When its checkout is no longer
    // readable, map that evidence to post-dev and do not invent other timings.
  }
  const mode = value.mode === 'full' || value.mode === 'explore' ? value.mode : 'dev'
  const designOnly = value.designOnly === true
  const deploy = value.deploy === true
  const migratedSteps = buildStageChain({ mode, designOnly, deploy, testTimings: timings })
  const oldSteps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : []
  for (const step of migratedSteps) {
    const oldId = step.id === 'test.post-dev'
      ? 'test'
      : step.id === 'deploy-authorize'
        ? 'deploy-ok'
        : step.id
    const source = oldSteps.find(candidate => candidate.id === oldId)
    if (source === undefined) continue
    copyStepState(step, source)
    if (step.substeps === undefined || !Array.isArray(source.substeps)) continue
    for (const substep of step.substeps) {
      const oldSubstep = source.substeps.find(candidate => isRecord(candidate) && candidate.id === substep.id)
      if (isRecord(oldSubstep)) copyStepState(substep, oldSubstep)
    }
  }
  const gateEvidence = isRecord(value.gateEvidence)
    ? Object.fromEntries(Object.entries(value.gateEvidence).map(([gate, ids]) => [
        gate === 'deploy-ok' ? 'deploy-authorize' : gate,
        Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [],
      ]))
    : undefined
  const gateResponses = isRecord(value.gateResponses)
    ? Object.fromEntries(Object.entries(value.gateResponses).map(([gate, response]) => [
        gate === 'deploy-ok' ? 'deploy-authorize' : gate,
        response,
      ]))
    : undefined
  return { ...value, testTimings: timings, steps: migratedSteps, gateEvidence, gateResponses }
}

function readableStateFileOf(repoPath: string): string | undefined {
  const workspace = join(repoPath, 'ub-workspace')
  const currentDir = stateDirOf(repoPath)
  const currentFile = stateFileOf(repoPath)
  if (isRealDirectory(workspace) && isRealDirectory(currentDir) && isReadableStateFile(currentFile)) return currentFile

  const legacyDir = join(repoPath, DIR_NAME)
  const legacyFile = legacyStateFileOf(repoPath)
  if (isRealDirectory(legacyDir) && isReadableStateFile(legacyFile)) return legacyFile
  return undefined
}

interface StoreLock {
  path: string
  owner: { pid: number; processIdentity: string; token: string; createdAt: string }
}

interface StoreLockOwner {
  pid: number
  processIdentity: string
  token: string
  createdAt: string
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readStableBoundedFile(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined
  try {
    const linked = lstatSync(path)
    if (!linked.isFile() || linked.isSymbolicLink() || linked.size <= 0 || linked.size > maxBytes) return undefined
    const noFollow = 'O_NOFOLLOW' in fsConstants
      ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
      : 0
    const nonblock = 'O_NONBLOCK' in fsConstants
      ? (fsConstants as typeof fsConstants & { O_NONBLOCK: number }).O_NONBLOCK
      : 0
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonblock)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== linked.size || before.dev !== linked.dev || before.ino !== linked.ino
      || before.size <= 0 || before.size > maxBytes) return undefined
    const data = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset)
      if (count === 0) return undefined
      offset += count
    }
    const after = fstatSync(fd)
    const linkedAfter = lstatSync(path)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || linkedAfter.isSymbolicLink() || !linkedAfter.isFile()
      || linkedAfter.dev !== after.dev || linkedAfter.ino !== after.ino) return undefined
    return data
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * Read the lock owner through a no-follow descriptor with a strict bound.
 * This prevents a competing workspace from blocking the host on a FIFO,
 * redirecting the read through a swapped symlink, or forcing an unbounded
 * allocation with an oversized file.
 */
function readStoreLockOwner(path: string): StoreLockOwner | undefined {
  try {
    const data = readStableBoundedFile(path, MAX_STORE_LOCK_OWNER_BYTES)
    if (data === undefined) return undefined
    const value: unknown = JSON.parse(data.toString('utf8'))
    if (!isRecord(value)
      || !Number.isInteger(value.pid) || (value.pid as number) <= 0
      || typeof value.processIdentity !== 'string' || value.processIdentity.length < 3 || value.processIdentity.length > 256
      || typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 256
      || !isTimestamp(value.createdAt)) return undefined
    return value as unknown as StoreLockOwner
  } catch {
    return undefined
  }
}

function acquireStoreLock(dir: string): StoreLock {
  const path = join(dir, STORE_LOCK)
  const create = (): StoreLock => {
    const processIdentity = processStartIdentity(process.pid)
    if (processIdentity === undefined) throw new Error('could not determine DSH host process identity')
    const owner = {
      pid: process.pid,
      processIdentity,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const staging = join(dir, `.persist-lock-new-${owner.token}`)
    try {
      mkdirSync(staging, { mode: 0o700 })
      writeFileSync(join(staging, STORE_LOCK_OWNER), JSON.stringify(owner), {
        mode: 0o600,
        flag: 'wx',
      })
      renameSync(staging, path)
      return { path, owner }
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }) } catch {}
      throw error
    }
  }

  try {
    return create()
  } catch (error) {
    if (!pathAlreadyExists(error)) throw error
  }

  const owner = readStoreLockOwner(join(path, STORE_LOCK_OWNER))
  if (owner === undefined) throw new Error('workflow state lock owner is incomplete or unsafe')
  const currentIdentity = processStartIdentity(owner.pid)
  const stale = !processAlive(owner.pid)
    || (currentIdentity !== undefined && currentIdentity !== owner.processIdentity)
  if (!stale) throw new Error('workflow state is being persisted by another host process')
  // Retain the token-addressed, non-empty tombstone. A delayed stale
  // contender cannot rename a newly published lock onto this same target.
  const quarantine = join(dir, `.stale-store-lock-${owner.token}`)
  try {
    renameSync(path, quarantine)
  } catch {
    throw new Error('workflow state lock changed during recovery')
  }
  try {
    return create()
  } catch (error) {
    if (pathAlreadyExists(error)) {
      throw new Error('workflow state is being persisted by another host process')
    }
    throw error
  }
}

function releaseStoreLock(lock: StoreLock): void {
  try {
    const ownerFile = join(lock.path, STORE_LOCK_OWNER)
    const current = readStoreLockOwner(ownerFile)
    if (current === undefined) return
    if (current.pid !== lock.owner.pid
      || current.processIdentity !== lock.owner.processIdentity
      || current.token !== lock.owner.token
      || current.createdAt !== lock.owner.createdAt) return
    const released = join(dirname(lock.path), `.released-store-lock-${lock.owner.token}-${randomUUID()}`)
    renameSync(lock.path, released)
    rmSync(released, { recursive: true, force: false })
  } catch {}
}

function parseDiskRunsForMerge(repoPath: string): WorkflowRun[] {
  let file = stateFileOf(repoPath)
  try {
    lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const legacyDir = join(repoPath, DIR_NAME)
    const legacyFile = legacyStateFileOf(repoPath)
    try {
      lstatSync(legacyFile)
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw legacyError
    }
    if (!isRealDirectory(legacyDir)) throw new Error('legacy workflow state directory is unsafe')
    file = legacyFile
  }
  const data = readStableBoundedFile(file, MAX_STATE_BYTES)
  if (data === undefined) throw new Error('workflow state file is unsafe, empty, unstable, or oversized')
  const parsed = JSON.parse(data.toString('utf8')) as { version?: number; runs?: unknown[] }
  if (parsed.version !== 1 && parsed.version !== STATE_VERSION) {
    throw new Error(`unsupported state version ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.runs) || parsed.runs.length > MAX_PERSISTED_RUNS) throw new Error('invalid persisted runs array')
  const runIds = new Set<string>()
  return parsed.runs.map(raw => {
    const run = (parsed.version === 1 ? migrateV1Run(raw, repoPath) : raw) as WorkflowRun
    if (!isPersistedRun(run, repoPath)) throw new Error('state contains an invalid run record')
    if (runIds.has(run.runId)) throw new Error(`state contains duplicate run id ${run.runId}`)
    runIds.add(run.runId)
    return { ...run, logTail: [] }
  })
}

export class WorkflowStore {
  private readonly runs = new Map<string, WorkflowRun>()
  private readonly deleted = new Set<string>()
  private readonly dirty = new Set<string>()
  private readonly knownPersisted = new Set<string>()
  private readonly persistedRevisions = new Map<string, string>()
  private readonly localRevisions = new Map<string, number>()

  private recordKey(repoPath: string, runId: string): string {
    return `${repoPath}\0${runId}`
  }

  /** Load all persisted runs for a repo (idempotent; later repos add on demand). */
  loadRepo(repoPath: string): void {
    const file = readableStateFileOf(repoPath)
    if (file === undefined) return
    try {
      const data = readStableBoundedFile(file, MAX_STATE_BYTES)
      if (data === undefined) throw new Error('state file is unsafe, empty, unstable, or oversized')
      const parsed = JSON.parse(data.toString('utf8')) as { version?: number; runs?: unknown[] }
      if (parsed.version !== 1 && parsed.version !== STATE_VERSION) {
        throw new Error(`unsupported state version ${String(parsed.version)}`)
      }
      if (!Array.isArray(parsed.runs)) throw new Error('state has no runs array')
      if (parsed.runs.length > MAX_PERSISTED_RUNS) throw new Error(`state has more than ${MAX_PERSISTED_RUNS} runs`)
      const recoveredRunIds = new Set<string>()
      const loaded: WorkflowRun[] = []
      const runIds = new Set<string>()
      const observedRevisions = new Map<string, string>()
      for (const raw of parsed.runs) {
        const run = (parsed.version === 1 ? migrateV1Run(raw, repoPath) : raw) as WorkflowRun
        if (!isPersistedRun(run, repoPath)) throw new Error('state contains an invalid run record')
        if (runIds.has(run.runId) || (this.runs.has(run.runId) && this.runs.get(run.runId)?.repoPath !== repoPath)) {
          throw new Error(`state contains duplicate run id ${run.runId}`)
        }
        runIds.add(run.runId)
        observedRevisions.set(run.runId, run.updatedAt)
        // Telemetry is deliberately process-local; discard tails written by
        // older plugin versions instead of replaying or re-persisting them.
        run.logTail = []
        const legacy = run as unknown as Record<string, unknown>
        const hadPendingQuestion = legacy.pendingQuestion !== undefined
        const active = run.status === 'running' || run.status === 'idle' || run.status === 'waiting_user'
        const liveOwner = active && hasLiveRunLease(repoPath, run.runId)
        const unsupportedIntent = active && !isSupportedWorkflowIntent(run)
        const missingSourceScope = active && run.mode === 'explore'
          && (run.workflowPath === undefined || run.sourceRoots === undefined || run.sourceRoots.length === 0)
        const unsupportedActive = unsupportedIntent || missingSourceScope || (active && hadPendingQuestion)
        // Never adopt a lease for an execution profile this build cannot run.
        const currentOwner = unsupportedActive || run.changeId === undefined
          ? undefined
          : adoptRunLease(repoPath, run.changeId, run.runId)
        if (unsupportedActive) {
          const now = new Date().toISOString()
          run.status = 'failed'
          run.error = unsupportedIntent
            ? UNSUPPORTED_WORKFLOW_MESSAGE
            : missingSourceScope
              ? '活动 Explore 记录缺少 workflow/source root 冻结映射；请重新启动工作流'
            : '当前版本不接受 OpenCode 运行时动态问题；请通过固定 DSH 门禁重新启动工作流'
          run.finishedAt = now
          run.updatedAt = now
          delete legacy.pendingQuestion
          // Avoid overwriting another healthy host's state. This reader still
          // presents the unsupported run as failed and never adopts its lease.
          if (!liveOwner) recoveredRunIds.add(run.runId)
        } else if (liveOwner && currentOwner === undefined) {
          // A different healthy DSH host owns this run. Keep its serialized
          // state read-only and let periodic refreshes import later progress.
        } else if ((active || hadPendingQuestion) && !liveOwner) {
          const now = new Date().toISOString()
          run.status = 'failed'
          run.error = 'DSH 宿主重启后原 opencode 进程已失联，请重新启动工作流'
          run.finishedAt = now
          run.updatedAt = now
          delete legacy.pendingQuestion
          recoveredRunIds.add(run.runId)
        } else if (hadPendingQuestion) {
          delete legacy.pendingQuestion
          recoveredRunIds.add(run.runId)
        }
        if (parsed.version === 1 && !liveOwner) recoveredRunIds.add(run.runId)
        loaded.push(run)
      }
      for (const [runId, run] of this.runs) {
        if (run.repoPath === repoPath) {
          this.runs.delete(runId)
          this.localRevisions.delete(runId)
          this.dirty.delete(this.recordKey(repoPath, runId))
          this.knownPersisted.delete(this.recordKey(repoPath, runId))
          this.persistedRevisions.delete(this.recordKey(repoPath, runId))
        }
      }
      for (const run of loaded) {
        this.runs.set(run.runId, run)
        this.localRevisions.set(run.runId, Date.parse(run.updatedAt))
        this.knownPersisted.add(this.recordKey(repoPath, run.runId))
        this.persistedRevisions.set(this.recordKey(repoPath, run.runId), observedRevisions.get(run.runId)!)
        if (recoveredRunIds.has(run.runId)) this.dirty.add(this.recordKey(repoPath, run.runId))
      }
      if (recoveredRunIds.size > 0) this.persist(repoPath)
    } catch (error) {
      throw new Error(`无法安全加载工作流状态 ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  persist(repoPath: string): void {
    const dir = ensureSafeStateDirectory(repoPath)
    const lock = acquireStoreLock(dir)
    try {
      const merged = new Map(parseDiskRunsForMerge(repoPath).map(run => [run.runId, run]))
      for (const run of this.listForRepo(repoPath)) {
        const key = this.recordKey(repoPath, run.runId)
        if (!this.dirty.has(key)) continue
        const disk = merged.get(run.runId)
        const observedRevision = this.persistedRevisions.get(key)
        if (disk === undefined && (this.knownPersisted.has(key) || observedRevision !== undefined)) {
          throw new Error(`workflow run ${run.runId} was deleted by another host process`)
        }
        if (disk !== undefined && observedRevision !== undefined && disk.updatedAt !== observedRevision) {
          throw new Error(`workflow run ${run.runId} was updated by another host process`)
        }
        if (disk !== undefined && disk.updatedAt === run.updatedAt
          && JSON.stringify({ ...disk, logTail: [] }) !== JSON.stringify({ ...run, logTail: [] })) {
          throw new Error(`conflicting workflow state for run ${run.runId}`)
        }
        merged.set(run.runId, { ...run, logTail: [] })
      }
      for (const key of this.deleted) {
        const [deletedRepo, runId] = key.split('\0')
        if (deletedRepo === repoPath && runId !== undefined) merged.delete(runId)
      }
      const repoRuns = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      if (repoRuns.length > MAX_PERSISTED_RUNS) {
        throw new Error(`工作流历史已达 ${MAX_PERSISTED_RUNS} 条，请先删除不再需要的历史记录`)
      }
      const payload = { version: STATE_VERSION, updatedAt: new Date().toISOString(), runs: repoRuns }
      const serialized = JSON.stringify(payload, null, 2)
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
        throw new Error('工作流状态已达到 5 MiB 安全上限，请先删除不再需要的历史记录')
      }
      const target = stateFileOf(repoPath)
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error('workflow state file must not be a symbolic link')
      }
      const temporary = join(dir, `${RUNS_FILE}.${process.pid}.${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        renameSync(temporary, target)
      } catch (error) {
        try { unlinkSync(temporary) } catch {}
        throw error
      }
      const mergedIds = new Set(repoRuns.map(run => run.runId))
      for (const [runId, run] of [...this.runs]) {
        if (run.repoPath !== repoPath) continue
        const key = this.recordKey(repoPath, runId)
        if (!mergedIds.has(runId) && !this.dirty.has(key)) this.runs.delete(runId)
      }
      for (const run of repoRuns) {
        const key = this.recordKey(repoPath, run.runId)
        if (!this.dirty.has(key)) this.runs.set(run.runId, run)
        this.localRevisions.set(run.runId, Math.max(this.localRevisions.get(run.runId) ?? 0, Date.parse(run.updatedAt)))
        this.knownPersisted.add(key)
        this.persistedRevisions.set(key, run.updatedAt)
        this.dirty.delete(key)
      }
      for (const key of [...this.deleted]) {
        if (!key.startsWith(`${repoPath}\0`)) continue
        this.deleted.delete(key)
        this.knownPersisted.delete(key)
        this.persistedRevisions.delete(key)
        this.dirty.delete(key)
      }
    } finally {
      releaseStoreLock(lock)
    }
  }

  listForRepo(repoPath: string, sessionId?: string): WorkflowRun[] {
    return [...this.runs.values()]
      .filter(run => run.repoPath === repoPath && (sessionId === undefined || run.sessionId === sessionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId)
  }

  put(run: WorkflowRun): void {
    const parsed = Date.parse(run.updatedAt)
    const previous = this.localRevisions.get(run.runId)
    const next = Math.max(
      Date.now(),
      Number.isFinite(parsed) ? parsed : 0,
      previous === undefined ? 0 : previous + 1,
    )
    run.updatedAt = new Date(next).toISOString()
    this.localRevisions.set(run.runId, next)
    this.runs.set(run.runId, run)
    this.dirty.add(this.recordKey(run.repoPath, run.runId))
  }

  delete(runId: string): boolean {
    const run = this.runs.get(runId)
    if (run === undefined) return false
    const key = this.recordKey(run.repoPath, runId)
    this.deleted.add(key)
    this.dirty.delete(key)
    return this.runs.delete(runId)
  }

  /** Delete one terminal record and roll the in-memory mutation back if persistence fails. */
  deleteAndPersist(repoPath: string, runId: string): boolean {
    const run = this.runs.get(runId)
    if (run === undefined || run.repoPath !== repoPath) return false
    const key = this.recordKey(repoPath, runId)
    const before = {
      deleted: this.deleted.has(key),
      dirty: this.dirty.has(key),
      knownPersisted: this.knownPersisted.has(key),
      persistedRevision: this.persistedRevisions.get(key),
      localRevision: this.localRevisions.get(runId),
    }
    this.delete(runId)
    try {
      this.persist(repoPath)
      return true
    } catch (error) {
      this.runs.set(runId, run)
      const restoreSet = (set: Set<string>, present: boolean): void => {
        if (present) set.add(key)
        else set.delete(key)
      }
      restoreSet(this.deleted, before.deleted)
      restoreSet(this.dirty, before.dirty)
      restoreSet(this.knownPersisted, before.knownPersisted)
      if (before.persistedRevision === undefined) this.persistedRevisions.delete(key)
      else this.persistedRevisions.set(key, before.persistedRevision)
      if (before.localRevision === undefined) this.localRevisions.delete(runId)
      else this.localRevisions.set(runId, before.localRevision)
      throw error
    }
  }

  findActive(repoPath: string): WorkflowRun | undefined {
    return this.listForRepo(repoPath).find(run => run.status === 'running' || run.status === 'waiting_user' || run.status === 'idle')
  }

  anyActive(repoPath: string, excludeRun?: string): boolean {
    return this.listForRepo(repoPath).some(run => run.runId !== excludeRun && (run.status === 'running' || run.status === 'waiting_user'))
  }

  snapshot(repoPath: string, sessionId?: string): WorkflowStateSnapshot {
    const visible = this.listForRepo(repoPath, sessionId)
    return {
      repoPath,
      activeRun: visible.find(run => run.status === 'running' || run.status === 'waiting_user' || run.status === 'idle') ?? null,
      runs: visible.map(run => ({
        runId: run.runId,
        createdAt: run.createdAt,
        status: run.status,
        mode: run.mode,
        changeId: run.changeId,
        module: run.module,
      })),
    }
  }
}
