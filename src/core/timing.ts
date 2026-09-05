const DEFAULT_POLL_MS = 1500

/** Keep host polling responsive without allowing invalid or runaway intervals. */
export function normalizePollMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_POLL_MS
  return Math.min(60_000, Math.max(250, value))
}
