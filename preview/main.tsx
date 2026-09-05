import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkflowFlowView, type WorkflowFlowViewProps } from '../src/client/WorkflowFlowView.tsx'
import type { UbWorkflowClient } from '../src/client/api.ts'
import { zh, type UbWorkflowKey } from '../src/client/locales.ts'
import { buildStageChain } from '../src/core/stages.ts'
import type { WorkflowRun, WorkflowStateSnapshot } from '../src/core/types.ts'
import './preview.css'

type Scenario = 'running' | 'waiting' | 'idle'
const requestedScenario = new URLSearchParams(window.location.search).get('scenario')
let scenario: Scenario = requestedScenario === 'waiting' || requestedScenario === 'idle'
  ? requestedScenario
  : 'running'
const WORKSPACE_PATH = '/workspace/ai_workspace'
const WORKFLOW_PATH = '/workspace/ai_workspace/workflows/ub-drv-develop'

function mockActiveRun(kind: Exclude<Scenario, 'idle'>): WorkflowRun {
  const now = new Date()
  const steps = buildStageChain({ mode: 'explore' })
  const waiting = kind === 'waiting'
  steps[0].status = waiting ? 'waiting_user' : 'done'
  steps[0].startedAt = new Date(now.getTime() - 4 * 60_000).toISOString()
  steps[0].note = waiting
    ? '模块、change workspace 与只读边界已经冻结；确认后才会读取源码。'
    : '只读 Explore 路由已由开发者确认。'
  if (!waiting) {
    steps[0].finishedAt = new Date(now.getTime() - 3.5 * 60_000).toISOString()
    steps[1].status = 'running'
    steps[1].startedAt = new Date(now.getTime() - 3.5 * 60_000).toISOString()
    steps[1].note = '正在沿 UDMA jetty 调用链核对异常释放与幂等边界…'
  }

  return {
    runId: 'ubw-01J6M9F2Y8K7VC5NQX3T',
    repoPath: WORKSPACE_PATH,
    workflowPath: WORKFLOW_PATH,
    sourceRoots: [{
      manifestPath: 'kernel/drivers/ub/urma/hw/udma',
      path: '/workspace/source/linux/kernel/drivers/ub/urma/hw/udma',
    }],
    sessionId: 'preview-session',
    changeId: 'udma-jetty-explore-20260905',
    module: 'udma',
    mode: 'explore',
    designOnly: false,
    deploy: false,
    testTimings: [],
    requirement: '梳理 UDMA jetty 资源回收的调用链、异常路径与影响范围。',
    status: waiting ? 'waiting_user' : 'running',
    steps,
    segment: 0,
    sourceFingerprint: '0c62866aa526ab43f4ad79c95b0ec88ab865f980686533b50705dc4dd89a191d',
    createdAt: new Date(now.getTime() - 4.5 * 60_000).toISOString(),
    startedAt: waiting ? undefined : new Date(now.getTime() - 3.5 * 60_000).toISOString(),
    updatedAt: now.toISOString(),
    logTail: waiting
      ? ['[route] module=udma mode=explore', '[gate] waiting for routing-plan confirmation']
      : [
          '[route] module=udma mode=explore',
          '[source] immutable baseline captured',
          '[runtime] sanitized ub-leader profile loaded',
          '[explore] tracing jetty resource ownership',
        ],
  }
}

function mockHistoryRun(runId: string): WorkflowRun {
  const failed = runId === 'ubw-history-02'
  const steps = buildStageChain({ mode: 'explore' })
  steps[0].status = 'done'
  steps[0].startedAt = '2026-09-04T03:40:00.000Z'
  steps[0].finishedAt = '2026-09-04T03:41:00.000Z'
  steps[1].status = failed ? 'failed' : 'done'
  steps[1].startedAt = '2026-09-04T03:41:00.000Z'
  steps[1].finishedAt = '2026-09-04T03:47:00.000Z'
  steps[1].note = failed ? '源码在探索期间发生变化，结果已拒绝。' : '只读探索结果与源码基线一致。'
  if (failed) steps[1].error = '源码指纹与启动基线不一致；Explore 已失败关闭。'

  return {
    runId,
    repoPath: WORKSPACE_PATH,
    workflowPath: WORKFLOW_PATH,
    sourceRoots: failed
      ? [
          { manifestPath: 'libummu', path: '/workspace/source/libummu' },
          {
            manifestPath: 'drivers/iommu/hisilicon',
            path: '/workspace/source/linux/drivers/iommu/hisilicon',
          },
        ]
      : [{
          manifestPath: 'kernel/drivers/ub/ubase',
          path: '/workspace/source/linux/kernel/drivers/ub/ubase',
        }],
    sessionId: 'preview-session',
    changeId: failed ? 'ummu-mapping-audit-20260904' : 'ubase-reset-trace-20260904',
    module: failed ? 'ummu' : 'ubase',
    mode: 'explore',
    designOnly: false,
    deploy: false,
    testTimings: [],
    requirement: failed
      ? '核对 UMMU stage-2 映射恢复路径。'
      : '梳理 UBASE 设备重置的状态恢复调用链。',
    status: failed ? 'failed' : 'done',
    steps,
    segment: 0,
    sourceFingerprint: '31f9579756539b7bf1cb34ef9c3f98df74e10312a4e7ebf4ab66f38c7cc86fd4',
    createdAt: '2026-09-04T03:40:00.000Z',
    startedAt: '2026-09-04T03:41:00.000Z',
    updatedAt: '2026-09-04T03:47:00.000Z',
    finishedAt: '2026-09-04T03:47:00.000Z',
    logTail: failed
      ? ['[source] baseline captured', '[security] source fingerprint changed', '[failed] Explore rejected']
      : ['[source] baseline captured', '[artifact] exploration_notes.md verified', '[done] read-only Explore complete'],
    ...(failed ? { error: steps[1].error } : {}),
  }
}

function snapshot(): WorkflowStateSnapshot {
  const activeRun = scenario === 'idle' ? null : mockActiveRun(scenario)
  const historyRuns = ['ubw-history-01', 'ubw-history-02'].map(mockHistoryRun)
  return {
    repoPath: WORKSPACE_PATH,
    activeRun,
    runs: [
      ...(activeRun === null ? [] : [{
        runId: activeRun.runId,
        createdAt: activeRun.createdAt,
        status: activeRun.status,
        mode: activeRun.mode,
        changeId: activeRun.changeId,
        module: activeRun.module,
      }]),
      ...historyRuns.map(run => ({
        runId: run.runId,
        createdAt: run.createdAt,
        status: run.status,
        mode: run.mode,
        changeId: run.changeId,
        module: run.module,
      })),
    ],
  }
}

const previewClient: UbWorkflowClient = {
  state: async () => snapshot(),
  runs: async () => ({ runs: ['ubw-history-01', 'ubw-history-02'].map(mockHistoryRun) }),
  run: async runId => ({ run: mockHistoryRun(runId) }),
  launch: async () => {
    scenario = 'waiting'
    const run = mockActiveRun('waiting')
    return { runId: run.runId, run }
  },
  resolveGate: async () => {
    scenario = 'running'
    return { ok: true }
  },
  preview: async () => ({ artifacts: [], evidenceIds: [] }),
  stop: async () => {
    scenario = 'idle'
    return { ok: true }
  },
  delete: async () => ({ ok: true }),
}

function Preview(): JSX.Element {
  const [selected, setSelected] = useState<Scenario>(scenario)
  const select = (next: Scenario): void => {
    scenario = next
    setSelected(next)
  }
  const props = {
    sessionId: 'preview-session',
    t: (key: UbWorkflowKey) => zh[key],
    workflowClient: previewClient,
  } as WorkflowFlowViewProps

  return (
    <div className="dsh-shell">
      <aside className="dsh-sidebar" aria-label="DSH 导航示意">
        <div className="dsh-product"><span>◈</span><strong>DeepSeek</strong></div>
        <button type="button" className="dsh-new-task">＋ 新任务</button>
        <span className="dsh-nav-label">项目</span>
        <div className="dsh-project"><i>UB</i><span>ub-drv-develop</span></div>
        <span className="dsh-nav-label">最近任务</span>
        <div className="dsh-thread active"><i /><span>UDMA jetty 资源回收</span></div>
        <div className="dsh-thread"><i /><span>UMMU 映射审查</span></div>
      </aside>

      <main className="dsh-main">
        <header className="dsh-session-header">
          <div className="dsh-session-row">
            <span>ub-drv-develop</span><b>/</b><strong>UDMA jetty 资源回收</strong>
            <div className="dsh-session-actions" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="dsh-tabs-row">
            <div className="dsh-tabs" role="tablist" aria-label="会话视图">
              <button type="button" role="tab" aria-selected="false">对话</button>
              <button type="button" role="tab" aria-selected="true">UB 工作流</button>
            </div>
            <nav className="preview-toolbar" aria-label="开发预览场景">
              <strong>DEV FIXTURE</strong>
              {(['running', 'waiting', 'idle'] as const).map(item => (
                <button key={item} data-active={selected === item} onClick={() => { select(item) }}>{item}</button>
              ))}
            </nav>
          </div>
        </header>

        <div className="dsh-scroll" data-conversation-scroll="">
          <div className="dsh-view-area">
            <WorkflowFlowView key={selected} {...props} />
          </div>
          <div className="dsh-composer" aria-label="DSH 输入框示意">
            <span>继续输入消息…</span>
            <button type="button" aria-label="发送">↑</button>
          </div>
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
