/** Strict, dependency-free reader for the module manifest fields trusted by the host. */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { TestTiming, WorkflowSourceRoot } from './core/types.ts'

const ALLOWED_TIMINGS = new Set<TestTiming>(['pre-dev', 'post-dev', 'regression'])
const ALLOWED_MODULES = new Set(['ubase', 'cdma', 'udma', 'ummu', 'ubus'])
const RESERVED_CODE_ROOTS = new Set([
  '.git', '.opencode', '.dsh-ub-workflow', 'agents', 'node_modules',
  'references', 'skills', 'ub-workspace',
])
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_CODE_ROOTS = 16
const MAX_CODE_ROOT_LENGTH = 512

export function isSupportedModule(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED_MODULES.has(value)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realDirectory(path: string, label: string): Stats {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`)
  return stat
}

function stableManifestSource(manifestRoot: string, module: string): string {
  if (!isSupportedModule(module)) throw new Error('启动工作流前必须明确受支持的 module')
  const references = join(manifestRoot, 'references')
  const moduleDir = join(references, module)
  const witnessed = [
    { path: manifestRoot, stat: realDirectory(manifestRoot, 'manifest root') },
    { path: references, stat: realDirectory(references, 'references') },
    { path: moduleDir, stat: realDirectory(moduleDir, `references/${module}`) },
  ]
  const rootReal = realpathSync(manifestRoot)
  if (!inside(rootReal, realpathSync(moduleDir))) {
    throw new Error(`模块 manifest 路径越界：references/${module}/_manifest.yaml`)
  }
  const manifest = join(moduleDir, '_manifest.yaml')
  let descriptor: number | undefined
  try {
    const linked = lstatSync(manifest)
    if (!linked.isFile() || linked.isSymbolicLink() || linked.size <= 0 || linked.size > MAX_MANIFEST_BYTES) {
      throw new Error(`模块 manifest 不可读取：references/${module}/_manifest.yaml`)
    }
    descriptor = openSync(manifest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.dev !== linked.dev || before.ino !== linked.ino || before.size !== linked.size) {
      throw new Error(`模块 manifest 在打开期间发生变化：${module}`)
    }
    const data = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < data.length) {
      const bytes = readSync(descriptor, data, offset, data.length - offset, offset)
      if (bytes === 0) throw new Error(`模块 manifest 读取提前结束：${module}`)
      offset += bytes
    }
    const after = fstatSync(descriptor)
    const linkedAfter = lstatSync(manifest)
    if (!sameIdentity(before, after) || linkedAfter.isSymbolicLink() || !linkedAfter.isFile()
      || linkedAfter.dev !== after.dev || linkedAfter.ino !== after.ino) {
      throw new Error(`模块 manifest 在读取期间发生变化：${module}`)
    }
    for (const witness of witnessed) {
      const current = lstatSync(witness.path)
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(witness.stat, current)) {
        throw new Error(`模块 manifest 祖先目录在读取期间发生变化：${module}`)
      }
    }
    return data.toString('utf8')
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
  }
}

function yamlScalar(raw: string, label: string): string {
  let value = raw.trim().replace(/\s+#.*$/, '').trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  if (value === '' || value.length > MAX_CODE_ROOT_LENGTH || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error(`${label} 包含不受支持的 YAML 值`)
  }
  return value
}

function rootScalar(source: string, key: string): string {
  const matches = source.split(/\r?\n/).flatMap(line => {
    const match = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`).exec(line)
    return match === null ? [] : [match[1]!]
  })
  if (matches.length !== 1) throw new Error(`模块 manifest 必须包含唯一的 ${key}`)
  return yamlScalar(matches[0]!, key)
}

function parseCodeRootValues(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const entries = lines.flatMap((line, index) => /^code_roots\s*:/.test(line) ? [index] : [])
  if (entries.length !== 1) throw new Error('模块 manifest 必须包含唯一的 code_roots')
  const index = entries[0]!
  const declaration = /^code_roots\s*:\s*(.*?)\s*$/.exec(lines[index]!)
  if (declaration === null) throw new Error('模块 manifest 的 code_roots 格式无效')
  const tail = declaration[1]!.replace(/\s+#.*$/, '').trim()
  if (tail !== '') {
    if (!tail.startsWith('[') || !tail.endsWith(']')) {
      throw new Error('模块 manifest 的 code_roots 必须是列表')
    }
    const body = tail.slice(1, -1).trim()
    return body === '' ? [] : body.split(',').map(value => yamlScalar(value, 'code_roots'))
  }

  const values: string[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break
    const item = /^\s+-\s+(.+?)\s*$/.exec(line)
    if (item === null) throw new Error('模块 manifest 的 code_roots 列表格式无效')
    values.push(yamlScalar(item[1]!, 'code_roots'))
  }
  return values
}

function normalizeCodeRoot(raw: string): string {
  const normalized = raw.replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (normalized === '' || normalized === '.' || raw.includes('\\') || raw.includes('\0')
    || isAbsolute(raw) || win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
    || segments[0]!.startsWith('.') || RESERVED_CODE_ROOTS.has(segments[0]!.toLowerCase())) {
    throw new Error(`模块 manifest 包含不安全的 code_root：${raw}`)
  }
  return normalized
}

export function loadModuleCodeRootIds(workflowPath: string, module: string): string[] {
  realDirectory(workflowPath, 'workflow repository')
  const source = stableManifestSource(workflowPath, module)
  if (rootScalar(source, 'module') !== module) throw new Error(`模块 manifest identity 与选择不一致：${module}`)
  const values = parseCodeRootValues(source)
  if (values.length === 0 || values.length > MAX_CODE_ROOTS) {
    throw new Error(`模块 manifest 的 code_roots 数量必须为 1-${MAX_CODE_ROOTS}`)
  }
  const manifestPaths = values.map(normalizeCodeRoot)
  if (new Set(manifestPaths.map(root => root.toLowerCase())).size !== manifestPaths.length) {
    throw new Error('模块 manifest 的 code_roots 不能重复')
  }
  return manifestPaths
}

export function validateFrozenSourceRoots(roots: readonly WorkflowSourceRoot[]): WorkflowSourceRoot[] {
  if (roots.length === 0 || roots.length > MAX_CODE_ROOTS) {
    throw new Error(`冻结 source roots 数量必须为 1-${MAX_CODE_ROOTS}`)
  }
  const validated = roots.map(root => {
    const manifestPath = normalizeCodeRoot(root.manifestPath)
    if (root.path === '' || root.path.length > 4_096 || /[\u0000-\u001f\u007f]/.test(root.path)
      || (!isAbsolute(root.path) && !win32.isAbsolute(root.path))) {
      throw new Error(`code_root ${manifestPath} 的物理路径必须是安全的绝对路径`)
    }
    const configured = resolve(root.path)
    realDirectory(configured, `code_root ${manifestPath}`)
    const path = realpathSync(configured)
    const same = process.platform === 'win32'
      ? path.toLowerCase() === configured.toLowerCase()
      : path === configured
    if (!same) throw new Error(`code_root ${manifestPath} 的物理路径不能以符号链接作为叶节点`)
    return { manifestPath, path }
  })
  if (new Set(validated.map(root => root.manifestPath.toLowerCase())).size !== validated.length) {
    throw new Error('冻结 source roots 的 manifestPath 不能重复')
  }
  const physical = validated.map(root => process.platform === 'win32' ? root.path.toLowerCase() : root.path)
  if (new Set(physical).size !== validated.length) throw new Error('多个 code_roots 不能映射到同一物理目录')
  return validated
}

function resolveCodeRoot(
  sourcePath: string,
  manifestPath: string,
  override: string | undefined,
): WorkflowSourceRoot {
  const sourceReal = realpathSync(sourcePath)
  realDirectory(sourceReal, 'source tree')
  if (override !== undefined) {
    if (override === '' || override.length > 4_096 || /[\u0000-\u001f\u007f]/.test(override)
      || (!isAbsolute(override) && !win32.isAbsolute(override))) {
      throw new Error(`code_root ${manifestPath} 的覆盖路径必须是安全的绝对路径`)
    }
    const configured = resolve(override)
    realDirectory(configured, `code_root ${manifestPath}`)
    return { manifestPath, path: realpathSync(configured) }
  }

  let current = sourceReal
  const segments = manifestPath.split('/')
  for (const segment of segments) {
    current = join(current, segment)
    realDirectory(current, `code_root ${manifestPath}`)
  }
  const resolved = realpathSync(current)
  if (!inside(sourceReal, resolved)) throw new Error(`模块 code_root 越过 source tree 边界：${manifestPath}`)
  return { manifestPath, path: resolved }
}

/** Resolve portable manifest code_roots against a separate physical source tree. */
export function loadModuleCodeRoots(
  workflowPath: string,
  sourcePath: string,
  module: string,
  overrides: Readonly<Record<string, string>> = {},
): WorkflowSourceRoot[] {
  const manifestPaths = loadModuleCodeRootIds(workflowPath, module)
  const normalizedOverrides = new Map<string, string>()
  for (const [rawManifestPath, physicalPath] of Object.entries(overrides)) {
    const manifestPath = normalizeCodeRoot(rawManifestPath)
    if (!manifestPaths.includes(manifestPath)) {
      throw new Error(`source root override 不属于 ${module} manifest：${rawManifestPath}`)
    }
    if (normalizedOverrides.has(manifestPath)) {
      throw new Error(`source root override 重复：${manifestPath}`)
    }
    normalizedOverrides.set(manifestPath, physicalPath)
  }
  const roots = manifestPaths.map(manifestPath => resolveCodeRoot(
    sourcePath,
    manifestPath,
    normalizedOverrides.get(manifestPath),
  ))
  return validateFrozenSourceRoots(roots)
}

export function loadModuleTestTimings(repoPath: string, module: string | undefined): TestTiming[] {
  if (module === undefined) throw new Error('启动工作流前必须明确 module')
  const source = stableManifestSource(repoPath, module)
  if (rootScalar(source, 'module') !== module) throw new Error(`模块 manifest identity 与选择不一致：${module}`)
  const match = /^\s*test_timing\s*:\s*\[([^\]]*)\]\s*(?:#.*)?$/m.exec(source)
  if (match === null) throw new Error(`模块 manifest 缺少 execution_policy.test_timing：${module}`)
  const values = match[1]!.split(',').map(value => value.trim().replace(/^['"]|['"]$/g, ''))
  if (values.length === 0 || values.some(value => !ALLOWED_TIMINGS.has(value as TestTiming))) {
    throw new Error(`模块 manifest 的 test_timing 不受支持：${match[1]}`)
  }
  const timings = values as TestTiming[]
  if (new Set(timings).size !== timings.length || !timings.includes('post-dev')) {
    throw new Error(`模块 manifest 的 test_timing 必须唯一且包含 post-dev：${match[1]}`)
  }
  const canonical = ['pre-dev', 'post-dev', 'regression'].filter(value => timings.includes(value as TestTiming))
  if (canonical.join(',') !== timings.join(',')) {
    throw new Error(`模块 manifest 的 test_timing 顺序无效：${match[1]}`)
  }
  return [...timings]
}
