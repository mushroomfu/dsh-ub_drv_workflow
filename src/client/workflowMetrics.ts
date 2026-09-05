import type { WorkflowRun, WorkflowStep } from '../core/types.ts'

export interface WorkflowMetrics {
  completed: number
  total: number
  currentIndex: number
  progressPercent: number
  elapsedLabel: string
  activeStep?: WorkflowStep
  needsResponse: boolean
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pair = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${pair(hours)}:${pair(minutes)}:${pair(seconds)}` : `${pair(minutes)}:${pair(seconds)}`
}

export function workflowMetrics(run: WorkflowRun, now = new Date()): WorkflowMetrics {
  const total = run.steps.length
  const completed = run.steps.filter(step => step.status === 'done' || step.status === 'skipped').length
  const activeIndex = run.steps.findIndex(step => (
    step.status === 'running' || step.status === 'waiting_user' || step.status === 'failed'
  ))
  const currentIndex = activeIndex < 0 ? Math.max(0, total - 1) : activeIndex
  const activeParent = run.steps[currentIndex]
  const activeSubstep = activeParent?.substeps?.find(step => (
    step.status === 'running' || step.status === 'waiting_user' || step.status === 'failed'
  ))
  const activeStep = activeSubstep ?? activeParent
  const end = run.finishedAt === undefined ? now.getTime() : new Date(run.finishedAt).getTime()
  const start = new Date(run.startedAt ?? run.createdAt).getTime()

  return {
    completed,
    total,
    currentIndex,
    progressPercent: total === 0 ? 0 : Math.round((completed / total) * 100),
    elapsedLabel: formatDuration(end - start),
    activeStep,
    needsResponse: activeStep?.status === 'waiting_user' && activeStep.interaction === 'response',
  }
}
