import type { RunMode } from './types.ts'

export interface WorkflowIntent {
  mode: RunMode
  designOnly?: boolean
  deploy?: boolean
}

export const UNSUPPORTED_WORKFLOW_MESSAGE =
  '当前版本仅支持只读 Explore；开发、设计和部署需要 DSH 宿主拥有可审计的 question/permission broker'

/** The single production execution profile currently proven end to end. */
export function isSupportedWorkflowIntent(intent: WorkflowIntent): boolean {
  return intent.mode === 'explore' && intent.designOnly !== true && intent.deploy !== true
}
