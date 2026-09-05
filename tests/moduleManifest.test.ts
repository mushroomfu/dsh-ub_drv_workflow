import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadModuleCodeRoots, loadModuleTestTimings } from '../src/moduleManifest.ts'

function fixture(source: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-manifest-'))
  mkdirSync(join(repoPath, 'references', 'udma'), { recursive: true })
  writeFileSync(join(repoPath, 'references', 'udma', '_manifest.yaml'), source)
  return repoPath
}

describe('module manifest policy', () => {
  it('resolves canonical manifest roots against a separate source tree', () => {
    const workflowPath = fixture([
      'module: "udma"',
      'code_roots:',
      '  - "kernel/drivers/ub/urma/hw/udma/"',
      '  - "kernel/include/ub/udma/"',
      'execution_policy:',
      '  test_timing: [pre-dev, post-dev, regression]',
      '',
    ].join('\n'))
    const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
    mkdirSync(join(sourcePath, 'kernel', 'drivers', 'ub', 'urma', 'hw', 'udma'), { recursive: true })
    mkdirSync(join(sourcePath, 'kernel', 'include', 'ub', 'udma'), { recursive: true })

    expect(loadModuleCodeRoots(workflowPath, sourcePath, 'udma')).toEqual([
      {
        manifestPath: 'kernel/drivers/ub/urma/hw/udma',
        path: realpathSync(join(sourcePath, 'kernel', 'drivers', 'ub', 'urma', 'hw', 'udma')),
      },
      {
        manifestPath: 'kernel/include/ub/udma',
        path: realpathSync(join(sourcePath, 'kernel', 'include', 'ub', 'udma')),
      },
    ])
    expect(loadModuleTestTimings(workflowPath, 'udma')).toEqual(['pre-dev', 'post-dev', 'regression'])
  })

  it('supports absolute overrides for roots held in different repositories', () => {
    const workflowPath = fixture('module: udma\ncode_roots: [libudma, drivers/ub/udma]\nexecution_policy:\n  test_timing: [post-dev]\n')
    const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
    const library = mkdtempSync(join(tmpdir(), 'ub-libudma-'))
    const kernel = mkdtempSync(join(tmpdir(), 'ub-kernel-'))
    mkdirSync(join(kernel, 'drivers', 'ub', 'udma'), { recursive: true })

    expect(loadModuleCodeRoots(workflowPath, sourcePath, 'udma', {
      libudma: library,
      'drivers/ub/udma': join(kernel, 'drivers', 'ub', 'udma'),
    })).toEqual([
      { manifestPath: 'libudma', path: realpathSync(library) },
      { manifestPath: 'drivers/ub/udma', path: realpathSync(join(kernel, 'drivers', 'ub', 'udma')) },
    ])
  })

  it('rejects unknown and duplicate normalized source-root overrides', () => {
    const workflowPath = fixture('module: udma\ncode_roots: [src]\nexecution_policy:\n  test_timing: [post-dev]\n')
    const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
    mkdirSync(join(sourcePath, 'src'))
    const external = mkdtempSync(join(tmpdir(), 'ub-external-source-'))

    expect(() => loadModuleCodeRoots(workflowPath, sourcePath, 'udma', { typo: external }))
      .toThrow(/不属于.*manifest/)
    expect(() => loadModuleCodeRoots(workflowPath, sourcePath, 'udma', { src: external, 'src/': external }))
      .toThrow(/override 重复/)
  })

  it('rejects traversal, repository metadata, and duplicate roots', () => {
    for (const roots of ['[../outside]', '[.git]', '[src, src]']) {
      const workflowPath = fixture(`module: udma\ncode_roots: ${roots}\nexecution_policy:\n  test_timing: [post-dev]\n`)
      const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
      mkdirSync(join(sourcePath, 'src'))
      expect(() => loadModuleCodeRoots(workflowPath, sourcePath, 'udma')).toThrow(/unsafe|不安全|不能重复/)
    }
  })

  it('rejects reserved source roots regardless of path casing', () => {
    for (const root of ['Agents', 'Skills', 'References', 'UB-WORKSPACE']) {
      const workflowPath = fixture(`module: udma\ncode_roots: [${root}]\nexecution_policy:\n  test_timing: [post-dev]\n`)
      const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
      expect(() => loadModuleCodeRoots(workflowPath, sourcePath, 'udma')).toThrow(/unsafe|不安全/)
    }
  })

  it('rejects a code root reached through a symbolic-link directory', () => {
    const workflowPath = fixture('module: udma\ncode_roots: [src/module]\nexecution_policy:\n  test_timing: [post-dev]\n')
    const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-tree-'))
    const outside = mkdtempSync(join(tmpdir(), 'ub-workflow-manifest-outside-'))
    symlinkSync(outside, join(sourcePath, 'src'))
    expect(() => loadModuleCodeRoots(workflowPath, sourcePath, 'udma')).toThrow(/real directory/)
  })
})
