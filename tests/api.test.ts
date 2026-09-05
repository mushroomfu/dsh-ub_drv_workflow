import { describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createUbWorkflowClient } from '../src/client/api.ts'

describe('workflow client transport', () => {
  it('uses DSH Connection RPC and does not depend on page-relative fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('file:// fetch unavailable'))
    const call = vi.fn(async () => ({
      ok: true as const,
      value: { repoPath: '/repo', activeRun: null, runs: [] },
    }))
    const client = createUbWorkflowClient({ call } as ClientConnectionRpc, 'session-test')

    await expect(client.state()).resolves.toMatchObject({ repoPath: '/repo' })
    expect(call).toHaveBeenCalledWith(
      '/ub-workflow',
      'state',
      { sessionId: 'session-test' },
      expect.any(AbortSignal),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
