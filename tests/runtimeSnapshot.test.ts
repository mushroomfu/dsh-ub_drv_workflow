import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createRuntimeSnapshot,
  REQUIRED_RUNTIME_AGENTS,
  REQUIRED_RUNTIME_SKILLS,
  verifyRuntimeSnapshot,
  verifyRuntimeSources,
} from '../src/runtimeSnapshot.ts'

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-runtime-source-'))
  mkdirSync(join(repo, 'agents'), { recursive: true })
  mkdirSync(join(repo, 'references'), { recursive: true })
  for (const agent of REQUIRED_RUNTIME_AGENTS) {
    writeFileSync(join(repo, 'agents', `${agent}.md`), [
      '---',
      `name: ${agent}`,
      'permission:',
      '  edit: allow',
      '  bash: allow',
      '---',
      `# ${agent}`,
      ...(agent === 'ub-leader' ? ['MUST repeat routing, call question, and use bash before Explore.'] : []),
      '',
    ].join('\n'))
  }
  for (const skill of REQUIRED_RUNTIME_SKILLS) {
    mkdirSync(join(repo, 'skills', skill), { recursive: true })
    writeFileSync(join(repo, 'skills', skill, 'SKILL.md'), `# ${skill}\n`)
  }
  writeFileSync(join(repo, 'references', 'policy.md'), '# policy\n')
  return repo
}

describe('runtime snapshot', () => {
  it('replaces the conflicting upstream leader body with a minimal Explore executor', () => {
    const repo = fixture()
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))
    const snapshot = createRuntimeSnapshot(repo, root)
    const leader = readFileSync(join(snapshot.configDir, 'agents', 'ub-leader.md'), 'utf8')

    expect(leader).toContain('mode: primary')
    expect(leader).toContain('# ub-leader — DSH read-only Explore executor')
    expect(leader).toContain('Do not route again')
    expect(leader).toContain('## Domain Exploration')
    expect(leader).not.toContain('MUST repeat routing')
    expect(leader).not.toContain('permission:')
    expect(verifyRuntimeSnapshot(snapshot)).toBe(true)
    expect(verifyRuntimeSources(repo, snapshot)).toBe(true)
  })

  it('seals every snapshot directory against dependency installation or added files', () => {
    const repo = fixture()
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))
    const snapshot = createRuntimeSnapshot(repo, root)

    for (const directory of [
      snapshot.configDir,
      join(snapshot.configDir, 'agents'),
      join(snapshot.configDir, 'skills'),
      join(snapshot.configDir, 'skills', 'ub-workflow'),
      join(snapshot.configDir, 'references'),
    ]) {
      expect(statSync(directory).mode & 0o222, directory).toBe(0)
    }
  })

  it('invalidates the snapshot receipt when an undeclared runtime file appears', () => {
    const repo = fixture()
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))
    const snapshot = createRuntimeSnapshot(repo, root)
    chmodSync(snapshot.configDir, 0o700)
    writeFileSync(join(snapshot.configDir, 'package.json'), '{"dependencies":{"unexpected":"1.0.0"}}\n')

    expect(verifyRuntimeSnapshot(snapshot)).toBe(false)
  })

  it('rejects an oversized sparse agent before reading it into memory', () => {
    const repo = fixture()
    truncateSync(join(repo, 'agents', 'ub-leader.md'), 16 * 1024 * 1024 + 1)
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))

    expect(() => createRuntimeSnapshot(repo, root)).toThrow('regular and non-empty')
  })

  it.runIf(process.platform !== 'win32')('rejects symlinked runtime ancestors', () => {
    const repo = fixture()
    const external = mkdtempSync(join(tmpdir(), 'dsh-runtime-external-'))
    writeFileSync(join(external, 'SKILL.md'), '# replaced\n')
    const skill = join(repo, 'skills', 'ub-review')
    const moved = join(repo, 'skills', 'ub-review-real')
    // Keep the original fixture available only to make the replacement explicit.
    symlinkSync(external, moved)
    symlinkSync(moved, join(skill, 'nested-link'))
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))

    expect(() => createRuntimeSnapshot(repo, root)).toThrow('symbolic links')
  })

  it('invalidates the source receipt after an upstream prompt changes', () => {
    const repo = fixture()
    const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-target-'))
    const snapshot = createRuntimeSnapshot(repo, root)
    writeFileSync(join(repo, 'agents', 'ub-leader.md'), '# changed\n')

    expect(verifyRuntimeSources(repo, snapshot)).toBe(false)
  })
})
