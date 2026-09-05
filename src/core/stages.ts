/**
 * Stage-chain definitions derived from `skills/ub-workflow/routing.md` in the
 * UB repository. This file is framework-free: it only builds data structures.
 */

import type { RunMode, StepId, TestTiming, WorkflowStep } from './types.ts'

export const STEP_META: Record<StepId, {
  title: string
  description: string
  needsUser: boolean
  gate?: WorkflowStep['gate']
  interaction?: WorkflowStep['interaction']
}> = {
  'routing-plan': {
    title: '路由与流程计划',
    description: '识别模块 → 判定流程类型 → 生成阶段链与 workspace 建立计划，等待用户确认',
    needsUser: true,
    gate: 'routing-plan',
  },
  requirement: {
    title: '需求分析与澄清',
    description: '生成澄清问题、影响分析与内容清单草案，等待开发者补充上下文',
    needsUser: false,
  },
  'requirement-clarify': {
    title: '需求澄清门禁',
    description: '回答澄清问题并确认或修正内容清单；回复将续传给 ub-design',
    needsUser: true,
    gate: 'requirement-clarify',
    interaction: 'response',
  },
  design: {
    title: '详细设计 / delta spec / STC',
    description: '架构、接口、数据结构、delta spec 与 STC 用例生成',
    needsUser: false,
  },
  'design-gate': {
    title: '设计门禁',
    description: '审阅需求、详细设计、规范依据与 STC；开发流程同时收集实名签名和编译策略',
    needsUser: true,
    gate: 'design-gate',
  },
  'design-summary': {
    title: '设计确认总结',
    description: '记录需求、设计、STC 与门禁确认状态，完成只设计流程交付',
    needsUser: false,
  },
  develop: {
    title: '编码实现',
    description: '实现 → 社区合规 patch → pre-review → 远程编译 + 自动修复（单次 dispatch 内部串行）',
    needsUser: false,
  },
  'develop.implement': {
    title: '代码实现',
    description: '基于设计与模块知识生成源码，产出实现说明',
    needsUser: false,
  },
  'develop.patch': {
    title: '社区合规补丁',
    description: 'patch 生成 + checkpatch/SPDX/Kconfig 校验',
    needsUser: false,
  },
  'develop.pre-review': {
    title: '编码后质量预检',
    description: 'checkpatch / SPDX / Kconfig 预检，无阻断 Error 才可编译',
    needsUser: false,
  },
  'develop.compile': {
    title: '编译验证',
    description: '远程编译，失败自动修复（max-retries 内）',
    needsUser: false,
  },
  'test.pre-dev': {
    title: '开发前 RED 测试',
    description: '按模块 manifest 以 pre-dev 时机执行 ub-UT，先证明新增测试会按预期失败',
    needsUser: false,
  },
  'test.post-dev': {
    title: '开发后单元测试',
    description: '按模块 manifest 以 post-dev 时机执行 ub-UT，验证实现与覆盖率',
    needsUser: false,
  },
  'test.regression': {
    title: '回归测试',
    description: '按模块 manifest 以 regression 时机执行 ub-UT，检查完整回归结果',
    needsUser: false,
  },
  review: {
    title: '代码审查',
    description: 'dispatch ub-review：正确性 / 完整性 / 一致性 / 规范 独立审查',
    needsUser: false,
  },
  verify: {
    title: '部署与 STC 验证',
    description: 'dispatch ub-verify：RPM 打包、EVB 部署、STC 执行（full 模式）',
    needsUser: false,
  },
  'verify-deploy': {
    title: 'EVB 部署验证',
    description: 'RPM 分类、上传与安装，完成目标文件和内核版本验证',
    needsUser: false,
  },
  'deploy-authorize': {
    title: '部署计划与实时授权',
    description: '确认目标 IP、验证模块、STC 与本次 live 部署授权，再启动 ub-verify',
    needsUser: true,
    gate: 'deploy-authorize',
    interaction: 'response',
  },
  'deploy-ok': {
    title: '部署结果确认',
    description: 'RPM 安装成功且目标文件验证通过后确认结果，再继续部署后 STC',
    needsUser: true,
    gate: 'deploy-ok',
    interaction: 'confirm',
  },
  'verify-stc': {
    title: '部署后 STC 验证',
    description: '执行 required STC 用例并采集 ALIVE、日志与环境证据',
    needsUser: false,
  },
  closeout: {
    title: '交付归档',
    description: 'workflow 报告 + delta spec 归档 + 知识结晶登记',
    needsUser: false,
  },
  explore: {
    title: '探索模式',
    description: '只产 exploration_notes.md，不改代码',
    needsUser: false,
  },
}

/** Relative artifact paths (from the change workspace) marking a step complete. */
export const ARTIFACT_HINTS: Record<StepId, string[]> = {
  'routing-plan': [],
  requirement: ['requirement_analysis.md'],
  'requirement-clarify': [],
  design: [
    'detailed_design.md',
    'delta/**/*.md',
    '*-stc-output/*_STC_Testcases.json',
    '*-stc-output/*_STC_Testcases.xlsx',
    '*-stc-output/scripts/run_stc.sh',
    '*-stc-output/scripts/verify_*.sh',
    '*-stc-output/review_report.*',
  ],
  'design-gate': [],
  'design-summary': ['design_only_summary.md'],
  develop: [
    'implementation_notes.md',
    'patch/*.patch',
    'patch_report.md',
    'pre_review_report.md',
    'compile_report.md',
  ],
  'develop.implement': ['implementation_notes.md'],
  'develop.patch': ['patch/*.patch', 'patch_report.md'],
  'develop.pre-review': ['pre_review_report.md'],
  'develop.compile': ['compile_report.md'],
  'test.pre-dev': ['test_report.md'],
  'test.post-dev': ['test_report.md'],
  'test.regression': ['test_report.md'],
  review: ['module_review_report.md'],
  'deploy-authorize': [],
  'verify-deploy': ['deploy_report.md'],
  verify: ['deploy_report.md'],
  'deploy-ok': [],
  'verify-stc': ['stc_exec_report.md'],
  closeout: [
    'workflow_report.md',
    'archive_report.md',
    '.knowledge/events.ndjson',
    '.knowledge/retrieved.json',
    '.knowledge/episode.json',
    '.knowledge/candidates.json',
    '.knowledge/registry-receipt.json',
  ],
  explore: ['exploration_notes.md'],
}

function makeStep(
  id: StepId,
  status: WorkflowStep['status'] = 'pending',
  interaction?: WorkflowStep['interaction'],
): WorkflowStep {
  const meta = STEP_META[id]
  return {
    id,
    title: meta.title,
    description: meta.description,
    status,
    needsUser: meta.needsUser,
    gate: meta.gate,
    interaction: interaction ?? meta.interaction ?? (meta.gate === undefined ? undefined : 'confirm'),
    artifactHints: ARTIFACT_HINTS[id],
    ...(id === 'develop'
      ? {
          substeps: [
            makeStep('develop.implement'),
            makeStep('develop.patch'),
            makeStep('develop.pre-review'),
            makeStep('develop.compile'),
          ],
        }
      : {}),
  }
}

/**
 * Build the main step chain for a run.
 * - designOnly: routing → requirement → clarification → design → gate → confirmed summary.
 * - dev: designOnly chain + develop → test → review → closeout.
 * - full with deploy: dev chain + live authorization → one ub-verify dispatch
 *   (deploy then STC internally) → closeout.
 * - explore: routing confirmation → one read-only explore step.
 */
export function buildStageChain(options: {
  mode: RunMode
  testTimings?: readonly TestTiming[]
  designOnly?: boolean
  deploy?: boolean
  initial?: WorkflowStep['status']
}): WorkflowStep[] {
  const { mode, testTimings = [], designOnly = false, deploy = false, initial = 'pending' } = options

  if (mode === 'explore') return [makeStep('routing-plan', initial), makeStep('explore', initial)]

  if (designOnly) {
    return [
      makeStep('routing-plan', initial),
      makeStep('requirement', initial),
      makeStep('requirement-clarify', initial),
      makeStep('design', initial),
      makeStep('design-gate', initial, 'confirm'),
      makeStep('design-summary', initial),
    ]
  }

  const hasPreDevTest = testTimings.includes('pre-dev')
  const hasPostDevTest = testTimings.includes('post-dev')
  const hasRegressionTest = testTimings.includes('regression')
  const chain: StepId[] = [
    'routing-plan',
    'requirement',
    'requirement-clarify',
    'design',
    'design-gate',
    ...(hasPreDevTest ? ['test.pre-dev' as const] : []),
    'develop',
    ...(hasPostDevTest ? ['test.post-dev' as const] : []),
    ...(hasRegressionTest ? ['test.regression' as const] : []),
    'review',
  ]

  if (mode === 'full' && deploy) chain.push('deploy-authorize', 'verify-deploy', 'deploy-ok', 'verify-stc')

  chain.push('closeout')

  return chain.map(id => makeStep(id, initial, id === 'design-gate' ? 'response' : undefined))
}

/** Flatten main steps and develop substeps in display order. */
export function allSteps(runSteps: WorkflowStep[]): WorkflowStep[] {
  const out: WorkflowStep[] = []
  for (const step of runSteps) {
    out.push(step)
    if (step.substeps !== undefined) out.push(...step.substeps)
  }
  return out
}

/** First step that is not done/skipped, in canonical order. */
export function firstUnfinished(runSteps: WorkflowStep[]): WorkflowStep | undefined {
  return runSteps.find(step => step.status !== 'done' && step.status !== 'skipped')
}

/** The step immediately before `stepId` in the canonical main-step order. */
export function previousStep(runSteps: WorkflowStep[], stepId: StepId): WorkflowStep | undefined {
  const index = runSteps.findIndex(step => step.id === stepId)
  return index > 0 ? runSteps[index - 1] : undefined
}

/** Aggregate status of a parent step with substeps. */
export function aggregateSubsteps(parent: WorkflowStep): WorkflowStep['status'] {
  if (parent.substeps === undefined || parent.substeps.length === 0) return parent.status
  const statuses = parent.substeps.map(s => s.status)
  if (statuses.every(s => s === 'done')) return 'done'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'running' || s === 'waiting_user')) return 'running'
  return 'pending'
}
