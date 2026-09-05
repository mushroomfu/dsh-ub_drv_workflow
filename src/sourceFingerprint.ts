/** Bounded, command-inert Git fingerprint used by Explore's read-only contract. */

import { spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_GIT_OUTPUT = 32 * 1024 * 1024
const MAX_SOURCE_FILES = 16_384
const MAX_SOURCE_BYTES = 256 * 1024 * 1024
const GIT_TIMEOUT_MS = 5_000
const FINGERPRINT_TIMEOUT_MS = 12_000
const READ_CHUNK_BYTES = 1024 * 1024

export type SourceFingerprintResult =
  | { ok: true; fingerprint: string }
  | { ok: false; error: string }

function gitEnvironment(): NodeJS.ProcessEnv {
  // Only retain variables needed to locate and launch Git. In particular,
  // inherited GIT_CONFIG_COUNT/KEY/VALUE, GIT_DIR, and diff-driver variables
  // must not be able to redirect or extend this read-only probe.
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  }
}

async function git(repoPath: string, args: readonly string[], deadline: number): Promise<Buffer | undefined> {
  const remaining = Math.min(GIT_TIMEOUT_MS, deadline - Date.now())
  if (remaining <= 0) return undefined
  return await new Promise(resolveResult => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', [
        '--no-pager',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=',
        ...args,
      ], {
        cwd: repoPath,
        env: gitEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolveResult(undefined)
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    let invalid = false
    let settled = false
    const finish = (value: Buffer | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(value)
    }
    const timer = setTimeout(() => {
      invalid = true
      child.kill('SIGKILL')
      finish(undefined)
    }, remaining)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (invalid) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_GIT_OUTPUT) {
        invalid = true
        child.kill('SIGKILL')
        finish(undefined)
        return
      }
      chunks.push(buffer)
    })
    child.once('error', () => { invalid = true; finish(undefined) })
    child.once('close', code => {
      finish(!invalid && code === 0 ? Buffer.concat(chunks, bytes) : undefined)
    })
  })
}

function safeRelativePath(repoPath: string, path: string): string | undefined {
  if (path === '' || path.includes('\0') || path.includes('\ufffd') || isAbsolute(path)
    || path.startsWith('\\') || path.split(/[\\/]/).some(segment => segment === '..')) return undefined
  const target = resolve(repoPath, path)
  const rel = relative(repoPath, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return target
}

async function verifyAncestors(repoPath: string, target: string): Promise<boolean> {
  const repoReal = await realpath(repoPath)
  const parent = relative(repoPath, target).split(sep).slice(0, -1)
  let current = repoPath
  for (const segment of parent) {
    current = join(current, segment)
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  }
  const parentReal = await realpath(join(target, '..'))
  const rel = relative(repoReal, parentReal)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function hashStableFile(
  hash: Hash,
  repoPath: string,
  path: string,
  target: string,
  deadline: number,
): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  let handle: FileHandle | undefined
  try {
    if (Date.now() >= deadline || !await verifyAncestors(repoPath, target)) {
      return { ok: false, error: `源码路径不稳定或超时：${path}` }
    }
    const linked = await lstat(target)
    if (linked.isSymbolicLink()) return { ok: false, error: `源码树包含符号链接：${path}` }
    if (!linked.isFile()) return { ok: false, error: `源码树包含非普通文件：${path}` }
    if (linked.size > MAX_SOURCE_BYTES) return { ok: false, error: `源码文件超过安全上限：${path}` }
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = await handle.stat()
    if (!before.isFile() || !sameFile(linked, before)) {
      return { ok: false, error: `源码在打开期间发生变化：${path}` }
    }
    hash.update('file\0').update(path).update('\0').update(String(linked.mode & 0o777)).update('\0')
      .update(String(linked.size)).update('\0')
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, linked.size)))
    let offset = 0
    while (offset < linked.size) {
      if (Date.now() >= deadline) return { ok: false, error: '源码基线计算超时' }
      const length = Math.min(buffer.byteLength, linked.size - offset)
      const result = await handle.read(buffer, 0, length, offset)
      if (result.bytesRead <= 0) return { ok: false, error: `源码读取提前结束：${path}` }
      hash.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    const after = await handle.stat()
    const linkedAfter = await lstat(target)
    if (!sameFile(before, after) || linkedAfter.isSymbolicLink() || !linkedAfter.isFile()
      || !sameFile(after, linkedAfter) || !await verifyAncestors(repoPath, target)) {
      return { ok: false, error: `源码在读取期间发生变化：${path}` }
    }
    hash.update('\0')
    return { ok: true, size: linked.size }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
    if (code === 'ENOENT') {
      hash.update('missing\0').update(path).update('\0')
      return { ok: true, size: 0 }
    }
    return { ok: false, error: `无法安全读取源码：${path}` }
  } finally {
    await handle?.close().catch(() => {})
  }
}

interface TrackedEntry { mode: string; objectId: string; stage: string; path: string }

interface RepositoryScope {
  repoPath: string
  roots: string[]
}

function parseTracked(output: Buffer): { ok: true; entries: TrackedEntry[] } | { ok: false; error: string } {
  const entries: TrackedEntry[] = []
  const seen = new Set<string>()
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t')
    const match = tab < 0 ? undefined : /^(\d{6}) ([0-9a-f]{40,64}) (\d)$/.exec(record.slice(0, tab))
    const path = tab < 0 ? '' : record.slice(tab + 1)
    if (match === undefined || match === null || safeRelativePath('.', path) === undefined) {
      return { ok: false, error: 'Git 索引包含无法安全解析的路径' }
    }
    if (match[3] !== '0') return { ok: false, error: `Explore 不接受存在冲突的索引：${path}` }
    if (match[1] === '120000') return { ok: false, error: `Explore 不接受源码树中的受跟踪符号链接：${path}` }
    if (match[1] === '160000') return { ok: false, error: `Explore 不接受未纳入指纹的子模块：${path}` }
    if (match[1] !== '100644' && match[1] !== '100755') {
      return { ok: false, error: `Explore 不接受特殊 Git 文件模式：${path}` }
    }
    if (seen.has(path)) return { ok: false, error: `Git 索引包含重复路径：${path}` }
    seen.add(path)
    entries.push({ mode: match[1], objectId: match[2], stage: match[3], path })
  }
  return { ok: true, entries }
}

function inScope(path: string, roots: readonly string[]): boolean {
  return roots.some(root => root === '.' || path === root || path.startsWith(`${root}/`))
}

function excludedByWorkspace(path: string, repoPath: string, workspacePath: string | undefined): boolean {
  if (workspacePath === undefined) return false
  const rel = relative(repoPath, resolve(workspacePath)).split(sep).join('/')
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false
  return path === rel || path.startsWith(`${rel}/`)
}

async function repositoryScopes(
  sourceRoots: readonly string[],
  deadline: number,
): Promise<{ ok: true; scopes: RepositoryScope[] } | { ok: false; error: string }> {
  if (sourceRoots.length === 0 || sourceRoots.length > 16) {
    return { ok: false, error: '源码根目录数量必须为 1-16' }
  }
  const grouped = new Map<string, Set<string>>()
  for (const configured of sourceRoots) {
    try {
      if (typeof configured !== 'string' || configured === '' || configured.length > 4_096
        || /[\u0000-\u001f\u007f]/.test(configured)) {
        return { ok: false, error: '源码根目录路径无效' }
      }
      const linked = await lstat(configured)
      if (!linked.isDirectory() || linked.isSymbolicLink()) {
        return { ok: false, error: `源码根目录必须是普通目录：${configured}` }
      }
      const root = await realpath(configured)
      const output = await git(root, ['rev-parse', '--show-toplevel'], deadline)
      const text = output?.toString('utf8').trim()
      if (text === undefined || text === '' || text.includes('\0') || /[\r\n]/.test(text)) {
        return { ok: false, error: `源码根目录不属于可读取的 Git 仓库：${configured}` }
      }
      const repository = await realpath(resolve(text))
      const repositoryStat = await lstat(repository)
      if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink()) {
        return { ok: false, error: `Git 仓库根目录不安全：${text}` }
      }
      const rel = relative(repository, root)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { ok: false, error: `源码根目录越过 Git 仓库边界：${configured}` }
      }
      const portable = rel === '' ? '.' : rel.split(sep).join('/')
      const roots = grouped.get(repository) ?? new Set<string>()
      roots.add(portable)
      grouped.set(repository, roots)
    } catch {
      return { ok: false, error: `无法安全解析源码根目录：${configured}` }
    }
  }
  return {
    ok: true,
    scopes: [...grouped.entries()]
      .map(([repoPath, roots]) => ({ repoPath, roots: [...roots].sort() }))
      .sort((left, right) => left.repoPath.localeCompare(right.repoPath)),
  }
}

/**
 * Hash the raw index entries and working files under the selected manifest
 * roots only. Roots may belong to independent Git repositories. Deliberately
 * avoid `git diff`: repository textconv/clean/process filters may execute
 * commands even with external diffs disabled.
 */
export async function captureSourceFingerprint(
  sourceRoots: readonly string[],
  workspacePath?: string,
): Promise<SourceFingerprintResult> {
  const deadline = Date.now() + FINGERPRINT_TIMEOUT_MS
  const resolved = await repositoryScopes(sourceRoots, deadline)
  if (!resolved.ok) return resolved
  const hash = createHash('sha256').update('dsh-source-fingerprint-v3\0')
  let files = 0
  let bytes = 0
  for (const scope of resolved.scopes) {
    const [trackedOutput, untrackedOutput] = await Promise.all([
      git(scope.repoPath, ['ls-files', '-z', '--stage', '--', ...scope.roots], deadline),
      git(scope.repoPath, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...scope.roots], deadline),
    ])
    if (trackedOutput === undefined || untrackedOutput === undefined) {
      return { ok: false, error: `无法在 ${GIT_TIMEOUT_MS}ms 内读取 Git 源码基线` }
    }
    const tracked = parseTracked(trackedOutput)
    if (!tracked.ok) return tracked
    if (tracked.entries.some(entry => !inScope(entry.path, scope.roots))) {
      return { ok: false, error: 'Git 返回了源码范围外的索引路径' }
    }
    const untracked = [...new Set(untrackedOutput.toString('utf8').split('\0').filter(Boolean))]
      .filter(path => !excludedByWorkspace(path, scope.repoPath, workspacePath))
      .sort()
    if (untracked.some(path => safeRelativePath(scope.repoPath, path) === undefined || !inScope(path, scope.roots))) {
      return { ok: false, error: 'Git 返回了不安全或越界的未跟踪源码路径' }
    }
    const trackedEntries = tracked.entries.filter(entry => !excludedByWorkspace(entry.path, scope.repoPath, workspacePath))
    const trackedPaths = new Set(trackedEntries.map(entry => entry.path))
    if (untracked.some(path => trackedPaths.has(path))) return { ok: false, error: 'Git 返回了重复的源码路径' }
    const paths = [
      ...trackedEntries.map(entry => ({
        path: entry.path,
        indexMode: entry.mode,
        indexObjectId: entry.objectId,
        indexStage: entry.stage,
      })),
      ...untracked.map(path => ({
        path,
        indexMode: 'untracked',
        indexObjectId: '',
        indexStage: '',
      })),
    ].sort((left, right) => left.path.localeCompare(right.path))
    files += paths.length
    if (files > MAX_SOURCE_FILES) return { ok: false, error: '所选源码文件数量超过安全上限' }

    hash.update('repository\0').update(scope.repoPath).update('\0')
    for (const root of scope.roots) hash.update('root\0').update(root).update('\0')
    for (const entry of paths) {
      if (Date.now() >= deadline) return { ok: false, error: '源码基线计算超时' }
      const target = safeRelativePath(scope.repoPath, entry.path)
      if (target === undefined) return { ok: false, error: 'Git 返回了不安全的源码路径' }
      hash.update('index-entry\0')
        .update(entry.indexMode).update('\0')
        .update(entry.indexObjectId).update('\0')
        .update(entry.indexStage).update('\0')
        .update(entry.path).update('\0')
      const result = await hashStableFile(hash, scope.repoPath, entry.path, target, deadline)
      if (!result.ok) return result
      bytes += result.size
      if (bytes > MAX_SOURCE_BYTES) return { ok: false, error: '所选源码内容超过安全上限' }
    }
  }
  return { ok: true, fingerprint: hash.digest('hex') }
}
