/** Atomic cross-process ownership for a repository workflow run. */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isSafeWorkflowId } from './core/ids.ts'
import { processStartIdentity } from './processIdentity.ts'

const OWNER_FILE = 'owner.json'
const MAX_OWNER_BYTES = 4_096

interface LeaseOwner {
  version: 2
  runId: string
  changeId: string
  pid: number
  processIdentity: string
  hostInstanceId: string
  token: string
  createdAt: string
}

// A PID can be reused after DSH exits. This nonce exists only for the lifetime
// of the loaded host module, so an on-disk lease from an earlier host instance
// is never adopted merely because the operating system reused its PID.
const HOST_INSTANCE_ID = randomUUID()

export interface RunLease {
  path: string
  owner: LeaseOwner
}

export type RunLeaseResult =
  | { ok: true; lease: RunLease }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pathAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

function realDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function ensureDirectory(path: string, label: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  if (!realDirectory(path)) throw new Error(`${label} must be a real directory`)
}

function leaseRoot(repoPath: string): string {
  const workspace = join(repoPath, 'ub-workspace')
  ensureDirectory(workspace, 'ub-workspace')
  const state = join(workspace, '.dsh-ub-workflow')
  ensureDirectory(state, 'workflow state directory')
  const leases = join(state, 'leases')
  ensureDirectory(leases, 'workflow lease directory')
  return leases
}

function parseOwner(path: string): LeaseOwner | undefined {
  let fd: number | undefined
  try {
    const file = join(path, OWNER_FILE)
    const linked = lstatSync(file)
    if (!linked.isFile() || linked.isSymbolicLink() || linked.size <= 0 || linked.size > MAX_OWNER_BYTES) return undefined
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== linked.dev || before.ino !== linked.ino
      || before.size !== linked.size || before.size <= 0 || before.size > MAX_OWNER_BYTES) return undefined
    const data = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset)
      if (count === 0) return undefined
      offset += count
    }
    const after = fstatSync(fd)
    const linkedAfter = lstatSync(file)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || linkedAfter.isSymbolicLink() || !linkedAfter.isFile()
      || linkedAfter.dev !== after.dev || linkedAfter.ino !== after.ino) return undefined
    const value: unknown = JSON.parse(data.toString('utf8'))
    if (!isRecord(value) || value.version !== 2
      || !isSafeWorkflowId(value.runId) || !isSafeWorkflowId(value.changeId)
      || !Number.isInteger(value.pid) || (value.pid as number) <= 0
      || typeof value.processIdentity !== 'string' || value.processIdentity.length < 3 || value.processIdentity.length > 256
      || typeof value.hostInstanceId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.hostInstanceId)
      || typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return undefined
    return value as unknown as LeaseOwner
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function leaseOwnerIsLive(owner: LeaseOwner): boolean {
  if (!processAlive(owner.pid)) return false
  const identity = processStartIdentity(owner.pid)
  return identity === undefined || identity === owner.processIdentity
}

function reclaimStaleLease(path: string, root: string): boolean {
  const owner = parseOwner(path)
  // Complete leases are first assembled off-path and then published with one
  // atomic rename. An ownerless entry is legacy or damaged and is not safe to
  // recover automatically.
  if (owner === undefined || leaseOwnerIsLive(owner)) return false
  // Keep this deterministic, non-empty tombstone. Every contender for the
  // same stale token targets the same directory, so a delayed rename cannot
  // move a replacement lease over an already-existing tombstone.
  const quarantine = join(root, `.stale-lease-${owner.token}`)
  try {
    renameSync(path, quarantine)
    return true
  } catch {
    return false
  }
}

function createLease(root: string, path: string, changeId: string, runId: string): RunLease {
  const processIdentity = processStartIdentity(process.pid)
  if (processIdentity === undefined) throw new Error('could not determine DSH host process identity')
  const owner: LeaseOwner = {
    version: 2,
    runId,
    changeId,
    pid: process.pid,
    processIdentity,
    hostInstanceId: HOST_INSTANCE_ID,
    token: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  const staging = join(root, `.lease-new-${owner.token}`)
  try {
    mkdirSync(staging, { mode: 0o700 })
    writeFileSync(join(staging, OWNER_FILE), JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
    renameSync(staging, path)
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
    throw error
  }
  return { path, owner }
}

/** Claim the whole repository. mkdir is the cross-process compare-and-set. */
export function claimRunLease(repoPath: string, changeId: string, runId: string): RunLeaseResult {
  if (!isSafeWorkflowId(changeId) || !isSafeWorkflowId(runId)) {
    return { ok: false, reason: 'run/change identifier is unsafe' }
  }
  const root = leaseRoot(repoPath)
  // All workflow runs share the checkout and runs.json. A per-change lock
  // would still allow two host processes to edit source and persist state at
  // the same time, so one stable entry owns the entire repository.
  const path = join(root, 'repository')
  try {
    return { ok: true, lease: createLease(root, path, changeId, runId) }
  } catch (error) {
    if (!pathAlreadyExists(error)) throw error
  }

  if (!reclaimStaleLease(path, root)) {
    const owner = parseOwner(path)
    const detail = owner === undefined ? 'owner record is incomplete or unsafe' : `owned by run ${owner.runId} (pid ${owner.pid})`
    return { ok: false, reason: detail }
  }
  try {
    return { ok: true, lease: createLease(root, path, changeId, runId) }
  } catch (error) {
    if (!pathAlreadyExists(error)) throw error
    const owner = parseOwner(path)
    const detail = owner === undefined ? 'owner is being established' : `owned by run ${owner.runId} (pid ${owner.pid})`
    return { ok: false, reason: detail }
  }
}

/** Release only a lease whose immutable owner token still matches this process. */
export function releaseRunLease(lease: RunLease): boolean {
  const current = parseOwner(lease.path)
  if (current === undefined
    || current.runId !== lease.owner.runId
    || current.changeId !== lease.owner.changeId
    || current.pid !== lease.owner.pid
    || current.processIdentity !== lease.owner.processIdentity
    || current.hostInstanceId !== lease.owner.hostInstanceId
    || current.token !== lease.owner.token) return false
  try {
    const released = join(dirname(lease.path), `.released-lease-${lease.owner.token}-${randomUUID()}`)
    renameSync(lease.path, released)
    rmSync(released, { recursive: true, force: false })
    return true
  } catch {
    return false
  }
}

/** Revalidate the full on-disk owner tuple before every privileged action. */
export function isCurrentRunLease(lease: RunLease): boolean {
  const current = parseOwner(lease.path)
  return current !== undefined
    && current.runId === lease.owner.runId
    && current.changeId === lease.owner.changeId
    && current.pid === lease.owner.pid
    && current.processIdentity === lease.owner.processIdentity
    && current.hostInstanceId === lease.owner.hostInstanceId
    && current.hostInstanceId === HOST_INSTANCE_ID
    && current.token === lease.owner.token
    && current.pid === process.pid
}

/** Whether a persisted run is still protected by its live repository owner. */
export function hasLiveRunLease(repoPath: string, runId: string): boolean {
  if (!isSafeWorkflowId(runId)) return false
  try {
    const owner = parseOwner(join(leaseRoot(repoPath), 'repository'))
    // Recovery asks whether *any* host still owns the repository. Requiring
    // this module's nonce here would let a second DSH process overwrite a
    // healthy first process's active run as failed. Adoption remains stricter
    // below and is limited to this exact host instance.
    return owner?.runId === runId && leaseOwnerIsLive(owner)
  } catch {
    return false
  }
}

/** Reattach an engine rebuilt inside the same still-running host process. */
export function adoptRunLease(repoPath: string, changeId: string, runId: string): RunLease | undefined {
  if (!isSafeWorkflowId(changeId) || !isSafeWorkflowId(runId)) return undefined
  try {
    const path = join(leaseRoot(repoPath), 'repository')
    const owner = parseOwner(path)
    return owner?.pid === process.pid
      && owner.hostInstanceId === HOST_INSTANCE_ID
      && owner.processIdentity === processStartIdentity(process.pid)
      && owner.runId === runId
      && owner.changeId === changeId
      ? { path, owner }
      : undefined
  } catch {
    return undefined
  }
}
