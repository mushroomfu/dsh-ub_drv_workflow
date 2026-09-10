/**
 * Stage-chain definitions derived from `skills/ub-workflow/routing.md` in the
 * UB repository. This file is framework-free: it only builds data structures.
 */

import type { RunMode, StepId, WorkflowStep } from './types.ts'

export const STEP_META: Record<StepId, {
  title: string
  description: string
  needsUser: boolean
  gate?: WorkflowStep['gate']
}> = {
  routing: {
    title: '路由与流程计划',
    description: '识别模块 → 判定流程类型 → 生成阶段链与 workspace 建立计划',
    needsUser: false,
  },
  'routing-plan': {
    title: '路由计划确认',
    description: '阶段链与 workspace 计划已生成，等待用户确认',
    needsUser: true,
    gate: 'routing-plan',
  },
  requirement: {
    title: '需求分析与澄清',
    description: 'dispatch ub-design：澄清问题、影响分析、内容清单，产出需求分析文档',
    needsUser: false,
  },
  design: {
    title: '详细设计 / delta spec / STC',
    description: '架构、接口、数据结构、delta spec 与 STC 用例生成',
    needsUser: false,
  },
  'design-gate': {
    title: '设计门禁',
    description: '设计覆盖需求 + 影响分析 + 规范依据 + STC 已生成，等待用户确认',
    needsUser: true,
    gate: 'design-gate',
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
  test: {
    title: '单元测试',
    description: 'dispatch ub-UT：用例生成、mock、编译执行、覆盖率检查',
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
  'deploy-ok': {
    title: '部署验证门禁',
    description: 'RPM 安装成功 + 目标文件验证通过，等待用户确认',
    needsUser: true,
    gate: 'deploy-ok',
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

/**
 * Relative artifact paths (from the change workspace) marking a step complete.
 * Multiple paths are AND-ed; `|` separates alternative names accepted for the
 * same deliverable (legacy ub-leader layout | current harness workflow layout).
 */
export const ARTIFACT_HINTS: Record<StepId, string[]> = {
  routing: ['.knowledge/events.ndjson'],
  'routing-plan': [],
  requirement: ['requirement_analysis.md'],
  design: ['detailed_design.md', 'delta/**/*.md|delta-spec.md'],
  'design-gate': [],
  develop: ['implementation_notes.md', 'patch/*.patch|patch/*.md'],
  'develop.implement': ['implementation_notes.md'],
  'develop.patch': ['patch/*.patch|patch/*.md', 'patch_report.md|patch/README.md'],
  'develop.pre-review': ['pre_review_report.md'],
  'develop.compile': ['compile_report.md'],
  test: ['test_report.md'],
  review: ['module_review_report.md'],
  verify: ['deploy_report.md|verify_report.md'],
  'deploy-ok': [],
  closeout: ['workflow_report.md', 'archive_report.md'],
  explore: ['exploration_notes.md'],
}

function makeStep(id: StepId, status: WorkflowStep['status'] = 'pending'): WorkflowStep {
  const meta = STEP_META[id]
  return {
    id,
    title: meta.title,
    description: meta.description,
    status,
    needsUser: meta.needsUser,
    gate: meta.gate,
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
 * - designOnly: routing → routing-plan → requirement → design → design-gate (terminal).
 * - dev: routing → routing-plan → requirement → design → design-gate → develop → test → review → closeout.
 * - full: dev + verify → deploy-ok before closeout.
 * - explore: single explore step.
 */
export function buildStageChain(options: {
  mode: RunMode
  designOnly?: boolean
  deploy?: boolean
  initial?: WorkflowStep['status']
}): WorkflowStep[] {
  const { mode, designOnly = false, deploy = false, initial = 'pending' } = options

  if (mode === 'explore') return [makeStep('explore', initial)]

  if (designOnly) {
    return [
      makeStep('routing', initial),
      makeStep('routing-plan', initial),
      makeStep('requirement', initial),
      makeStep('design', initial),
      makeStep('design-gate', initial),
    ]
  }

  const chain: StepId[] = [
    'routing',
    'routing-plan',
    'requirement',
    'design',
    'design-gate',
    'develop',
    'test',
    'review',
  ]

  if (mode === 'full' && deploy) {
    chain.push('verify', 'deploy-ok')
  }

  chain.push('closeout')

  return chain.map(id => makeStep(id, initial))
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