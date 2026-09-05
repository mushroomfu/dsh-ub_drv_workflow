/** Transport-independent workflow client carried by DSH Connection RPC. */

import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { UB_WORKFLOW_RPC, UB_WORKFLOW_RPC_CHANNEL } from '../core/apiPaths.ts'
import type { RunInput, StepId, WorkflowArtifactPreview, WorkflowRun, WorkflowStateSnapshot } from '../core/types.ts'

export interface LaunchPayload {
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
  action: 'confirm' | 'cancel' | 'revise'
  response?: string
  reviewedEvidenceIds?: string[]
}

export interface UbWorkflowClient {
  state: () => Promise<WorkflowStateSnapshot>
  runs: () => Promise<{ runs: WorkflowRun[] }>
  run: (runId: string) => Promise<{ run: WorkflowRun }>
  launch: (payload: LaunchPayload) => Promise<{ runId: string; run: WorkflowRun }>
  resolveGate: (payload: GateActionPayload) => Promise<{ ok: boolean }>
  preview: (runId: string, stepId: StepId) => Promise<{ artifacts: WorkflowArtifactPreview[]; evidenceIds: string[] }>
  stop: (runId: string) => Promise<{ ok: boolean }>
  delete: (runId: string) => Promise<{ ok: boolean }>
}

const RPC_TIMEOUT_MS = 15_000

export function createUbWorkflowClient(rpc: ClientConnectionRpc, sessionId: string): UbWorkflowClient {
  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, RPC_TIMEOUT_MS)
    try {
      const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), sessionId }
        : { sessionId }
      const result = await rpc.call(UB_WORKFLOW_RPC_CHANNEL, endpoint, body, controller.signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value as T
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    state: async () => await call(UB_WORKFLOW_RPC.state, {}),
    runs: async () => await call(UB_WORKFLOW_RPC.runs, {}),
    run: async runId => await call(UB_WORKFLOW_RPC.run, { runId }),
    launch: async payload => await call(UB_WORKFLOW_RPC.launch, payload),
    resolveGate: async payload => await call(UB_WORKFLOW_RPC.gate, payload),
    preview: async (runId, stepId) => await call(UB_WORKFLOW_RPC.preview, { runId, stepId }),
    stop: async runId => await call(UB_WORKFLOW_RPC.stop, { runId }),
    delete: async runId => await call(UB_WORKFLOW_RPC.delete, { runId }),
  }
}
