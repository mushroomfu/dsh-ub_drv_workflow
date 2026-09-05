import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: vi.fn(),
  settingsNamespace: (name: string) => name,
}))

import { apply } from '../src/index.ts'

describe('slash command launch boundary', () => {
  it('rejects an oversized Explore goal before creating or persisting a run', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-command-'))
    const disposers: Array<() => void> = []
    let registration: {
      handler: (context: { rawInput: string; agent: { id: string } }) => Promise<{ kind: string; text: string }>
    } | undefined
    const context = {
      connection: { rpc: { handle: vi.fn(() => async () => {}) } },
      commands: {
        register: vi.fn((value: typeof registration) => {
          registration = value
          return () => {}
        }),
      },
      effect: vi.fn((setup: () => void | (() => void)) => {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
      }),
    }

    try {
      apply(context as never, {
        workflowPath: repoPath,
        workspacePath: repoPath,
        sourcePath: repoPath,
        pollMs: 60_000,
      })
      if (registration === undefined) throw new Error('slash command was not registered')
      const result = await registration.handler({
        rawInput: `--mode explore --module udma ${'x'.repeat(20_001)}`,
        agent: { id: 'conversation-a' },
      })

      expect(result).toMatchObject({ kind: 'error' })
      expect(result.text).toContain('20,000')
      expect(existsSync(join(repoPath, 'ub-workspace', '.dsh-ub-workflow', 'runs.json'))).toBe(false)
    } finally {
      for (const dispose of disposers.reverse()) dispose()
    }
  })

  it('persists distinct workflow, workspace, and cross-repository UMMU roots', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ub-workflow-workspace-'))
    const workflowPath = mkdtempSync(join(tmpdir(), 'ub-workflow-bundle-'))
    const sourcePath = mkdtempSync(join(tmpdir(), 'ub-source-fallback-'))
    const libummu = mkdtempSync(join(tmpdir(), 'ub-libummu-'))
    const kernel = mkdtempSync(join(tmpdir(), 'ub-kernel-'))
    const kernelRoot = join(kernel, 'drivers', 'iommu', 'hisilicon')
    mkdirSync(join(workflowPath, 'references', 'ummu'), { recursive: true })
    mkdirSync(kernelRoot, { recursive: true })
    writeFileSync(
      join(workflowPath, 'references', 'ummu', '_manifest.yaml'),
      'module: ummu\ncode_roots: [libummu, drivers/iommu/hisilicon]\nexecution_policy:\n  test_timing: [post-dev, regression]\n',
    )
    const disposers: Array<() => void> = []
    let registration: {
      handler: (context: { rawInput: string; agent: { id: string } }) => Promise<{ kind: string; text: string }>
    } | undefined
    const context = {
      connection: { rpc: { handle: vi.fn(() => async () => {}) } },
      commands: {
        register: vi.fn((value: typeof registration) => {
          registration = value
          return () => {}
        }),
      },
      effect: vi.fn((setup: () => void | (() => void)) => {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
      }),
    }

    try {
      apply(context as never, {
        workflowPath,
        workspacePath,
        sourcePath,
        sourceRootOverrides: {
          libummu,
          'drivers/iommu/hisilicon': kernelRoot,
        },
        pollMs: 60_000,
      })
      if (registration === undefined) throw new Error('slash command was not registered')
      const result = await registration.handler({
        rawInput: '--mode explore --module ummu inspect translation paths',
        agent: { id: 'conversation-ummu' },
      })
      expect(result.kind).toBe('success')

      const state = JSON.parse(readFileSync(
        join(workspacePath, 'ub-workspace', '.dsh-ub-workflow', 'runs.json'),
        'utf8',
      )) as { runs: Array<{ workflowPath?: string; sourceRoots?: Array<{ manifestPath: string; path: string }> }> }
      expect(state.runs[0]?.workflowPath).toBe(workflowPath)
      expect(state.runs[0]?.sourceRoots).toEqual([
        { manifestPath: 'libummu', path: realpathSync(libummu) },
        { manifestPath: 'drivers/iommu/hisilicon', path: realpathSync(kernelRoot) },
      ])
    } finally {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
})
