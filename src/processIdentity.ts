/** Stable OS process birth identity used to distinguish PID reuse. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0
}

export function processStartIdentity(pid: number): string | undefined {
  if (!validPid(pid)) return undefined
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close < 0) return undefined
      // Tokens after comm start at field 3; starttime is field 22.
      const startTicks = stat.slice(close + 2).trim().split(/\s+/)[19]
      return /^\d+$/.test(startTicks ?? '') ? `linux:${startTicks}` : undefined
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
      const value = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1_000, maxBuffer: 4_096,
      }).trim().replace(/\s+/g, ' ')
      return value === '' ? undefined : `bsd:${value}`
    }
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096, windowsHide: true }).trim()
      return /^\d+$/.test(value) ? `windows:${value}` : undefined
    }
  } catch {}
  return undefined
}
