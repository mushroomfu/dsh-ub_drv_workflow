/**
 * Polls `/api/ub-workflow/state` while the view is mounted and the document
 * is visible. Returns the latest snapshot plus manual refresh and mutation
 * helpers used by the flow view.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRun, WorkflowStateSnapshot } from '../core/types.ts'
import { ubWorkflowClient, type GateActionPayload, type LaunchPayload } from './api.ts'

export interface WorkflowController {
  snapshot: WorkflowStateSnapshot | null
  error: string | null
  refresh: () => Promise<void>
  launch: (payload: LaunchPayload) => Promise<WorkflowRun>
  resolveGate: (payload: GateActionPayload) => Promise<void>
  stop: (runId: string) => Promise<void>
  remove: (runId: string) => Promise<void>
}

export function useWorkflowRun(pollMs = 1500): WorkflowController {
  const [snapshot, setSnapshot] = useState<WorkflowStateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await ubWorkflowClient.state())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'refreshFailed')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    timerRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, pollMs)
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pollMs, refresh])

  const launch = useCallback(async (payload: LaunchPayload): Promise<WorkflowRun> => {
    const result = await ubWorkflowClient.launch(payload)
    await refresh()
    return result.run
  }, [refresh])

  const resolveGate = useCallback(async (payload: GateActionPayload): Promise<void> => {
    await ubWorkflowClient.resolveGate(payload)
    await refresh()
  }, [refresh])

  const stop = useCallback(async (runId: string): Promise<void> => {
    await ubWorkflowClient.stop(runId)
    await refresh()
  }, [refresh])

  const remove = useCallback(async (runId: string): Promise<void> => {
    await ubWorkflowClient.delete(runId)
    await refresh()
  }, [refresh])

  return { snapshot, error, refresh, launch, resolveGate, stop, remove }
}