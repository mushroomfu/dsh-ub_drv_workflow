/** DSH Connection RPC adapter for the workflow host engine. */

import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { UB_WORKFLOW_RPC } from './core/apiPaths.ts'
import { isSafeWorkflowId } from './core/ids.ts'
import { validateGateBody, validateLaunchBody, validateRunIdBody } from './core/inputValidation.ts'
import type { WorkflowEngine } from './engine.ts'
import type { WorkflowStore } from './store.ts'
import { STEP_META } from './core/stages.ts'

interface RpcComposition {
  repoPath: () => string
  store: () => WorkflowStore
  engine: () => WorkflowEngine
  enabled?: () => boolean
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function failure(message: string, code: 'bad-request' | 'internal' = 'bad-request') {
  return code === 'bad-request'
    ? { ok: false as const, error: { code, message, details: { issues: [] } } }
    : { ok: false as const, error: { code, message, details: {} } }
}

function requestSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const value = (payload as Record<string, unknown>).sessionId
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined
  }
  return value.trim()
}

export function makeWorkflowRpcHandler(get: RpcComposition): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    try {
      const sessionId = requestSessionId(payload)
      if (sessionId === undefined) return failure('valid DSH sessionId is required')
      if (endpoint === UB_WORKFLOW_RPC.state) return ok(get.store().snapshot(get.repoPath(), sessionId))
      if (endpoint === UB_WORKFLOW_RPC.runs) return ok({ runs: get.store().listForRepo(get.repoPath(), sessionId) })

      if (endpoint === UB_WORKFLOW_RPC.run) {
        const id = typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).runId
          : undefined
        const run = isSafeWorkflowId(id) ? get.store().get(id) : undefined
        if (run === undefined || run.repoPath !== get.repoPath() || run.sessionId !== sessionId) return failure('run not found')
        return ok({ run })
      }

      if (endpoint === UB_WORKFLOW_RPC.launch) {
        if (get.enabled?.() === false) return failure('UB workflow plugin is disabled')
        const validated = validateLaunchBody(payload, get.repoPath())
        if (!validated.ok) return failure(validated.error)
        if (validated.value.sessionId !== sessionId) return failure('sessionId mismatch')
        if (get.store().anyActive(get.repoPath())) return failure('a workflow run is already active for this workspace')
        const engine = get.engine()
        if (engine.processBusy) return failure('the previous workflow process is still stopping')
        const run = engine.createRun(validated.value)
        if (!engine.launch(run)) return failure(run.error ?? 'failed to launch opencode', 'internal')
        return ok({ runId: run.runId, run })
      }

      if (endpoint === UB_WORKFLOW_RPC.gate) {
        if (get.enabled?.() === false) return failure('UB workflow plugin is disabled')
        const validated = validateGateBody(payload)
        if (!validated.ok) return failure(validated.error)
        const run = get.store().get(validated.value.runId)
        if (run === undefined || run.repoPath !== get.repoPath() || run.sessionId !== sessionId) return failure('run not found')
        const accepted = await get.engine().resolveGate(
          validated.value.runId,
          validated.value.stepId,
          validated.value.action,
          validated.value.response,
          validated.value.reviewedEvidenceIds,
        )
        return accepted ? ok({ ok: true }) : failure(run.error ?? 'gate is not waiting for this action')
      }

      if (endpoint === UB_WORKFLOW_RPC.preview) {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return failure('invalid preview request')
        const body = payload as Record<string, unknown>
        const run = isSafeWorkflowId(body.runId) ? get.store().get(body.runId) : undefined
        if (run === undefined || run.repoPath !== get.repoPath() || run.sessionId !== sessionId) return failure('run not found')
        if (typeof body.stepId !== 'string' || !Object.hasOwn(STEP_META, body.stepId)) return failure('invalid stepId')
        return ok(get.engine().previewStepArtifacts(run.runId, body.stepId as keyof typeof STEP_META))
      }

      if (endpoint === UB_WORKFLOW_RPC.stop || endpoint === UB_WORKFLOW_RPC.delete) {
        const validated = validateRunIdBody(payload)
        if (!validated.ok) return failure(validated.error)
        const run = get.store().get(validated.value.runId)
        if (run === undefined || run.repoPath !== get.repoPath() || run.sessionId !== sessionId) return failure('run not found')
        if (endpoint === UB_WORKFLOW_RPC.stop) {
          return get.engine().stopRun(run.runId) ? ok({ ok: true }) : failure('run is not active')
        }
        if (run.status === 'running' || run.status === 'waiting_user' || run.status === 'idle') {
          return failure('cannot delete an active run')
        }
        const deleted = get.store().deleteAndPersist(get.repoPath(), run.runId)
        return deleted ? ok({ ok: true }) : failure('run not found')
      }

      return failure(`unknown workflow endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'workflow RPC failed', 'internal')
    }
  }
}
