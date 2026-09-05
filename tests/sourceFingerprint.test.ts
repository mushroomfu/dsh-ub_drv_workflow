import { existsSync, mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { captureSourceFingerprint } from '../src/sourceFingerprint.ts'

function git(repo: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-fingerprint-'))
  git(repo, 'init')
  git(repo, 'config', 'user.email', 'workflow@example.invalid')
  git(repo, 'config', 'user.name', 'Workflow Test')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'driver.c'), 'int value = 1;\n')
  git(repo, 'add', 'src/driver.c')
  git(repo, 'commit', '-m', 'fixture')
  return repo
}

describe('Explore source fingerprint', () => {
  it('changes for source edits but ignores workflow artifacts', async () => {
    const repo = repository()
    const roots = [join(repo, 'src')]
    const before = await captureSourceFingerprint(roots, repo)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    mkdirSync(join(repo, 'ub-workspace', 'changes', 'explore-a'), { recursive: true })
    writeFileSync(join(repo, 'ub-workspace', 'changes', 'explore-a', 'exploration_notes.md'), '# notes\n')
    expect(await captureSourceFingerprint(roots, repo)).toEqual(before)

    writeFileSync(join(repo, 'src', 'driver.c'), 'int value = 2;\n')
    const after = await captureSourceFingerprint(roots, repo)
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('keeps ignored caches outside the source contract', async () => {
    const repo = repository()
    writeFileSync(join(repo, '.gitignore'), 'src/generated.cfg\n')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-m', 'ignore generated cache')
    writeFileSync(join(repo, 'src', 'generated.cfg'), 'mode=safe\n')
    const before = await captureSourceFingerprint([join(repo, 'src')], repo)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    writeFileSync(join(repo, 'src', 'generated.cfg'), 'mode=changed\n')
    expect(await captureSourceFingerprint([join(repo, 'src')], repo)).toEqual(before)
  })

  it('scopes the inventory to selected roots instead of the whole checkout', async () => {
    const repo = repository()
    const before = await captureSourceFingerprint([join(repo, 'src')], repo)
    expect(before.ok).toBe(true)

    symlinkSync('/tmp', join(repo, 'unrelated-link'))
    writeFileSync(join(repo, 'unrelated.txt'), 'outside selected roots\n')

    expect(await captureSourceFingerprint([join(repo, 'src')], repo)).toEqual(before)
  })

  it('combines selected roots from independent Git repositories', async () => {
    const first = repository()
    const second = repository()
    const roots = [join(first, 'src'), join(second, 'src')]
    const before = await captureSourceFingerprint(roots)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    writeFileSync(join(second, 'src', 'driver.c'), 'int value = 9;\n')
    const after = await captureSourceFingerprint(roots)
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('changes for selected-root additions and deletions', async () => {
    const repo = repository()
    const roots = [join(repo, 'src')]
    const before = await captureSourceFingerprint(roots, repo)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    writeFileSync(join(repo, 'src', 'new.c'), 'int added = 1;\n')
    const withAddition = await captureSourceFingerprint(roots, repo)
    expect(withAddition.ok).toBe(true)
    if (!withAddition.ok) return
    expect(withAddition.fingerprint).not.toBe(before.fingerprint)

    git(repo, 'add', 'src/new.c')
    git(repo, 'commit', '-m', 'add selected source')
    const committed = await captureSourceFingerprint(roots, repo)
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    unlinkSync(join(repo, 'src', 'new.c'))
    const deleted = await captureSourceFingerprint(roots, repo)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.fingerprint).not.toBe(committed.fingerprint)
  })

  it('changes when only the selected-root Git index changes', async () => {
    const repo = repository()
    const roots = [join(repo, 'src')]
    writeFileSync(join(repo, 'src', 'driver.c'), 'int value = 2;\n')
    const beforeStage = await captureSourceFingerprint(roots, repo)
    expect(beforeStage.ok).toBe(true)
    if (!beforeStage.ok) return

    git(repo, 'add', 'src/driver.c')
    const afterStage = await captureSourceFingerprint(roots, repo)
    expect(afterStage.ok).toBe(true)
    if (afterStage.ok) expect(afterStage.fingerprint).not.toBe(beforeStage.fingerprint)
  })

  it('does not execute repository textconv, clean, or process filter commands', async () => {
    const repo = repository()
    const textconvMarker = join(repo, 'textconv-ran')
    const cleanMarker = join(repo, 'clean-ran')
    const processMarker = join(repo, 'process-ran')
    const markerScript = join(repo, 'mark.sh')
    writeFileSync(markerScript, '#!/bin/sh\ntouch "$1"\ncat\n', { mode: 0o700 })
    writeFileSync(join(repo, '.gitattributes'), '*.c diff=evil filter=evil\n')
    git(repo, 'add', '.gitattributes', 'mark.sh')
    git(repo, 'commit', '-m', 'hostile attributes fixture')
    git(repo, 'config', 'diff.evil.textconv', `${markerScript} ${textconvMarker}`)
    git(repo, 'config', 'filter.evil.clean', `${markerScript} ${cleanMarker}`)
    git(repo, 'config', 'filter.evil.process', `${markerScript} ${processMarker}`)
    writeFileSync(join(repo, 'src', 'driver.c'), 'int value = 7;\n')

    const fingerprint = await captureSourceFingerprint([join(repo, 'src')], repo)

    expect(fingerprint.ok).toBe(true)
    expect(existsSync(textconvMarker)).toBe(false)
    expect(existsSync(cleanMarker)).toBe(false)
    expect(existsSync(processMarker)).toBe(false)
  })

  it('rejects tracked and untracked symbolic links', async () => {
    const trackedRepo = repository()
    symlinkSync('/tmp', join(trackedRepo, 'src', 'tracked-link'))
    git(trackedRepo, 'add', 'src/tracked-link')
    git(trackedRepo, 'commit', '-m', 'tracked symlink')
    const tracked = await captureSourceFingerprint([join(trackedRepo, 'src')], trackedRepo)
    expect(tracked.ok).toBe(false)
    if (!tracked.ok) expect(tracked.error).toContain('受跟踪符号链接')

    const untrackedRepo = repository()
    symlinkSync('/tmp', join(untrackedRepo, 'src', 'untracked-link'))
    const untracked = await captureSourceFingerprint([join(untrackedRepo, 'src')], untrackedRepo)
    expect(untracked.ok).toBe(false)
    if (!untracked.ok) expect(untracked.error).toContain('符号链接')
  })
})
