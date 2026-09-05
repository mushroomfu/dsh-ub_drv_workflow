/**
 * Parser and reducer for UB's durable `.knowledge/events.ndjson` protocol.
 * Terminal events distinguish a passing report from a failure report, which
 * file existence alone cannot do.
 */

import { createHash } from 'node:crypto'
import { EVENT_VERIFIED_STEPS, HOST_VERIFIED_STEPS, matchesArtifact } from './artifacts.ts'
import { allSteps, aggregateSubsteps } from './stages.ts'
import type { StepId, StepStatus, WorkflowStep } from './types.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const OUTCOMES = new Set(['started', 'completed', 'passed', 'failed', 'blocked', 'resolved', 'aborted', 'skipped'])
const REQUIRED_FIELDS = new Set([
  'schema_version', 'module', 'change_id', 'session_id', 'phase', 'skill',
  'event_type', 'outcome', 'summary', 'artifacts', 'files', 'symbols',
  'occurred_at', 'event_id', 'content_sha256',
])
const OPTIONAL_FIELDS = new Set(['correlation_id', 'attempt', 'error_signature', 'diagnostic'])
const DIAGNOSTIC_FIELDS = new Set(['symptom', 'root_cause', 'fix', 'verification'])
const MAX_EVENT_ITEMS = 4_096
const MAX_CANONICAL_DEPTH = 48
const MAX_CANONICAL_NODES = 16_384
const PRIVATE_BLOCK = /<private>[\s\S]*?<\/private>/gi
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(\s*[:=]\s*)([^\s,;]+)/gi

const EVENT_TUPLES: Readonly<Record<string, { phases: readonly string[]; skills: readonly string[] }>> = {
  workflow: { phases: ['workflow'], skills: ['ub-leader'] },
  requirement: { phases: ['requirement'], skills: ['ub-requirement', 'ub-design', 'ub-leader'] },
  design: { phases: ['design'], skills: ['ub-design', 'ub-leader'] },
  stc: { phases: ['stc'], skills: ['ub-design', 'ub-leader'] },
  develop: { phases: ['develop'], skills: ['ub-develop', 'ub-leader'] },
  patch: { phases: ['patch'], skills: ['ub-patch', 'ub-leader'] },
  compile: { phases: ['compile'], skills: ['ub-compile', 'ub-leader'] },
  verification: { phases: ['test', 'verify'], skills: ['ub-UT', 'ub-leader'] },
  review: { phases: ['review'], skills: ['ub-review', 'ub-leader'] },
  deploy: { phases: ['deploy'], skills: ['ub-deploy', 'ub-verify', 'ub-leader'] },
  'stc-exec': { phases: ['stc-exec'], skills: ['ub-stc-exec', 'ub-verify', 'ub-leader'] },
  explore: { phases: ['explore'], skills: ['ub-leader'] },
}

export interface WorkflowEventArtifact {
  path: string
  sha256: string
  size: number
}

export interface WorkflowEvidenceEvent {
  schema_version: 1
  module: string
  change_id: string
  session_id: string
  phase: string
  skill: string
  event_type: string
  outcome: 'started' | 'completed' | 'passed' | 'failed' | 'blocked' | 'resolved' | 'aborted' | 'skipped'
  summary: string
  artifacts: WorkflowEventArtifact[]
  files: string[]
  symbols: string[]
  occurred_at: string
  event_id: string
  content_sha256: string
  correlation_id?: string
  attempt?: number
  error_signature?: string
  diagnostic?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Python-compatible canonical JSON used by the upstream event writer. */
export function canonicalJson(value: unknown): string {
  let nodes = 0
  const encode = (current: unknown, depth: number): string => {
    nodes += 1
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new RangeError('canonical JSON exceeds structural limits')
    }
    if (Array.isArray(current)) return `[${current.map(item => encode(item, depth + 1)).join(',')}]`
    if (isRecord(current)) {
      return `{${Object.keys(current)
        .sort()
        .map(key => `${JSON.stringify(key)}:${encode(current[key], depth + 1)}`)
        .join(',')}}`
    }
    const encoded = JSON.stringify(current)
    if (encoded === undefined) throw new TypeError('undefined is not valid canonical JSON')
    return encoded
  }
  return encode(value, 0)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function withoutKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.startsWith('\\')) return false
  const normalized = value.replace(/\\/g, '/')
  return normalized === value && !normalized.split('/').includes('..')
}

function redactedText(value: string): string {
  return value
    .replace(PRIVATE_BLOCK, '[REDACTED_PRIVATE]')
    .replace(PRIVATE_KEY, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
}

function hasPersistedText(value: unknown, max = 20_000): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value === value.trim()
    && value === redactedText(value)
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{6}))?\+00:00$/.exec(value)
  if (match === null) return false
  const [, year, month, day, hour, minute, second, micros] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${(micros ?? '000000').slice(0, 3)}Z`)
  if (!Number.isFinite(date.getTime())) return false
  const pad = (part: number, size = 2): string => String(part).padStart(size, '0')
  const normalizedBase = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  const normalizedMicros = micros === undefined || micros === '000000' ? '' : `.${micros}`
  return value === `${normalizedBase}${normalizedMicros}+00:00`
}

function hasCanonicalTuple(value: Record<string, unknown>): boolean {
  if (typeof value.event_type !== 'string' || typeof value.phase !== 'string'
    || typeof value.skill !== 'string' || typeof value.outcome !== 'string') return false
  const separator = value.event_type.lastIndexOf('.')
  if (separator <= 0 || separator === value.event_type.length - 1) return false
  const prefix = value.event_type.slice(0, separator)
  const suffix = value.event_type.slice(separator + 1)
  const tuple = EVENT_TUPLES[prefix]
  if (tuple === undefined || !tuple.phases.includes(value.phase) || !tuple.skills.includes(value.skill)) return false
  if (prefix === 'design' && suffix === 'modified') return value.outcome === 'completed'
  return suffix === value.outcome
}

function hasValidStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_EVENT_ITEMS
    && new Set(value).size === value.length
    && value.every(item => hasPersistedText(item, 4_096))
}

function hasValidArtifacts(value: unknown): value is WorkflowEventArtifact[] {
  return Array.isArray(value) && value.length <= MAX_EVENT_ITEMS && value.every(item => {
    if (!isRecord(item)) return false
    return Object.keys(item).length === 3
      && Object.hasOwn(item, 'path')
      && Object.hasOwn(item, 'sha256')
      && Object.hasOwn(item, 'size')
      && isSafeRelativePath(item.path)
      && item.path.length <= 4_096
      && typeof item.sha256 === 'string'
      && SHA256.test(item.sha256)
      && Number.isInteger(item.size)
      && (item.size as number) >= 0
  })
}

/** Parse one event, rejecting corruption, another change, or unsupported data. */
export function parseWorkflowEventLine(line: string, expectedChangeId: string): WorkflowEvidenceEvent | undefined {
  if (line.length === 0 || line.length > 256 * 1024) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  try {
    const keys = Object.keys(parsed)
    if ([...REQUIRED_FIELDS].some(key => !Object.hasOwn(parsed, key))) return undefined
    if (keys.some(key => !REQUIRED_FIELDS.has(key) && !OPTIONAL_FIELDS.has(key))) return undefined
    const ids = ['module', 'change_id', 'session_id', 'phase', 'skill', 'event_type'] as const
    if (parsed.schema_version !== 1 || parsed.change_id !== expectedChangeId) return undefined
    if (ids.some(key => typeof parsed[key] !== 'string' || !SAFE_ID.test(parsed[key] as string))) return undefined
    if (typeof parsed.outcome !== 'string' || !OUTCOMES.has(parsed.outcome) || !hasCanonicalTuple(parsed)) return undefined
    if (!hasPersistedText(parsed.summary)) return undefined
    if (!hasValidArtifacts(parsed.artifacts) || !hasValidStringArray(parsed.files) || !hasValidStringArray(parsed.symbols)) return undefined
    if (!isCanonicalUtcTimestamp(parsed.occurred_at)) return undefined
    if (typeof parsed.event_id !== 'string' || !/^ke-[0-9a-f]{24}$/.test(parsed.event_id)) return undefined
    if (typeof parsed.content_sha256 !== 'string' || !SHA256.test(parsed.content_sha256)) return undefined
    if (parsed.correlation_id !== undefined
      && (typeof parsed.correlation_id !== 'string' || !SAFE_ID.test(parsed.correlation_id))) return undefined
    if (parsed.attempt !== undefined
      && (!Number.isInteger(parsed.attempt) || (parsed.attempt as number) < 0)) return undefined
    if (parsed.error_signature !== undefined && !hasPersistedText(parsed.error_signature)) return undefined
    if (parsed.diagnostic !== undefined) {
      if (!isRecord(parsed.diagnostic)
        || Object.keys(parsed.diagnostic).some(key => !DIAGNOSTIC_FIELDS.has(key))
        || Object.values(parsed.diagnostic).some(value => !hasPersistedText(value))) return undefined
    }

    const expectedEventId = `ke-${sha256(canonicalJson(withoutKeys(parsed, new Set(['event_id', 'occurred_at', 'content_sha256'])))).slice(0, 24)}`
    if (parsed.event_id !== expectedEventId) return undefined
    const expectedContentHash = sha256(canonicalJson(withoutKeys(parsed, new Set(['content_sha256']))))
    if (parsed.content_sha256 !== expectedContentHash) return undefined
    return parsed as unknown as WorkflowEvidenceEvent
  } catch {
    return undefined
  }
}

interface StepEvidence {
  status: StepStatus
  summary: string
  occurredAt: string
  eventId: string
  supportingEventIds?: string[]
  valid: boolean
  correlationId?: string
  attempt?: number
}

function canReplaceEvidence(previous: StepEvidence | undefined, next: StepEvidence): boolean {
  if (previous?.status !== 'failed' || next.status !== 'done') return true
  return previous.correlationId !== undefined
    && next.correlationId === previous.correlationId
    && previous.attempt !== undefined
    && next.attempt !== undefined
    && next.attempt > previous.attempt
}

function setLatestEvidence(map: Map<StepId, StepEvidence>, stepId: StepId, evidence: StepEvidence): void {
  if (canReplaceEvidence(map.get(stepId), evidence)) map.set(stepId, evidence)
}

function terminalStatus(outcome: WorkflowEvidenceEvent['outcome']): StepStatus | undefined {
  if (outcome === 'completed' || outcome === 'passed' || outcome === 'resolved') return 'done'
  // A stage present in this UI chain is mandatory for the selected mode. The
  // chain builder omits inapplicable stages, so an event-driven skip is a
  // blocking terminal result rather than permission to advance.
  if (outcome === 'failed' || outcome === 'blocked' || outcome === 'aborted' || outcome === 'skipped') return 'failed'
  return undefined
}

function failureSubstep(event: WorkflowEvidenceEvent): StepId {
  const paths = event.artifacts.map(artifact => artifact.path)
  if (paths.some(path => path.endsWith('compile_report.md'))) return 'develop.compile'
  if (paths.some(path => path.endsWith('pre_review_report.md'))) return 'develop.pre-review'
  if (paths.some(path => path.endsWith('patch_report.md') || path.includes('/patch/'))) return 'develop.patch'
  return 'develop.implement'
}

function targetSteps(event: WorkflowEvidenceEvent, steps: WorkflowStep[]): StepId[] {
  const prefix = event.event_type.split('.')[0]?.toLowerCase()
  const positive = terminalStatus(event.outcome) === 'done'
  const has = (id: StepId): boolean => steps.some(step => step.id === id)

  if (event.event_type === 'design.modified') return []
  if (prefix === 'workflow') {
    return steps.some(step => step.id === 'explore') ? ['explore'] : ['closeout']
  }
  // ub-UT events are assigned to the manifest-ordered timing stages by the
  // reducer. The upstream event schema has no timing field.
  if (prefix === 'verification') return []
  if (prefix === 'requirement') return ['requirement']
  if (prefix === 'stc') return ['design']
  if (prefix === 'design') return ['design']
  if (prefix === 'patch') return ['develop.patch']
  if (prefix === 'compile') return ['develop.compile']
  if (prefix === 'review') return ['review']
  if (prefix === 'deploy') return [has('verify-deploy') ? 'verify-deploy' : 'verify']
  if (prefix === 'stc-exec') return [has('verify-stc') ? 'verify-stc' : 'verify']
  if (prefix === 'explore') return ['explore']
  if (prefix === 'develop') {
    if (positive) {
      // ub-develop owns implementation and the inline pre-review. Patch and
      // compile emit their own terminal events and must not be overwritten by
      // the later, broader develop.completed event.
      return ['develop.implement', 'develop.pre-review', 'develop']
    }
    return [failureSubstep(event), 'develop']
  }
  return []
}

function setStepEvidence(step: WorkflowStep, evidence: StepEvidence): boolean {
  let changed = false
  if (step.status !== evidence.status) {
    step.status = evidence.status
    changed = true
  }
  const summary = evidence.summary.slice(0, 400)
  if (step.note !== summary) {
    step.note = summary
    changed = true
  }
  if (evidence.status === 'failed') {
    if (step.error !== summary) {
      step.error = summary
      changed = true
    }
  } else if (step.error !== undefined) {
    step.error = undefined
    changed = true
  }
  if (step.evidenceId !== evidence.eventId) {
    step.evidenceId = evidence.eventId
    changed = true
  }
  const support = evidence.supportingEventIds ?? []
  const currentSupport = step.supportingEvidenceIds ?? []
  if (support.length !== currentSupport.length || support.some((id, index) => id !== currentSupport[index])) {
    step.supportingEvidenceIds = support.length === 0 ? undefined : [...support]
    changed = true
  }
  if (evidence.status === 'done' || evidence.status === 'failed' || evidence.status === 'skipped') {
    if (step.finishedAt !== evidence.occurredAt) {
      step.finishedAt = evidence.occurredAt
      changed = true
    }
  }
  return changed
}

function revokeCompletedEvidence(step: WorkflowStep): boolean {
  if (step.status !== 'done') return false
  step.status = 'pending'
  step.startedAt = undefined
  step.finishedAt = undefined
  step.note = undefined
  step.error = undefined
  step.evidenceId = undefined
  step.supportingEvidenceIds = undefined
  return true
}

function eventArtifactsValid(
  event: WorkflowEvidenceEvent,
  artifacts: readonly WorkflowEventArtifact[],
): boolean {
  return event.artifacts.every(declared => artifacts.some(current => (
    current.path === declared.path
    && current.size === declared.size
    && current.sha256 === declared.sha256
  )))
}

function eventCoversHints(
  event: WorkflowEvidenceEvent,
  step: WorkflowStep | undefined,
  artifacts: readonly WorkflowEventArtifact[],
  files: readonly string[],
  includeHint: (hint: string) => boolean = () => true,
): boolean {
  if (step === undefined) return false
  const hints = step.artifactHints.filter(includeHint)
  if (hints.length === 0) return false
  return hints.every(hint => {
    const matches = files.filter(file => matchesArtifact(hint, file))
    if (matches.length === 0) return false
    return matches.every(path => {
      const declared = event.artifacts.filter(artifact => artifact.path === path)
      return declared.length > 0 && declared.every(expected => artifacts.some(current => (
        current.path === expected.path
        && current.size === expected.size
        && current.sha256 === expected.sha256
      )))
    })
  })
}

function isDesignStcEvent(event: WorkflowEvidenceEvent): boolean {
  return event.event_type.startsWith('stc.') && event.phase === 'stc'
}

function isUtTerminalEvent(event: WorkflowEvidenceEvent): boolean {
  return event.event_type.startsWith('verification.') && (event.phase === 'test' || event.phase === 'verify')
}

/** Apply the latest trusted terminal event for each stage to the UI state. */
export function applyWorkflowEventEvidence(
  steps: WorkflowStep[],
  events: readonly WorkflowEvidenceEvent[],
  artifacts: readonly WorkflowEventArtifact[],
  files: readonly string[],
): boolean {
  const latest = new Map<StepId, StepEvidence>()
  const flat = allSteps(steps)
  let latestDesignStc: StepEvidence | undefined

  const coversTarget = (event: WorkflowEvidenceEvent, stepId: StepId): boolean => (
    eventCoversHints(
      event,
      flat.find(candidate => candidate.id === stepId),
      artifacts,
      files,
      stepId === 'develop'
        ? hint => hint === 'implementation_notes.md' || hint === 'pre_review_report.md'
        : stepId === 'design' && event.event_type.startsWith('design.')
          ? hint => hint === 'detailed_design.md' || hint.startsWith('delta/')
        : undefined,
    )
  )

  for (const event of events) {
    const declaredArtifactsValid = eventArtifactsValid(event, artifacts)

    if (event.event_type === 'requirement.blocked' && event.outcome === 'blocked') {
      // The first ub-design return deliberately records requirement.blocked to
      // hand control to the clarification gate. It is a successful handoff,
      // and a later requirement.completed event naturally supersedes it.
      setLatestEvidence(latest, 'requirement', {
        status: 'done',
        summary: event.summary,
        occurredAt: event.occurred_at,
        eventId: event.event_id,
        valid: declaredArtifactsValid && coversTarget(event, 'requirement'),
        correlationId: event.correlation_id,
        attempt: event.attempt,
      })
      continue
    }
    const status = terminalStatus(event.outcome)
    if (status === undefined) continue
    if (isDesignStcEvent(event)) {
      const next: StepEvidence = {
        status,
        summary: event.summary,
        occurredAt: event.occurred_at,
        eventId: event.event_id,
        valid: status !== 'done' || (declaredArtifactsValid && eventCoversHints(
          event,
          flat.find(candidate => candidate.id === 'design'),
          artifacts,
          files,
          hint => hint !== 'detailed_design.md' && !hint.startsWith('delta/'),
        )),
        correlationId: event.correlation_id,
        attempt: event.attempt,
      }
      if (canReplaceEvidence(latestDesignStc, next)) latestDesignStc = next
      continue
    }
    if (isUtTerminalEvent(event)) continue
    const targets = targetSteps(event, steps)
    // Upstream intentionally emits workflow.completed without artifacts; every
    // other successful terminal event must bind at least one authoritative
    // artifact for the stage it claims to complete. Filesystem hints remain a
    // second, independent completeness check below.
    for (const stepId of targets) {
      setLatestEvidence(latest, stepId, {
        status,
        summary: event.summary,
        occurredAt: event.occurred_at,
        eventId: event.event_id,
        valid: status !== 'done' || (
          event.event_type === 'workflow.completed'
          || (declaredArtifactsValid && coversTarget(event, stepId))
        ),
        correlationId: event.correlation_id,
        attempt: event.attempt,
      })
    }
  }

  // The design gate is authorized by two independent upstream terminal
  // events: detailed design/delta and STC generation/review. Never let one
  // event overwrite the other in the single visible design card.
  const designEvidence = latest.get('design')
  if (designEvidence !== undefined && latestDesignStc !== undefined) {
    if (designEvidence.status === 'done' && latestDesignStc.status === 'done') {
      latest.set('design', {
        ...designEvidence,
        supportingEventIds: [latestDesignStc.eventId],
        valid: designEvidence.valid && latestDesignStc.valid,
      })
    } else if (latestDesignStc.status === 'failed') {
      latest.set('design', latestDesignStc)
    }
  } else {
    latest.delete('design')
  }

  // The schema-v1 event does not include ub-UT's `--timing`. Assign distinct
  // terminal correlation groups to the manifest-ordered timing cards. The
  // engine supplies re-hashed immutable snapshots for earlier overwritten
  // test_report.md versions; missing snapshots therefore fail closed.
  const testSteps = steps
    .map(step => step.id)
    .filter((id): id is Extract<StepId, `test.${string}`> => id.startsWith('test.'))
  const latestUt = new Map<StepId, StepEvidence>()
  const correlationStep = new Map<string, number>()
  let nextTiming = 0
  for (const event of events) {
    if (!isUtTerminalEvent(event) || terminalStatus(event.outcome) === undefined) continue
    const key = event.correlation_id === undefined
      ? `event:${event.event_id}`
      : `correlation:${event.correlation_id}`
    let index = correlationStep.get(key)
    if (index === undefined) {
      index = nextTiming
      correlationStep.set(key, index)
    }
    const status = terminalStatus(event.outcome)
    const stepId = testSteps[index]
    if (status === undefined || stepId === undefined) continue
    setLatestEvidence(latestUt, stepId, {
      status,
      summary: event.summary,
      occurredAt: event.occurred_at,
      eventId: event.event_id,
      valid: status !== 'done' || (
        eventArtifactsValid(event, artifacts)
        && coversTarget(event, stepId)
      ),
      correlationId: event.correlation_id,
      attempt: event.attempt,
    })
    if (status === 'done' && index === nextTiming) nextTiming += 1
  }
  for (const [stepId, evidence] of latestUt) latest.set(stepId, evidence)

  const applicable = new Map<StepId, StepEvidence>()
  for (const [stepId, evidence] of latest) {
    const step = flat.find(candidate => candidate.id === stepId)
    if (step === undefined) continue
    if (stepId === 'develop' && evidence.status === 'done') continue
    const artifactsPresent = evidence.valid && (evidence.status !== 'done'
      || step.artifactHints.length === 0
      || step.artifactHints.every(hint => files.some(file => matchesArtifact(hint, file))))
    if (artifactsPresent) applicable.set(stepId, evidence)
  }

  let changed = false
  for (const step of flat) {
    if (step.id === 'develop' || !EVENT_VERIFIED_STEPS.has(step.id)) continue
    if (applicable.get(step.id)?.status !== 'done' && revokeCompletedEvidence(step)) changed = true
  }
  for (const [stepId, evidence] of applicable) {
    if (HOST_VERIFIED_STEPS.has(stepId)) continue
    const step = flat.find(candidate => candidate.id === stepId)
    if (step !== undefined && setStepEvidence(step, evidence)) changed = true
  }

  const develop = steps.find(step => step.id === 'develop')
  const rawDevelopEvidence = latest.get('develop')
  const developArtifactsPresent = rawDevelopEvidence !== undefined
    && rawDevelopEvidence.valid
    && (rawDevelopEvidence.status !== 'done'
      || develop?.artifactHints.every(hint => files.some(file => matchesArtifact(hint, file))) === true)
  const developEvidence = developArtifactsPresent ? rawDevelopEvidence : undefined
  if (develop?.substeps !== undefined && developEvidence?.status === 'done') {
    const aggregate = aggregateSubsteps(develop)
    if (aggregate === 'done') {
      if (setStepEvidence(develop, developEvidence)) changed = true
    } else if (aggregate !== 'failed' && develop.status !== aggregate) {
      develop.status = aggregate
      develop.error = undefined
      develop.finishedAt = undefined
      changed = true
    }
  } else if (develop?.substeps !== undefined && developEvidence === undefined && develop.status !== 'skipped') {
    const aggregate = aggregateSubsteps(develop)
    const nextStatus = aggregate === 'pending' ? 'pending' : aggregate
    if (nextStatus !== develop.status) {
      develop.status = nextStatus
      if (nextStatus === 'pending') {
        develop.startedAt = undefined
        develop.finishedAt = undefined
        develop.note = undefined
        develop.error = undefined
      }
      changed = true
    }
  }
  return changed
}
