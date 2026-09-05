/**
 * Polls the DSH Connection RPC while the view is mounted and the document is
 * visible. Returns the latest snapshot plus manual refresh and mutation helpers
 * used by the flow view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { StepId, WorkflowArtifactPreview, WorkflowRun, WorkflowStateSnapshot } from '../core/types.ts'
import type { GateActionPayload, LaunchPayload, UbWorkflowClient } from './api.ts'

export interface WorkflowController {
  snapshot: WorkflowStateSnapshot | null
  error: string | null
  refresh: () => Promise<void>
  launch: (payload: LaunchPayload) => Promise<WorkflowRun>
  getRun: (runId: string) => Promise<WorkflowRun>
  resolveGate: (payload: GateActionPayload) => Promise<void>
  previewArtifacts: (runId: string, stepId: StepId) => Promise<{ artifacts: WorkflowArtifactPreview[]; evidenceIds: string[] }>
  stop: (runId: string) => Promise<void>
  remove: (runId: string) => Promise<void>
}

export function useWorkflowRun(client: UbWorkflowClient, pollMs = 1500): WorkflowController {
  const identityRef = useRef({ client, generation: 0 })
  if (identityRef.current.client !== client) {
    identityRef.current = { client, generation: identityRef.current.generation + 1 }
  }
  const generation = identityRef.current.generation
  const [state, setState] = useState<{
    generation: number
    snapshot: WorkflowStateSnapshot | null
    error: string | null
  }>({ generation, snapshot: null, error: null })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  const snapshot = state.generation === generation ? state.snapshot : null
  const error = state.generation === generation ? state.error : null

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    try {
      const next = await client.state()
      if (mountedRef.current && generation === identityRef.current.generation && request === requestRef.current) {
        setState({ generation, snapshot: next, error: null })
      }
    } catch (err) {
      if (mountedRef.current && generation === identityRef.current.generation && request === requestRef.current) {
        setState(current => ({
          generation,
          snapshot: current.generation === generation ? current.snapshot : null,
          error: err instanceof Error ? err.message : 'refreshFailed',
        }))
      }
    }
  }, [client, generation])

  useEffect(() => {
    // React 18 development StrictMode replays setup → cleanup → setup on the
    // same hook instance. Restore the live flag on every setup so the second
    // mount can accept polling results.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    requestRef.current += 1
    setState({ generation, snapshot: null, error: null })
    let cancelled = false
    let polling = false
    const schedule = (): void => {
      if (!cancelled) timerRef.current = setTimeout(() => { void poll() }, pollMs)
    }
    const poll = async (): Promise<void> => {
      if (cancelled) return
      if (document.visibilityState === 'hidden') {
        schedule()
        return
      }
      if (polling) return
      polling = true
      try {
        await refresh()
      } finally {
        polling = false
        schedule()
      }
    }
    void poll()
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      requestRef.current += 1
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [generation, pollMs, refresh])

  const launch = useCallback(async (payload: LaunchPayload): Promise<WorkflowRun> => {
    const result = await client.launch(payload)
    await refresh()
    return result.run
  }, [client, refresh])

  const getRun = useCallback(async (runId: string): Promise<WorkflowRun> => {
    const result = await client.run(runId)
    return result.run
  }, [client])

  const resolveGate = useCallback(async (payload: GateActionPayload): Promise<void> => {
    await client.resolveGate(payload)
    await refresh()
  }, [client, refresh])

  const previewArtifacts = useCallback(async (runId: string, stepId: StepId): Promise<{ artifacts: WorkflowArtifactPreview[]; evidenceIds: string[] }> => {
    return await client.preview(runId, stepId)
  }, [client])

  const stop = useCallback(async (runId: string): Promise<void> => {
    await client.stop(runId)
    await refresh()
  }, [client, refresh])

  const remove = useCallback(async (runId: string): Promise<void> => {
    await client.delete(runId)
    await refresh()
  }, [client, refresh])

  return { snapshot, error, refresh, launch, getRun, resolveGate, previewArtifacts, stop, remove }
}
