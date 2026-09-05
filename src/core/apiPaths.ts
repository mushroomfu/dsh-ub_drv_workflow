/** Logical endpoints carried by DSH's transport-aware Connection RPC. */
export const UB_WORKFLOW_RPC_CHANNEL = '/ub-workflow'

export const UB_WORKFLOW_RPC = {
  state: 'state',
  runs: 'runs',
  run: 'run',
  launch: 'launch',
  gate: 'gate',
  preview: 'preview',
  stop: 'stop',
  delete: 'delete',
} as const
