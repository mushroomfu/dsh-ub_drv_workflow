import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowEngine, type EngineOptions } from '../src/engine.ts'
import type { OpenCodeServerRunner } from '../src/serverRunner.ts'
import { WorkflowStore } from '../src/store.ts'

const VALID_EXPLORE_NOTE = [
  '## Domain Exploration',
  'Text search with grep traced the selected UDMA ownership and cleanup paths. This result does not claim codegraph coverage.',
  '',
  '## Code Structure',
  '`src/driver.c` is the bounded fixture source; its symbols and callers were checked against the selected root.',
  '',
].join('\n')

function setup(options: Partial<EngineOptions> = {}) {
  const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-engine-'))
  const workflowPath = mkdtempSync(join(tmpdir(), 'ub-workflow-bundle-'))
  mkdirSync(join(repoPath, 'src'))
  writeFileSync(join(repoPath, 'src', 'driver.c'), 'int driver;\n')
  spawnSync('git', ['init'], { cwd: repoPath })
  spawnSync('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd: repoPath })
  spawnSync('git', ['config', 'user.name', 'Workflow Test'], { cwd: repoPath })
  spawnSync('git', ['add', 'src/driver.c'], { cwd: repoPath })
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repoPath })
  const store = new WorkflowStore()
  const runner = {
    running: false,
    start: vi.fn(() => true),
    stop: vi.fn(),
  } as unknown as OpenCodeServerRunner
  const engine = new WorkflowEngine({
    repoPath,
    workflowPath,
    sourcePath: repoPath,
    store,
    runner,
    loadTestTimings: (_repo, module) => module === 'udma'
      ? ['pre-dev', 'post-dev', 'regression']
      : ['post-dev', 'regression'],
    loadCodeRoots: () => [{ manifestPath: 'src', path: realpathSync(join(repoPath, 'src')) }],
    ...options,
  })
  return { repoPath, workflowPath, store, runner, engine }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function launchAndConfirmRoute(
  engine: WorkflowEngine,
  run: ReturnType<WorkflowEngine['createRun']>,
): Promise<void> {
  expect(engine.launch(run)).toBe(true)
  expect(await engine.resolveGate(run.runId, 'routing-plan', 'confirm')).toBe(true)
}

describe('WorkflowEngine run ownership', () => {
  it('freezes and exposes the workflow-to-source mapping before confirmation', async () => {
    const { repoPath, workflowPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the selected source root',
      module: 'udma',
      mode: 'explore',
      changeId: 'mapped-source-root',
    })

    expect(run.workflowPath).toBe(workflowPath)
    expect(run.sourceRoots).toEqual([{ manifestPath: 'src', path: realpathSync(join(repoPath, 'src')) }])
    expect(engine.launch(run)).toBe(true)
    expect(run.steps.find(step => step.id === 'routing-plan')?.note).toContain('source-roots=1')

    expect(await engine.resolveGate(run.runId, 'routing-plan', 'confirm')).toBe(true)
    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({
      workflowPath,
      sourceRoots: run.sourceRoots,
    }))
  })

  it('fails confirmation if the manifest-to-source mapping changed after review', async () => {
    let resolutions = 0
    const resolveRoots = vi.fn((_workflowPath: string, sourcePath: string) => {
      resolutions += 1
      if (resolutions === 1) {
        return [{ manifestPath: 'src', path: realpathSync(join(sourcePath, 'src')) }]
      }
      const alternate = join(sourcePath, 'alternate-src')
      mkdirSync(alternate, { recursive: true })
      return [{ manifestPath: 'src', path: realpathSync(alternate) }]
    })
    const { repoPath, engine, runner } = setup({ loadCodeRoots: resolveRoots })
    const run = engine.createRun({ repoPath, requirement: 'inspect stable mapping', module: 'udma', mode: 'explore' })
    expect(engine.launch(run)).toBe(true)

    expect(await engine.resolveGate(run.runId, 'routing-plan', 'confirm')).toBe(false)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/mapping|映射|source root/i)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects a direct engine launch against a different workspace root', () => {
    const { repoPath, store, runner, engine } = setup()
    const different = mkdtempSync(join(tmpdir(), 'ub-workflow-other-workspace-'))
    expect(() => engine.createRun({
      repoPath: different,
      requirement: 'must remain on configured workspace',
      module: 'udma',
      mode: 'explore',
    })).toThrow(/workspace|工作区/i)
    expect(store.listForRepo(repoPath)).toEqual([])
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects an oversized requirement before claiming a lease or persisting a run', () => {
    const { repoPath, store, runner, engine } = setup()

    expect(() => engine.createRun({
      repoPath,
      requirement: 'x'.repeat(20_001),
      module: 'udma',
      mode: 'explore',
    })).toThrow(/too large|20,?000/i)
    expect(store.listForRepo(repoPath)).toEqual([])
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects live deployment before claiming a repository lease', () => {
    const { repoPath, runner, engine } = setup()
    expect(() => engine.createRun({
      repoPath,
      requirement: 'deploy the driver',
      module: 'udma',
      mode: 'full',
      deploy: true,
    })).toThrow(/只读 Explore|read-only Explore|only.*explore/i)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects every non-Explore intent before claiming a lease or persisting a run', () => {
    const { repoPath, store, runner, engine } = setup()

    expect(() => engine.createRun({
      repoPath,
      requirement: 'implement the driver change',
      module: 'udma',
      mode: 'dev',
    })).toThrow(/只读 Explore|read-only Explore|only.*explore/i)
    expect(() => engine.createRun({
      repoPath,
      requirement: 'design the driver change',
      module: 'udma',
      mode: 'dev',
      designOnly: true,
    })).toThrow(/只读 Explore|read-only Explore|only.*explore/i)
    expect(store.listForRepo(repoPath)).toEqual([])
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('fails closed when a stored run is changed to an unsupported mode before launch', () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the source',
      module: 'udma',
      mode: 'explore',
    })
    run.mode = 'dev'

    expect(engine.launch(run)).toBe(false)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/read-only Explore|仅支持.*Explore/i)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('fails closed when an active run is changed to an unsupported design route', () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the source',
      module: 'udma',
      mode: 'explore',
    })
    run.status = 'running'
    run.designOnly = true

    engine.tick()

    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/read-only Explore|仅支持.*Explore/i)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('fails closed when a waiting run changes to an unsupported route before gate resolution', async () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the source',
      module: 'udma',
      mode: 'explore',
    })
    expect(engine.launch(run)).toBe(true)
    run.designOnly = true

    expect(await engine.resolveGate(run.runId, 'routing-plan', 'confirm')).toBe(false)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/只读 Explore|read-only Explore/i)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('refuses to start a segment for an unsupported stored run', () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the source',
      module: 'udma',
      mode: 'explore',
    })
    run.mode = 'dev'

    const startSegment = (engine as unknown as {
      startSegment: (candidate: typeof run, segment: 0) => boolean
    }).startSegment.bind(engine)
    expect(startSegment(run, 0)).toBe(false)
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects a second run before it can become a ghost active run', () => {
    const { repoPath, workflowPath, store, engine } = setup()
    const first = engine.createRun({ repoPath, requirement: 'first', module: 'udma', mode: 'explore' })
    expect(engine.launch(first)).toBe(true)

    expect(() => engine.createRun({ repoPath, requirement: 'second', module: 'udma', mode: 'explore' }))
      .toThrow(/运行锁|owned by run/)
    expect(store.findActive(repoPath)?.runId).toBe(first.runId)
  })

  it('rejects a launch when the selected change workspace already contains evidence', () => {
    const { repoPath, runner, engine } = setup()
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'existing-change')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'requirement_analysis.md'), '# evidence from an older run\n')
    const run = engine.createRun({
      repoPath,
      requirement: 'must not reuse evidence',
      module: 'udma',
      mode: 'explore',
      changeId: 'existing-change',
    })

    expect(engine.launch(run)).toBe(false)
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/已有产物|existing/i)
    expect(runner.start).not.toHaveBeenCalled()

    const next = engine.createRun({
      repoPath,
      requirement: 'a new run after the failed launch',
      module: 'udma',
      mode: 'explore',
      changeId: 'fresh-after-failure',
    })
    expect(engine.stopRun(next.runId)).toBe(true)
  })

  it('rejects a launch when the selected change workspace is a symbolic link', () => {
    const { repoPath, runner, engine } = setup()
    const changes = join(repoPath, 'ub-workspace', 'changes')
    const outside = join(repoPath, 'outside-change')
    mkdirSync(changes, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(changes, 'linked-change'))
    const run = engine.createRun({
      repoPath,
      requirement: 'must not follow a linked workspace',
      module: 'udma',
      mode: 'explore',
      changeId: 'linked-change',
    })

    expect(engine.launch(run)).toBe(false)
    expect(run.status).toBe('failed')
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('rejects a launch when an existing workspace contains only an empty file or link', () => {
    for (const entry of ['empty', 'link'] as const) {
      const { repoPath, runner, engine } = setup()
      const workspace = join(repoPath, 'ub-workspace', 'changes', `occupied-${entry}`)
      mkdirSync(workspace, { recursive: true })
      if (entry === 'empty') {
        writeFileSync(join(workspace, 'requirement_analysis.md'), '')
      } else {
        const outside = join(repoPath, 'outside.md')
        writeFileSync(outside, 'outside\n')
        symlinkSync(outside, join(workspace, 'requirement_analysis.md'))
      }
      const run = engine.createRun({
        repoPath,
        requirement: `must reject ${entry} evidence`,
        module: 'udma',
        mode: 'explore',
        changeId: `occupied-${entry}`,
      })

      expect(engine.launch(run), entry).toBe(false)
      expect(run.status, entry).toBe('failed')
      expect(runner.start, entry).not.toHaveBeenCalled()
    }
  })

  it('rejects a launch when the changes parent directory is a symbolic link', () => {
    const { repoPath, runner, engine } = setup()
    const workspaceRoot = join(repoPath, 'ub-workspace')
    const outside = join(repoPath, 'outside-changes')
    mkdirSync(workspaceRoot)
    mkdirSync(outside)
    symlinkSync(outside, join(workspaceRoot, 'changes'))
    const run = engine.createRun({
      repoPath,
      requirement: 'must not follow a linked parent',
      module: 'udma',
      mode: 'explore',
      changeId: 'linked-parent-change',
    })

    expect(engine.launch(run)).toBe(false)
    expect(run.status).toBe('failed')
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('generates distinct default change ids for repeated non-Latin requirements', () => {
    const { repoPath, engine } = setup()
    const first = engine.createRun({ repoPath, requirement: '修复资源回收', module: 'udma', mode: 'explore' })
    expect(engine.stopRun(first.runId)).toBe(true)
    const second = engine.createRun({ repoPath, requirement: '修复资源回收', module: 'udma', mode: 'explore' })

    expect(first.changeId).not.toBe(second.changeId)
  })

  it('runs explore as a one-segment artifact flow without entering design gates', async () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: '梳理 UDMA jetty 调用链与影响范围',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-callgraph',
    })

    await launchAndConfirmRoute(engine, run)
    const start = runner.start as unknown as ReturnType<typeof vi.fn>
    const prompt = start.mock.calls[0]?.[0]?.prompt as string
    expect(prompt).toContain('exploration_notes.md')
    expect(prompt).not.toContain('requirement-clarify')
    expect(prompt).not.toContain('ub-design')

    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-callgraph')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'exploration_notes.md'), VALID_EXPLORE_NOTE)
    await engine.onExit(run.runId, 0, null)

    expect(run.steps.find(step => step.id === 'explore')?.status, run.error).toBe('done')
    expect(run.status, run.error).toBe('done')
    expect(run.steps.find(step => step.id === 'explore')?.note).toMatch(/sha256=[0-9a-f]{64}/)
  })

  it('rejects a placeholder Explore note even when OpenCode exits normally', async () => {
    const { repoPath, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'inspect the selected source root',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-placeholder',
    })
    await launchAndConfirmRoute(engine, run)
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-placeholder')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'exploration_notes.md'), 'x\n')

    await engine.onExit(run.runId, 0, null)

    expect(run.steps.find(step => step.id === 'explore')?.status).toBe('failed')
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/笔记|section|content|格式/i)
  })

  it('does not treat a valid-looking Explore note as success when OpenCode exits non-zero', async () => {
    const { repoPath, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'explore a failing path',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-failed',
    })
    await launchAndConfirmRoute(engine, run)
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-failed')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'exploration_notes.md'), VALID_EXPLORE_NOTE)

    await engine.onExit(run.runId, 2, null)

    expect(run.steps.find(step => step.id === 'explore')?.status).toBe('failed')
    expect(run.status).toBe('failed')
    expect(run.error).toContain('code=2')
  })

  it('does not finish Explore when a previously observed note is deleted before exit', async () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'explore an unstable path',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-note-removed',
    })
    await launchAndConfirmRoute(engine, run)
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-note-removed')
    mkdirSync(workspace, { recursive: true })
    const notePath = join(workspace, 'exploration_notes.md')
    writeFileSync(notePath, VALID_EXPLORE_NOTE)
    ;(runner as unknown as { running: boolean }).running = true
    engine.tick()
    expect(run.steps.find(step => step.id === 'explore')?.status).toBe('running')

    writeFileSync(notePath, '')
    ;(runner as unknown as { running: boolean }).running = false
    await engine.onExit(run.runId, 0, null)

    expect(run.steps.find(step => step.id === 'explore')?.status).toBe('failed')
    expect(run.status).toBe('failed')
  })

  it('fails Explore when it produces a main-flow or patch artifact in its workspace', async () => {
    const { repoPath, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'explore without producing a patch',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-read-only',
    })
    await launchAndConfirmRoute(engine, run)
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-read-only')
    mkdirSync(join(workspace, 'patch'), { recursive: true })
    writeFileSync(join(workspace, 'exploration_notes.md'), VALID_EXPLORE_NOTE)
    writeFileSync(join(workspace, 'patch', 'forbidden.patch'), 'diff --git a/a b/a\n')

    await engine.onExit(run.runId, 0, null)

    expect(run.status).toBe('failed')
    expect(run.error).toContain('禁止')
  })

  it('fails Explore when it produces a legacy knowledge artifact alongside the note', async () => {
    const { repoPath, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'explore without running the legacy knowledge pipeline',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-no-knowledge',
    })
    await launchAndConfirmRoute(engine, run)
    const workspace = join(repoPath, 'ub-workspace', 'changes', 'udma-explore-no-knowledge')
    mkdirSync(join(workspace, '.knowledge'), { recursive: true })
    writeFileSync(join(workspace, 'exploration_notes.md'), VALID_EXPLORE_NOTE)
    writeFileSync(join(workspace, '.knowledge', 'retrieved.json'), '{}\n')

    await engine.onExit(run.runId, 0, null)

    expect(run.status).toBe('failed')
    expect(run.error).toContain('禁止')
  })

  it('does not start Explore when Stop and Delete win during fingerprint capture', async () => {
    const fingerprint = deferred<{ ok: true; fingerprint: string }>()
    const { repoPath, store, runner, engine } = setup({
      captureSourceFingerprint: vi.fn(async () => await fingerprint.promise),
    })
    const run = engine.createRun({
      repoPath,
      requirement: 'explore without surviving cancellation',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-cancel-race',
    })
    expect(engine.launch(run)).toBe(true)

    const confirming = engine.resolveGate(run.runId, 'routing-plan', 'confirm')
    await Promise.resolve()
    expect(engine.stopRun(run.runId)).toBe(true)
    expect(store.delete(run.runId)).toBe(true)
    store.persist(repoPath)
    fingerprint.resolve({ ok: true, fingerprint: 'a'.repeat(64) })

    expect(await confirming).toBe(false)
    expect(store.get(run.runId)).toBeUndefined()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('does not revive a stopped and deleted run when exit auditing finishes late', async () => {
    const exitFingerprint = deferred<{ ok: true; fingerprint: string }>()
    let captures = 0
    const { repoPath, store, runner, engine } = setup({
      captureSourceFingerprint: vi.fn(async () => {
        captures += 1
        return captures === 1
          ? { ok: true as const, fingerprint: 'b'.repeat(64) }
          : await exitFingerprint.promise
      }),
    })
    const run = engine.createRun({
      repoPath,
      requirement: 'explore with delayed closeout audit',
      module: 'udma',
      mode: 'explore',
      changeId: 'udma-explore-exit-race',
    })
    await launchAndConfirmRoute(engine, run)
    writeFileSync(
      join(repoPath, 'ub-workspace', 'changes', 'udma-explore-exit-race', 'exploration_notes.md'),
      '# Notes\n',
    )

    const closing = engine.onExit(run.runId, 0, null)
    await Promise.resolve()
    expect(engine.stopRun(run.runId)).toBe(true)
    expect(store.delete(run.runId)).toBe(true)
    store.persist(repoPath)
    exitFingerprint.resolve({ ok: true, fingerprint: 'b'.repeat(64) })
    await closing

    expect(store.get(run.runId)).toBeUndefined()
    expect(runner.start).toHaveBeenCalledTimes(1)
  })

  it('does not stop the active child when asked to stop a terminal history row', async () => {
    const { repoPath, runner, engine } = setup()
    const history = engine.createRun({ repoPath, requirement: 'old', module: 'udma', mode: 'explore' })
    expect(engine.stopRun(history.runId)).toBe(true)
    const active = engine.createRun({ repoPath, requirement: 'new', module: 'udma', mode: 'explore' })
    await launchAndConfirmRoute(engine, active)

    expect(engine.stopRun(history.runId)).toBe(false)
    expect(runner.stop).not.toHaveBeenCalled()
    expect(active.status).toBe('running')
  })

  it('lets a rebuilt engine in the same host process adopt and release the active lease', () => {
    const { repoPath, workflowPath, store, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'survive engine rebuild',
      module: 'udma',
      mode: 'explore',
    })
    const replacementRunner = {
      running: false,
      start: vi.fn(() => true),
      stop: vi.fn(),
    } as unknown as OpenCodeServerRunner
    const replacement = new WorkflowEngine({
      repoPath,
      workflowPath,
      sourcePath: repoPath,
      store,
      runner: replacementRunner,
      loadTestTimings: () => ['post-dev', 'regression'],
      loadCodeRoots: () => [{ manifestPath: 'src', path: realpathSync(join(repoPath, 'src')) }],
    })

    expect(replacement.stopRun(run.runId)).toBe(true)
    expect(run.status).toBe('stopped')
    const next = replacement.createRun({
      repoPath,
      requirement: 'lease was released',
      module: 'udma',
      mode: 'explore',
    })
    expect(replacement.stopRun(next.runId)).toBe(true)
  })

  it('stops a run that is waiting at a gate when the plugin is disabled', () => {
    const { repoPath, runner, engine } = setup()
    const run = engine.createRun({
      repoPath,
      requirement: 'disable while waiting',
      module: 'udma',
      mode: 'explore',
    })
    expect(engine.launch(run)).toBe(true)
    const gate = run.steps.find(step => step.id === 'routing-plan')
    expect(gate).toBeDefined()
    if (gate === undefined) return
    engine.stopActiveProcess()

    expect(run.status).toBe('stopped')
    expect(gate.status).toBe('skipped')
    expect(runner.start).not.toHaveBeenCalled()
  })

})
