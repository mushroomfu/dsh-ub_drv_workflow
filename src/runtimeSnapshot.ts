/** Immutable-per-run snapshot of the upstream workflow agents, skills, and references. */

import { createHash } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

export const REQUIRED_RUNTIME_AGENTS = [
  'ub-leader', 'ub-design', 'ub-develop', 'ub-UT', 'ub-review',
] as const

export const REQUIRED_RUNTIME_SKILLS = [
  'ub-workflow', 'ub-requirement', 'ub-design', 'ub-develop',
  'ub-patch', 'ub-compile', 'ub-UT', 'ub-review', 'ub-puml',
] as const

const MAX_RUNTIME_FILES = 512
const MAX_RUNTIME_BYTES = 16 * 1024 * 1024
const MAX_RUNTIME_DEPTH = 8

export interface RuntimeSnapshot {
  configDir: string
  digest: string
  files: string[]
  sources: Array<{ path: string; sha256: string; size: number }>
}

interface CopyBudget { files: number; bytes: number }

interface DirectoryWitness {
  path: string
  stat: Stats
  fd?: number
}

function realDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function directoryPaths(root: string, file: string): string[] {
  const parent = dirname(file)
  const tail = relative(root, parent)
  if (tail.startsWith('..') || isAbsolute(tail)) throw new Error(`trusted runtime file escapes its root: ${file}`)
  const out = [root]
  let current = root
  for (const segment of tail.split(sep).filter(Boolean)) {
    current = join(current, segment)
    out.push(current)
  }
  return out
}

function witnessDirectory(path: string): DirectoryWitness {
  const linked = lstatSync(path)
  if (!linked.isDirectory() || linked.isSymbolicLink()) throw new Error(`trusted runtime ancestor is unsafe: ${path}`)
  if (process.platform === 'win32') return { path, stat: linked }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0))
  const opened = fstatSync(fd)
  if (!opened.isDirectory() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
    closeSync(fd)
    throw new Error(`trusted runtime ancestor changed while opening: ${path}`)
  }
  return { path, stat: opened, fd }
}

function verifyDirectoryWitnesses(witnesses: readonly DirectoryWitness[]): void {
  for (const witness of witnesses) {
    const linked = lstatSync(witness.path)
    const opened = witness.fd === undefined ? linked : fstatSync(witness.fd)
    if (!linked.isDirectory() || linked.isSymbolicLink()
      || !sameIdentity(witness.stat, opened)
      || linked.dev !== opened.dev || linked.ino !== opened.ino) {
      throw new Error(`trusted runtime ancestor changed while reading: ${witness.path}`)
    }
  }
}

function stableRegularFile(
  root: string,
  path: string,
  maxBytes = MAX_RUNTIME_BYTES,
  expectedSize?: number,
): { data: Buffer; stat: Stats } {
  const witnesses = directoryPaths(root, path).map(witnessDirectory)
  let fd: number | undefined
  try {
    const linked = lstatSync(path)
    if (!linked.isFile() || linked.isSymbolicLink() || linked.size <= 0 || linked.size > maxBytes
      || (expectedSize !== undefined && linked.size !== expectedSize)) {
      throw new Error(`trusted runtime file must be regular and non-empty: ${path}`)
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== linked.dev || before.ino !== linked.ino || before.size !== linked.size) {
      throw new Error(`trusted runtime file changed while opening: ${path}`)
    }
    const data = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset)
      if (count === 0) throw new Error(`trusted runtime file ended unexpectedly: ${path}`)
      offset += count
    }
    const after = fstatSync(fd)
    const linkedAfter = lstatSync(path)
    if (!sameIdentity(before, after) || linkedAfter.isSymbolicLink() || !linkedAfter.isFile()
      || linkedAfter.dev !== after.dev || linkedAfter.ino !== after.ino) {
      throw new Error(`trusted runtime file changed while reading: ${path}`)
    }
    verifyDirectoryWitnesses(witnesses)
    return { data, stat: before }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    for (const witness of [...witnesses].reverse()) {
      if (witness.fd !== undefined) try { closeSync(witness.fd) } catch {}
    }
  }
}

function frozenContent(path: string, data: Buffer, configDir: string): Buffer {
  if (!path.endsWith('.md')) return data
  const prefix = configDir.replace(/\\/g, '/')
  return Buffer.from(data.toString('utf8')
    .replace(/(^|[^A-Za-z0-9_.\/-])skills\//g, `$1${prefix}/skills/`)
    .replace(/(^|[^A-Za-z0-9_.\/-])agents\//g, `$1${prefix}/agents/`)
    .replace(/(^|[^A-Za-z0-9_.\/-])references\//g, `$1${prefix}/references/`))
}

function frozenAgentContent(agent: string, data: Buffer, configDir: string): Buffer {
  const text = data.toString('utf8')
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)
  const body = (frontmatter === null ? text : text.slice(frontmatter[0].length)).trim()
  if (body === '') throw new Error(`trusted runtime agent is empty: ${agent}`)
  // Agent markdown is loaded before OPENCODE_CONFIG_CONTENT and deep-merged.
  // Rebuild the metadata so permissive upstream permission keys cannot retain
  // their old insertion order and override the final deny-first profile.
  const header = [
    '---',
    `name: ${agent}`,
    `description: Frozen ${agent} workflow agent`,
    `mode: ${agent === 'ub-leader' ? 'primary' : 'subagent'}`,
    ...(agent === 'ub-leader' ? [] : ['hidden: true']),
    '---',
    '',
  ].join('\n')
  const frozenBody = agent === 'ub-leader'
    ? [
        '# ub-leader — DSH read-only Explore executor',
        '',
        'The DSH host has already selected the module, resolved and displayed every source root,',
        'confirmed the routing gate, created the writable change workspace, and frozen the workflow references.',
        'Do not route again. Do not call question, task, skill, bash, shell, patch, apply_patch, or any deployment tool.',
        '',
        'Use only read, glob, grep, and list on the exact source_root paths supplied in the user prompt and on:',
        `- ${configDir.replace(/\\/g, '/')}/references/_shared/`,
        `- ${configDir.replace(/\\/g, '/')}/references/<selected-module>/`,
        '',
        'Use edit or write only for the exact exploration_notes.md path supplied by the host.',
        'The note must be non-empty and contain "## Domain Exploration" and "## Code Structure".',
        'Cite concrete files and symbols, distinguish observations from inferences, and state search limits.',
        'This runtime has no codegraph. Base the result on bounded text search and never claim codegraph coverage.',
        'Do not modify source files. Do not create patches or any other workspace artifact. Exit after the note is complete.',
      ].join('\n')
    : body
  return frozenContent(`${agent}.md`, Buffer.from(`${header}${frozenBody}\n`), configDir)
}

function sourceReceipt(path: string, data: Buffer, repoPath: string): { path: string; sha256: string; size: number } {
  return {
    path: relative(repoPath, path).split(sep).join('/'),
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.byteLength,
  }
}

function copyTree(
  source: string,
  target: string,
  root: string,
  repoPath: string,
  depth: number,
  budget: CopyBudget,
  files: string[],
  sources: RuntimeSnapshot['sources'],
): void {
  if (depth > MAX_RUNTIME_DEPTH) throw new Error('trusted OpenCode runtime exceeds depth limit')
  const sourceWitness = witnessDirectory(source)
  mkdirSync(target, { mode: 0o700 })
  try {
    for (const entry of readdirSync(source).sort()) {
      if (entry.includes('\0') || entry === '.' || entry === '..') throw new Error('trusted runtime contains an unsafe name')
      const from = join(source, entry)
      const to = join(target, entry)
      const linked = lstatSync(from)
      if (linked.isSymbolicLink()) throw new Error(`trusted runtime must not contain symbolic links: ${from}`)
      if (linked.isDirectory()) {
        copyTree(from, to, root, repoPath, depth + 1, budget, files, sources)
        continue
      }
      const { data, stat } = stableRegularFile(repoPath, from, MAX_RUNTIME_BYTES - budget.bytes)
      budget.files += 1
      budget.bytes += data.byteLength
      if (budget.files > MAX_RUNTIME_FILES || budget.bytes > MAX_RUNTIME_BYTES) {
        throw new Error('trusted OpenCode runtime exceeds size limit')
      }
      sources.push(sourceReceipt(from, data, repoPath))
      writeFileSync(to, frozenContent(from, data, root), {
        mode: (stat.mode & 0o111) === 0 ? 0o400 : 0o500,
        flag: 'wx',
      })
      files.push(relative(root, to).split(sep).join('/'))
    }
    verifyDirectoryWitnesses([sourceWitness])
  } finally {
    if (sourceWitness.fd !== undefined) try { closeSync(sourceWitness.fd) } catch {}
  }
}

function snapshotFileInventory(
  root: string,
  current = root,
  depth = 0,
  files: string[] = [],
): string[] {
  if (depth > MAX_RUNTIME_DEPTH) throw new Error('trusted runtime snapshot exceeds depth limit')
  const witness = witnessDirectory(current)
  try {
    for (const entry of readdirSync(current).sort()) {
      if (entry.includes('\0') || entry === '.' || entry === '..') {
        throw new Error('trusted runtime snapshot contains an unsafe name')
      }
      const path = join(current, entry)
      const linked = lstatSync(path)
      if (linked.isSymbolicLink()) {
        throw new Error(`trusted runtime snapshot contains a symbolic link: ${path}`)
      }
      if (linked.isDirectory()) {
        snapshotFileInventory(root, path, depth + 1, files)
        continue
      }
      if (!linked.isFile()) throw new Error(`trusted runtime snapshot contains a special file: ${path}`)
      files.push(relative(root, path).split(sep).join('/'))
      if (files.length > MAX_RUNTIME_FILES) throw new Error('trusted runtime snapshot exceeds file limit')
    }
    verifyDirectoryWitnesses([witness])
    return files
  } finally {
    if (witness.fd !== undefined) try { closeSync(witness.fd) } catch {}
  }
}

function snapshotDigest(configDir: string, files: readonly string[]): string {
  const expected = [...files].sort()
  const actual = snapshotFileInventory(configDir).sort()
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error('trusted runtime snapshot inventory changed')
  }
  const hash = createHash('sha256')
  for (const file of expected) {
    const path = join(configDir, ...file.split('/'))
    const { data } = stableRegularFile(configDir, path, MAX_RUNTIME_BYTES)
    hash.update(file).update('\0').update(String(data.byteLength)).update('\0').update(data)
  }
  return hash.digest('hex')
}

function sealSnapshotTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`trusted runtime snapshot contains a symbolic link: ${path}`)
  if (!stat.isDirectory()) {
    if (!stat.isFile()) throw new Error(`trusted runtime snapshot contains a special file: ${path}`)
    chmodSync(path, (stat.mode & 0o111) === 0 ? 0o400 : 0o500)
    return
  }
  for (const entry of readdirSync(path)) sealSnapshotTree(join(path, entry))
  chmodSync(path, 0o500)
}

export function createRuntimeSnapshot(repoPath: string, runtimeRoot: string): RuntimeSnapshot {
  realDirectory(repoPath, 'workflow repository')
  const configDir = join(runtimeRoot, 'config')
  mkdirSync(configDir, { mode: 0o700 })
  const agentsTarget = join(configDir, 'agents')
  const skillsTarget = join(configDir, 'skills')
  const referencesTarget = join(configDir, 'references')
  mkdirSync(agentsTarget, { mode: 0o700 })
  mkdirSync(skillsTarget, { mode: 0o700 })
  const budget: CopyBudget = { files: 0, bytes: 0 }
  const files: string[] = []
  const sources: RuntimeSnapshot['sources'] = []

  for (const agent of REQUIRED_RUNTIME_AGENTS) {
    const source = join(repoPath, 'agents', `${agent}.md`)
    const { data, stat } = stableRegularFile(repoPath, source, MAX_RUNTIME_BYTES - budget.bytes)
    budget.files += 1
    budget.bytes += data.byteLength
    if (budget.files > MAX_RUNTIME_FILES || budget.bytes > MAX_RUNTIME_BYTES) throw new Error('trusted OpenCode runtime exceeds size limit')
    const target = join(agentsTarget, `${agent}.md`)
    sources.push(sourceReceipt(source, data, repoPath))
    writeFileSync(target, frozenAgentContent(agent, data, configDir), { mode: 0o400, flag: 'wx' })
    files.push(`agents/${basename(target)}`)
  }

  for (const skill of REQUIRED_RUNTIME_SKILLS) {
    copyTree(join(repoPath, 'skills', skill), join(skillsTarget, skill), configDir, repoPath, 0, budget, files, sources)
  }

  // Manifests, workflow policy, and knowledge-lifecycle documents influence
  // routing and evidence generation just as much as agent/skill prompts. Keep
  // them inside the same immutable receipt so a later segment cannot observe
  // a modified policy or runner declaration.
  copyTree(join(repoPath, 'references'), referencesTarget, configDir, repoPath, 0, budget, files, sources)

  // OpenCode 1.18.3 ensures this file exists in every config directory before
  // it loads agents. Declare it in the immutable receipt up front so startup
  // never needs write access to the frozen config tree.
  const gitignore = Buffer.from('node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n')
  budget.files += 1
  budget.bytes += gitignore.byteLength
  if (budget.files > MAX_RUNTIME_FILES || budget.bytes > MAX_RUNTIME_BYTES) {
    throw new Error('trusted OpenCode runtime exceeds size limit')
  }
  writeFileSync(join(configDir, '.gitignore'), gitignore, { mode: 0o400, flag: 'wx' })
  files.push('.gitignore')

  files.sort()
  sources.sort((left, right) => left.path.localeCompare(right.path))
  const digest = snapshotDigest(configDir, files)
  // OpenCode otherwise bootstraps package.json/node_modules in every writable
  // config directory before loading file plugins. Seal the receipt tree so a
  // run cannot add dependency files or silently extend its trusted snapshot.
  sealSnapshotTree(configDir)
  return { configDir, files, sources, digest }
}

export function verifyRuntimeSources(repoPath: string, snapshot: RuntimeSnapshot): boolean {
  try {
    return snapshot.sources.every(source => {
      const path = join(repoPath, ...source.path.split('/'))
      const { data } = stableRegularFile(repoPath, path, source.size, source.size)
      return createHash('sha256').update(data).digest('hex') === source.sha256
    })
  } catch {
    return false
  }
}

export function verifyRuntimeSnapshot(snapshot: RuntimeSnapshot): boolean {
  try {
    return snapshotDigest(snapshot.configDir, snapshot.files) === snapshot.digest
  } catch {
    return false
  }
}
