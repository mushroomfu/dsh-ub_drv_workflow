/**
 * Loopback HTTP client for the host routes. Plain fetch, no runtime deps:
 * the browser half can call these regardless of the DSH connection service.
 */

import { UB_WORKFLOW_API } from '../core/apiPaths.ts'
import type { RunInput, StepId, WorkflowRun, WorkflowStateSnapshot } from '../core/types.ts'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = await res.json() as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export interface LaunchPayload {
  repoPath?: string
  sessionId?: string
  requirement: string
  module?: string
  mode: RunInput['mode']
  designOnly?: boolean
  deploy?: boolean
  changeId?: string
}

export interface GateActionPayload {
  runId: string
  stepId: StepId
  action: 'confirm' | 'cancel'
}

export const ubWorkflowClient = {
  state: (): Promise<WorkflowStateSnapshot> => request(UB_WORKFLOW_API.state),

  runs: (): Promise<{ runs: WorkflowRun[] }> => request(UB_WORKFLOW_API.runs),

  run: (runId: string): Promise<{ run: WorkflowRun }> =>
    request(`${UB_WORKFLOW_API.run}?run=${encodeURIComponent(runId)}`),

  launch: (payload: LaunchPayload): Promise<{ runId: string; run: WorkflowRun }> =>
    request(UB_WORKFLOW_API.run, { method: 'POST', body: JSON.stringify(payload) }),

  resolveGate: (payload: GateActionPayload): Promise<{ ok: boolean }> =>
    request(UB_WORKFLOW_API.gate, { method: 'POST', body: JSON.stringify(payload) }),

  stop: (runId: string): Promise<{ ok: boolean }> =>
    request(UB_WORKFLOW_API.stop, { method: 'POST', body: JSON.stringify({ runId }) }),

  delete: (runId: string): Promise<{ ok: boolean }> =>
    request(UB_WORKFLOW_API.delete, { method: 'POST', body: JSON.stringify({ runId }) }),
}