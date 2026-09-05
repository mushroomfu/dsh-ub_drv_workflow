import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimRunLease, isCurrentRunLease, releaseRunLease } from '../src/runLease.ts'

describe('repository workflow lease', () => {
  it('blocks a second process-equivalent owner even when the change id differs', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-'))
    const first = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = claimRunLease(repoPath, 'change-b', 'run-b')
    expect(second).toMatchObject({ ok: false, reason: expect.stringContaining('run-a') })

    expect(releaseRunLease(first.lease)).toBe(true)
    const afterRelease = claimRunLease(repoPath, 'change-b', 'run-b')
    expect(afterRelease.ok).toBe(true)
    if (afterRelease.ok) expect(releaseRunLease(afterRelease.lease)).toBe(true)
  })

  it('validates the complete owner token before mutation or release', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-token-'))
    const claimed = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return

    const ownerPath = join(claimed.lease.path, 'owner.json')
    const original = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>
    writeFileSync(ownerPath, JSON.stringify({ ...original, token: 'f'.repeat(64) }))

    expect(isCurrentRunLease(claimed.lease)).toBe(false)
    expect(releaseRunLease(claimed.lease)).toBe(false)

    writeFileSync(ownerPath, JSON.stringify(original))
    expect(releaseRunLease(claimed.lease)).toBe(true)
  })

  it('recovers a dead owner atomically and keeps a tombstone that protects the replacement lease', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-recovery-'))
    const first = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const ownerPath = join(first.lease.path, 'owner.json')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 2_147_483_647 }))
    const recovered = claimRunLease(repoPath, 'change-b', 'run-b')
    expect(recovered.ok).toBe(true)
    expect(existsSync(join(first.lease.path, '..', `.stale-lease-${String(owner.token)}`))).toBe(true)
    const delayed = claimRunLease(repoPath, 'change-c', 'run-c')
    expect(delayed).toMatchObject({ ok: false, reason: expect.stringContaining('run-b') })
    if (recovered.ok) {
      expect(JSON.parse(readFileSync(join(recovered.lease.path, 'owner.json'), 'utf8'))).toMatchObject({ runId: 'run-b' })
      expect(releaseRunLease(recovered.lease)).toBe(true)
    }
  })

  it('ignores a legacy crashed recovery guard because recovery no longer depends on recursive guards', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-old-guard-'))
    const first = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const ownerPath = join(first.lease.path, 'owner.json')
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Record<string, unknown>
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 2_147_483_647 }))
    mkdirSync(join(first.lease.path, '..', '.repository-recovery'))

    const recovered = claimRunLease(repoPath, 'change-b', 'run-b')
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(releaseRunLease(recovered.lease)).toBe(true)
  })

  it('rejects a FIFO owner record without blocking', () => {
    if (process.platform === 'win32') return
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-fifo-'))
    const claimed = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    const ownerPath = join(claimed.lease.path, 'owner.json')
    unlinkSync(ownerPath)
    expect(spawnSync('mkfifo', [ownerPath]).status).toBe(0)
    expect(isCurrentRunLease(claimed.lease)).toBe(false)
  })

  it('rejects an oversized owner record', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-lease-large-'))
    const claimed = claimRunLease(repoPath, 'change-a', 'run-a')
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) return
    writeFileSync(join(claimed.lease.path, 'owner.json'), 'x'.repeat(4097))
    expect(isCurrentRunLease(claimed.lease)).toBe(false)
  })
})
