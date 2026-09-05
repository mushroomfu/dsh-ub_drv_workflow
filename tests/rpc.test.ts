import { describe, expect, it, vi } from 'vitest'
import { makeWorkflowRpcHandler } from '../src/rpc.ts'
import type { WorkflowEngine } from '../src/engine.ts'
import type { WorkflowStore } from '../src/store.ts'

describe('workflow Connection RPC', () => {
  it('rejects gate mutations while the plugin is disabled', async () => {
    const resolveGate = vi.fn()
    const handler = makeWorkflowRpcHandler({
      repoPath: () => '/repo',
      store: () => ({}) as WorkflowStore,
      engine: () => ({ resolveGate }) as unknown as WorkflowEngine,
      enabled: () => false,
    })

    const result = await handler('gate', {
      sessionId: 'dsh-session-1',
      runId: 'run-1',
      stepId: 'requirement-clarify',
      action: 'confirm',
      response: 'confirmed',
    }, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      error: { message: 'UB workflow plugin is disabled' },
    })
    expect(resolveGate).not.toHaveBeenCalled()
  })

  it('keeps launch behind the previous process cleanup boundary', async () => {
    const createRun = vi.fn()
    const handler = makeWorkflowRpcHandler({
      repoPath: () => '/repo',
      store: () => ({ anyActive: () => false }) as unknown as WorkflowStore,
      engine: () => ({ processBusy: true, createRun }) as unknown as WorkflowEngine,
    })

    const result = await handler('launch', {
      sessionId: 'dsh-session-1',
      requirement: 'test',
      module: 'udma',
      mode: 'explore',
    }, new AbortController().signal)

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('still stopping') } })
    expect(createRun).not.toHaveBeenCalled()
  })
})
