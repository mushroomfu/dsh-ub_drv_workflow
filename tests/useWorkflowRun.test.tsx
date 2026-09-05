// @vitest-environment jsdom

import { act, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowRun, type WorkflowController } from '../src/client/useWorkflowRun.ts'
import type { UbWorkflowClient } from '../src/client/api.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let controller: WorkflowController | undefined
const client: UbWorkflowClient = {
  state: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  launch: vi.fn(),
  resolveGate: vi.fn(),
  preview: vi.fn(),
  stop: vi.fn(),
  delete: vi.fn(),
}

function Harness(props: { source?: UbWorkflowClient } = {}): ReactNode {
  controller = useWorkflowRun(props.source ?? client, 1000)
  return <span>{controller.snapshot?.repoPath ?? 'none'}</span>
}

describe('useWorkflowRun polling', () => {
  let root: Root
  let host: HTMLDivElement
  let visibility: DocumentVisibilityState

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'hidden'
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    })
    vi.mocked(client.state).mockResolvedValue({ repoPath: '/repo', activeRun: null, runs: [] })
    vi.mocked(client.resolveGate).mockResolvedValue({ ok: true })
    host = document.createElement('div')
    root = createRoot(host)
    controller = undefined
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('does not poll while hidden and refreshes immediately when visible', async () => {
    await act(async () => { root.render(<Harness />) })
    await act(async () => { await Promise.resolve() })
    expect(client.state).not.toHaveBeenCalled()

    visibility = 'visible'
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(client.state).toHaveBeenCalledTimes(1)
  })

  it('accepts polling results after React StrictMode replays the mount effect', async () => {
    visibility = 'visible'

    await act(async () => {
      root.render(<StrictMode><Harness /></StrictMode>)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(client.state).toHaveBeenCalled()
    expect(host.textContent).toBe('/repo')
  })

  it('does not let an older poll response overwrite the refresh after a mutation', async () => {
    visibility = 'visible'
    let resolveOld: ((value: { repoPath: string; activeRun: null; runs: [] }) => void) | undefined
    const oldPoll = new Promise<{ repoPath: string; activeRun: null; runs: [] }>(resolve => { resolveOld = resolve })
    let stateRequests = 0
    vi.mocked(client.state).mockImplementation(async () => {
      stateRequests += 1
      if (stateRequests === 1) return await oldPoll
      return { repoPath: '/new', activeRun: null, runs: [] }
    })

    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
    expect(controller).toBeDefined()
    if (controller === undefined) return

    await act(async () => {
      await controller?.resolveGate({
        runId: 'run-1',
        stepId: 'design-gate',
        action: 'confirm',
      })
    })
    expect(host.textContent).toBe('/new')

    await act(async () => {
      resolveOld?.({ repoPath: '/old', activeRun: null, runs: [] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toBe('/new')
  })

  it('invalidates in-flight state and clears visible data when the DSH session client changes', async () => {
    visibility = 'visible'
    let resolveOld: ((value: { repoPath: string; activeRun: null; runs: [] }) => void) | undefined
    const oldState = new Promise<{ repoPath: string; activeRun: null; runs: [] }>(resolve => { resolveOld = resolve })
    const oldClient = { ...client, state: vi.fn(async () => await oldState) }
    const newClient = {
      ...client,
      state: vi.fn(async () => ({ repoPath: '/new-session', activeRun: null, runs: [] })),
    }

    await act(async () => {
      root.render(<Harness source={oldClient} />)
      await Promise.resolve()
    })
    expect(oldClient.state).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<Harness source={newClient} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toBe('/new-session')

    await act(async () => {
      resolveOld?.({ repoPath: '/old-session', activeRun: null, runs: [] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toBe('/new-session')
  })
})
