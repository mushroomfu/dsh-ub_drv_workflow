// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import type { WorkflowController } from '../src/client/useWorkflowRun.ts'
import type { UbWorkflowClient } from '../src/client/api.ts'
import type { WorkflowRun } from '../src/core/types.ts'
import { zh, type UbWorkflowKey } from '../src/client/locales.ts'

const controller = vi.hoisted((): WorkflowController => ({
  snapshot: null,
  error: null,
  refresh: vi.fn(),
  launch: vi.fn(),
  getRun: vi.fn(),
  resolveGate: vi.fn(),
  previewArtifacts: vi.fn(async () => ({ artifacts: [], evidenceIds: [] })),
  stop: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../src/client/useWorkflowRun.ts', () => ({
  useWorkflowRun: () => controller,
}))

import { WorkflowFlowView, type WorkflowFlowViewProps } from '../src/client/WorkflowFlowView.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function activeRun(): WorkflowRun {
  const steps = buildStageChain({ mode: 'dev' })
  for (let index = 0; index < 5; index += 1) steps[index].status = 'done'
  steps[5].status = 'running'

  return {
    runId: 'ubw-current-stage-test',
    repoPath: '/workspace/ub-drv-develop',
    mode: 'dev',
    designOnly: false,
    deploy: false,
    testTimings: ['post-dev', 'regression'],
    requirement: '测试当前阶段定位',
    status: 'running',
    steps,
    segment: 2,
    createdAt: '2026-09-04T00:00:00.000Z',
    startedAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:01:00.000Z',
    logTail: [],
  }
}

function failedRun(): WorkflowRun {
  const run = activeRun()
  run.runId = 'ubw-fast-failure'
  run.changeId = 'udma-fast-failure'
  run.status = 'failed'
  run.error = 'OpenCode executable was not found'
  for (const step of run.steps) step.status = 'pending'
  run.steps[0].status = 'done'
  run.steps[1].status = 'failed'
  run.steps[1].error = 'OpenCode executable was not found'
  run.steps[1].note = 'spawn ENOENT'
  return run
}

function failedDevelopRun(): WorkflowRun {
  const run = activeRun()
  run.runId = 'ubw-compile-failure'
  run.changeId = 'udma-compile-failure'
  run.status = 'failed'
  run.error = '编码实现失败'
  const develop = run.steps.find(step => step.id === 'develop')
  if (develop !== undefined) {
    develop.status = 'failed'
    develop.error = '编码实现失败'
    for (const substep of develop.substeps ?? []) substep.status = 'done'
    const compile = develop.substeps?.find(step => step.id === 'develop.compile')
    if (compile !== undefined) {
      compile.status = 'failed'
      compile.error = '远程内核编译因 -Werror 失败'
    }
  }
  return run
}

const props = {
  sessionId: 'session-test',
  t: (key: UbWorkflowKey) => zh[key],
  workflowClient: {} as UbWorkflowClient,
} as WorkflowFlowViewProps

describe('WorkflowFlowView', () => {
  let root: Root
  let host: HTMLDivElement
  let scrollTo: ReturnType<typeof vi.fn>
  const descriptors = new Map<string, PropertyDescriptor | undefined>()

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    controller.snapshot = {
      repoPath: '/workspace/ub-drv-develop',
      activeRun: activeRun(),
      runs: [],
    }
    controller.error = null
    vi.mocked(controller.remove).mockResolvedValue(undefined)

    scrollTo = vi.fn()
    for (const key of ['clientWidth', 'offsetLeft', 'offsetWidth', 'scrollLeft', 'getBoundingClientRect', 'scrollTo']) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
    }
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: {
        configurable: true,
        get() { return this.querySelector('[aria-current="step"]') === null ? 0 : 640 },
      },
      offsetLeft: {
        configurable: true,
        get() { return this.getAttribute('aria-current') === 'step' ? 900 : 0 },
      },
      offsetWidth: {
        configurable: true,
        get() { return this.getAttribute('aria-current') === 'step' ? 280 : 0 },
      },
      scrollLeft: {
        configurable: true,
        get() { return this.querySelector('[aria-current="step"]') === null ? 0 : 120 },
      },
      getBoundingClientRect: {
        configurable: true,
        value() {
          const left = this.getAttribute('aria-current') === 'step'
            ? 1050
            : this.querySelector('[aria-current="step"]') === null ? 0 : 250
          return { left, right: left, top: 0, bottom: 0, width: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }
        },
      },
      scrollTo: { configurable: true, value: scrollTo },
    })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
      else Object.defineProperty(HTMLElement.prototype, key, descriptor)
    }
    descriptors.clear()
    vi.clearAllMocks()
  })

  it('centers the current stage initially and after the host viewport resizes', async () => {
    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })

    expect(scrollTo).toHaveBeenCalledWith({ left: 740, behavior: 'smooth' })

    scrollTo.mockClear()
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(scrollTo).toHaveBeenCalledWith({ left: 740, behavior: 'smooth' })
    expect([...host.querySelectorAll('[role="status"]')]
      .some(status => status.textContent?.includes('编码实现') === true)).toBe(true)
  })

  it('keeps the connection state accessible when narrow-container CSS hides its visible text', async () => {
    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })
    expect(host.querySelector('[data-online="true"]')?.getAttribute('aria-label')).toBe(zh.connected)

    controller.snapshot = null
    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })
    expect(host.querySelector('[data-online="false"]')?.getAttribute('aria-label')).toBe(zh.initializing)
  })

  it('loads and shows the failed stage details from a terminal history row', async () => {
    const failed = failedRun()
    controller.snapshot = {
      repoPath: failed.repoPath,
      activeRun: null,
      runs: [{
        runId: failed.runId,
        createdAt: failed.createdAt,
        status: failed.status,
        mode: failed.mode,
        changeId: failed.changeId,
        module: failed.module,
      }],
    }
    const getRun = vi.mocked(controller.getRun).mockResolvedValue(failed)

    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })
    const inspect = host.querySelector<HTMLButtonElement>('button[aria-label="查看运行详情"]')
    expect(inspect).not.toBeNull()
    if (inspect === null) return

    await act(async () => {
      inspect.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getRun).toHaveBeenCalledWith(failed.runId)
    expect(host.textContent).toContain('需求分析与澄清')
    expect(host.textContent).toContain('OpenCode executable was not found')
  })

  it('shows the deepest failed develop substep and includes substeps in history', async () => {
    const failed = failedDevelopRun()
    controller.snapshot = {
      repoPath: failed.repoPath,
      activeRun: null,
      runs: [{
        runId: failed.runId,
        createdAt: failed.createdAt,
        status: failed.status,
        mode: failed.mode,
        changeId: failed.changeId,
        module: failed.module,
      }],
    }
    vi.mocked(controller.getRun).mockResolvedValue(failed)

    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })
    const inspect = host.querySelector<HTMLButtonElement>('button[aria-label="查看运行详情"]')
    expect(inspect).not.toBeNull()
    if (inspect === null) return

    await act(async () => {
      inspect.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const detail = host.querySelector<HTMLElement>('[aria-label="运行详情"]')
    expect(detail?.querySelector('header strong')?.textContent).toBe('编译验证')
    expect(detail?.textContent).toContain('远程内核编译因 -Werror 失败')
    expect(detail?.textContent).toContain('社区合规补丁')
    expect(detail?.textContent).toContain('编码后质量预检')
  })

  it('binds gate confirmation to the exact evidence previewed for the current run revision', async () => {
    const run = activeRun()
    run.status = 'waiting_user'
    const design = run.steps.find(step => step.id === 'design')
    const gate = run.steps.find(step => step.id === 'design-gate')
    if (design === undefined || gate === undefined) throw new Error('missing design gate')
    for (const step of run.steps) step.status = 'pending'
    for (const step of run.steps.slice(0, run.steps.indexOf(gate))) step.status = 'done'
    design.evidenceId = 'ke-111111111111111111111111'
    gate.status = 'waiting_user'
    const preview = vi.mocked(controller.previewArtifacts)
      .mockResolvedValueOnce({
        artifacts: [{ path: 'detailed_design.md', content: '# v1', size: 4, truncated: false }],
        evidenceIds: ['ke-111111111111111111111111'],
      })
      .mockResolvedValueOnce({
        artifacts: [{ path: 'detailed_design.md', content: '# v2', size: 4, truncated: false }],
        evidenceIds: ['ke-222222222222222222222222'],
      })
    controller.snapshot = { repoPath: run.repoPath, activeRun: run, runs: [] }

    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('# v1')

    run.updatedAt = '2026-09-04T00:02:00.000Z'
    design.evidenceId = 'ke-222222222222222222222222'
    controller.snapshot = { repoPath: run.repoPath, activeRun: { ...run }, runs: [] }
    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(preview).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('# v2')

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')
    if (textarea === null) throw new Error('missing gate response field')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, [
        'author: Test User',
        'email: test@example.com',
        'category: feature',
        'max-retries: 2',
        'build-mode: fast',
        'bugzilla: https://example.com/1',
        'cve: NA',
        'assisted-by: DeepSeek Harness',
        'pre-review-strict: true',
      ].join('\n'))
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '发送并继续')
    expect(confirm?.disabled).toBe(false)
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(controller.resolveGate).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.runId,
      stepId: 'design-gate',
      action: 'confirm',
      reviewedEvidenceIds: ['ke-222222222222222222222222'],
    }))
  })

  it('requires a second click before deleting history and locks the control while deletion is pending', async () => {
    const failed = failedRun()
    controller.snapshot = {
      repoPath: failed.repoPath,
      activeRun: null,
      runs: [{
        runId: failed.runId,
        createdAt: failed.createdAt,
        status: failed.status,
        mode: failed.mode,
        changeId: failed.changeId,
        module: failed.module,
      }],
    }
    let resolveRemove: (() => void) | undefined
    const pendingRemove = new Promise<void>((resolve) => { resolveRemove = resolve })
    const remove = vi.mocked(controller.remove).mockReturnValueOnce(pendingRemove)

    await act(async () => {
      root.render(<WorkflowFlowView {...props} />)
      await Promise.resolve()
    })

    const deleteButton = host.querySelector<HTMLButtonElement>(`button[aria-label="${zh.deleteRun}"]`)
    expect(deleteButton).not.toBeNull()
    if (deleteButton === null) return

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(remove).not.toHaveBeenCalled()
    expect(deleteButton.textContent).toBe(zh.confirmDeleteShort)
    expect(deleteButton.getAttribute('aria-label')).toBe(zh.confirmDeleteRun)

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(deleteButton.disabled).toBe(true)
    expect(deleteButton.textContent).toBe('…')

    await act(async () => {
      resolveRemove?.()
      await pendingRemove
    })
    expect(deleteButton.disabled).toBe(false)
  })
})
