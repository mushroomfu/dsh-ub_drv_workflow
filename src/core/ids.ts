/** Matches the upstream workflow's safe identifier contract. */
export const SAFE_WORKFLOW_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSafeWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_WORKFLOW_ID_RE.test(value)
}
