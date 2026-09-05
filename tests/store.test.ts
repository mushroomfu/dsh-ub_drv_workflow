import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildStageChain } from '../src/core/stages.ts'
import type { WorkflowRun } from '../src/core/types.ts'
import { WorkflowStore } from '../src/store.ts'

function persistedRun(repoPath: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    runId: 'run-1',
    repoPath,
    requirement: 'test',
    mode: 'dev',
    designOnly: false,
    deploy: false,
    testTimings: ['post-dev', 'regression'],
    status: 'running',
    steps: buildStageChain({ mode: 'dev', testTimings: ['post-dev', 'regression'] }),
    segment: 0,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    logTail: [],
    ...overrides,
  }
}

function statePayload(runs: WorkflowRun[]): string {
  return JSON.stringify({ version: 2, updatedAt: '2026-09-04T00:00:00.000Z', runs })
}

describe('WorkflowStore persistence recovery', () => {
  it('fails closed on a syntactically valid record with a malformed run shape', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([
      { ...persistedRun(repoPath, { runId: 'malformed-run', status: 'done' }), createdAt: null } as unknown as WorkflowRun,
    ]))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/invalid run record/)
  })

  it('fails closed on a persisted run with an unsafe identifier', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([
      persistedRun(repoPath, { runId: '../foreign-run', status: 'done' }),
    ]))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/invalid run record/)
  })

  it('fails closed on a record that claims a different repository', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([persistedRun('/other/repo')]))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/invalid run record/)
  })

  it('fails closed instead of recovering historical dev and design-only active runs', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([
      persistedRun(repoPath, { runId: 'legacy-dev' }),
      persistedRun(repoPath, {
        runId: 'legacy-design',
        designOnly: true,
        steps: buildStageChain({ mode: 'dev', designOnly: true }),
        testTimings: [],
        createdAt: '2026-09-04T00:01:00.000Z',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }),
    ]))

    const store = new WorkflowStore()
    store.loadRepo(repoPath)
    expect(store.get('legacy-dev')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/只读 Explore|read-only Explore/i),
    })
    expect(store.get('legacy-design')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/只读 Explore|read-only Explore/i),
    })
  })

  it('keeps terminal legacy history but fails an active Explore record without frozen roots', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    const explore = {
      mode: 'explore' as const,
      designOnly: false,
      deploy: false,
      testTimings: [],
      steps: buildStageChain({ mode: 'explore' }),
    }
    writeFileSync(join(stateDir, 'runs.json'), statePayload([
      persistedRun(repoPath, { ...explore, runId: 'legacy-terminal', status: 'done' }),
      persistedRun(repoPath, {
        ...explore,
        runId: 'legacy-active',
        status: 'waiting_user',
        createdAt: '2026-09-04T00:01:00.000Z',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }),
    ]))

    const store = new WorkflowStore()
    store.loadRepo(repoPath)
    expect(store.get('legacy-terminal')?.status).toBe('done')
    expect(store.get('legacy-active')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/workflow\/source root|冻结映射/i),
    })
  })

  it('rejects malformed persisted workflow/source root mappings', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([
      persistedRun(repoPath, {
        status: 'done',
        workflowPath: '/workflow',
        sourceRoots: [{ manifestPath: '../escape', path: 'relative/source' }],
      }),
    ]))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/invalid run record/)
  })

  it('persists valid JSON without leaving its temporary file behind', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const store = new WorkflowStore()
    store.put(persistedRun(repoPath, { status: 'done' }))
    store.persist(repoPath)

    expect(() => JSON.parse(readFileSync(join(repoPath, 'ub-workspace', '.dsh-ub-workflow', 'runs.json'), 'utf8'))).not.toThrow()
    expect(existsSync(join(repoPath, '.dsh-ub-workflow', 'runs.json'))).toBe(false)
    expect(() => readFileSync(join(repoPath, 'ub-workspace', '.dsh-ub-workflow', 'runs.json.tmp'))).toThrow()
  })

  it('carries every legacy-path history record into the first current-path write', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-legacy-'))
    const legacyDir = join(repoPath, '.dsh-ub-workflow')
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'runs.json'), statePayload([
      persistedRun(repoPath, { runId: 'legacy-a', status: 'done' }),
      persistedRun(repoPath, {
        runId: 'legacy-b',
        status: 'done',
        createdAt: '2026-09-04T00:01:00.000Z',
        updatedAt: '2026-09-04T00:01:00.000Z',
      }),
    ]))

    const store = new WorkflowStore()
    store.loadRepo(repoPath)
    store.put(persistedRun(repoPath, {
      runId: 'current-c',
      status: 'done',
      createdAt: '2026-09-04T00:02:00.000Z',
      updatedAt: '2026-09-04T00:02:00.000Z',
    }))
    store.persist(repoPath)

    const observer = new WorkflowStore()
    observer.loadRepo(repoPath)
    expect(observer.listForRepo(repoPath).map(run => run.runId).sort()).toEqual([
      'current-c',
      'legacy-a',
      'legacy-b',
    ])
  })

  it('keeps the live telemetry tail out of the persisted run file', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const store = new WorkflowStore()
    store.put(persistedRun(repoPath, { status: 'done', logTail: ['tool output with transient details'] }))
    store.persist(repoPath)

    const payload = JSON.parse(readFileSync(
      join(repoPath, 'ub-workspace', '.dsh-ub-workflow', 'runs.json'),
      'utf8',
    )) as { runs: WorkflowRun[] }
    expect(payload.runs[0]?.logTail).toEqual([])
  })

  it('refuses to persist through a symlinked state directory', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const outside = mkdtempSync(join(tmpdir(), 'ub-workflow-store-outside-'))
    mkdirSync(join(repoPath, 'ub-workspace'), { recursive: true })
    symlinkSync(outside, join(repoPath, 'ub-workspace', '.dsh-ub-workflow'))
    const store = new WorkflowStore()
    store.put(persistedRun(repoPath, { status: 'done' }))

    expect(() => { store.persist(repoPath) }).toThrow(/symbolic link/i)
    expect(existsSync(join(outside, 'runs.json'))).toBe(false)
  })

  it('ignores persisted state reached through a symlink', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const outside = mkdtempSync(join(tmpdir(), 'ub-workflow-store-outside-'))
    mkdirSync(join(repoPath, 'ub-workspace'), { recursive: true })
    writeFileSync(join(outside, 'runs.json'), statePayload([
      persistedRun(repoPath, { status: 'waiting_user' }),
    ]))
    symlinkSync(outside, join(repoPath, 'ub-workspace', '.dsh-ub-workflow'))

    const store = new WorkflowStore()
    store.loadRepo(repoPath)
    expect(store.get('run-1')).toBeUndefined()
  })

  it('merges interleaved writes from independent store instances without losing runs', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const first = new WorkflowStore()
    const second = new WorkflowStore()
    first.put(persistedRun(repoPath, { runId: 'run-a', status: 'done' }))
    second.put(persistedRun(repoPath, { runId: 'run-b', status: 'done', createdAt: '2026-09-04T00:01:00.000Z' }))

    first.persist(repoPath)
    second.persist(repoPath)
    const firstRun = first.get('run-a')!
    firstRun.error = 'later local update'
    first.put(firstRun)
    first.persist(repoPath)

    const observer = new WorkflowStore()
    observer.loadRepo(repoPath)
    expect(observer.listForRepo(repoPath).map(run => run.runId).sort()).toEqual(['run-a', 'run-b'])
    expect(observer.get('run-a')?.error).toBe('later local update')
  })

  it('does not resurrect a run deleted by another store during an unrelated write', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-delete-'))
    const seed = new WorkflowStore()
    seed.put(persistedRun(repoPath, { runId: 'run-a', status: 'done' }))
    seed.put(persistedRun(repoPath, {
      runId: 'run-b',
      status: 'done',
      createdAt: '2026-09-04T00:01:00.000Z',
    }))
    seed.persist(repoPath)

    const deleting = new WorkflowStore()
    const stale = new WorkflowStore()
    deleting.loadRepo(repoPath)
    stale.loadRepo(repoPath)
    expect(deleting.delete('run-a')).toBe(true)
    deleting.persist(repoPath)

    const runB = stale.get('run-b')!
    runB.error = 'unrelated update'
    stale.put(runB)
    stale.persist(repoPath)

    const observer = new WorkflowStore()
    observer.loadRepo(repoPath)
    expect(observer.get('run-a')).toBeUndefined()
    expect(observer.get('run-b')?.error).toBe('unrelated update')
  })

  it('rolls a failed delete back without leaving a latent tombstone', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-delete-rollback-'))
    const store = new WorkflowStore()
    store.put(persistedRun(repoPath, { runId: 'run-a', status: 'done' }))
    store.persist(repoPath)
    const persist = vi.spyOn(store, 'persist').mockImplementationOnce(() => {
      throw new Error('simulated lock failure')
    })

    expect(() => store.deleteAndPersist(repoPath, 'run-a')).toThrow('simulated lock failure')
    expect(store.get('run-a')?.runId).toBe('run-a')
    persist.mockRestore()

    store.put(persistedRun(repoPath, {
      runId: 'run-b',
      status: 'done',
      createdAt: '2026-09-04T00:01:00.000Z',
    }))
    store.persist(repoPath)
    const observer = new WorkflowStore()
    observer.loadRepo(repoPath)
    expect(observer.listForRepo(repoPath).map(run => run.runId).sort()).toEqual(['run-a', 'run-b'])
  })

  it('rejects a stale same-run update instead of overwriting another host revision', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-conflict-'))
    const seed = new WorkflowStore()
    seed.put(persistedRun(repoPath, { runId: 'shared-run', status: 'done' }))
    seed.persist(repoPath)

    const first = new WorkflowStore()
    const stale = new WorkflowStore()
    first.loadRepo(repoPath)
    stale.loadRepo(repoPath)
    const firstRun = first.get('shared-run')!
    firstRun.error = 'first host update'
    first.put(firstRun)
    first.persist(repoPath)

    const staleRun = stale.get('shared-run')!
    staleRun.error = 'stale overwrite'
    stale.put(staleRun)
    expect(() => { stale.persist(repoPath) }).toThrow(/updated by another host process/)

    const observer = new WorkflowStore()
    observer.loadRepo(repoPath)
    expect(observer.get('shared-run')?.error).toBe('first host update')
  })

  it('fails closed without reading a FIFO used as the state file', () => {
    if (process.platform === 'win32') return
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-fifo-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    const result = spawnSync('mkfifo', [join(stateDir, 'runs.json')])
    expect(result.status).toBe(0)

    const store = new WorkflowStore()
    store.loadRepo(repoPath)
    expect(store.listForRepo(repoPath)).toEqual([])
  })

  it('rejects an oversized persisted state before allocating or parsing it', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-large-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'runs.json'), 'x'.repeat((5 * 1024 * 1024) + 1))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/oversized/)
  })

  it('rejects duplicate run identifiers in the persisted array', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-store-'))
    const stateDir = join(repoPath, 'ub-workspace', '.dsh-ub-workflow')
    mkdirSync(stateDir, { recursive: true })
    const duplicate = persistedRun(repoPath, { status: 'done' })
    writeFileSync(join(stateDir, 'runs.json'), statePayload([duplicate, { ...duplicate }]))

    const store = new WorkflowStore()
    expect(() => { store.loadRepo(repoPath) }).toThrow(/duplicate run id/)
  })

  it('shows a slash-command run only in the DSH conversation that launched it', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'ub-workflow-session-'))
    const store = new WorkflowStore()
    store.put(persistedRun(repoPath, {
      runId: 'run-session-a',
      sessionId: 'conversation-a',
      status: 'waiting_user',
    }))

    expect(store.snapshot(repoPath, 'conversation-a').activeRun?.runId).toBe('run-session-a')
    expect(store.snapshot(repoPath, 'conversation-a').runs.map(run => run.runId)).toEqual(['run-session-a'])
    expect(store.snapshot(repoPath, 'conversation-b')).toMatchObject({ activeRun: null, runs: [] })
  })
})
