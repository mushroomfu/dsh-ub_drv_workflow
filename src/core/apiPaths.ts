/** Shared loopback route paths (browser + host both import this file). */
export const UB_WORKFLOW_API = {
  state: '/api/ub-workflow/state',
  runs: '/api/ub-workflow/runs',
  run: '/api/ub-workflow/run',
  gate: '/api/ub-workflow/gate',
  stop: '/api/ub-workflow/stop',
  delete: '/api/ub-workflow/delete',
} as const