import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, type WorkflowEvidenceEvent } from '../src/core/workflowEvents.ts'
import {
  listChangeFiles,
  readChangeArtifactMetadata,
  readChangeEventLines,
  resolveChangeId,
  validatedKnowledgeArtifactFiles,
} from '../src/artifact-watcher.ts'

function contentId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 24)}`
}

function seal(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value }
  delete unsigned.content_sha256
  return {
    ...unsigned,
    content_sha256: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  }
}

describe('artifact watcher boundaries', () => {
  it('rejects a path-like explicit change id', () => {
    expect(resolveChangeId('/repo', '../../outside')).toBeUndefined()
  })

  it('never traverses outside the selected change workspace', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-artifacts-'))
    mkdirSync(join(repo, 'ub-workspace', 'changes', 'safe'), { recursive: true })
    writeFileSync(join(repo, 'secret.txt'), 'do not scan')

    expect(listChangeFiles(repo, '../../secret')).toEqual([])
  })

  it('does not follow symlinked directories while collecting evidence', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-symlink-'))
    const workspace = join(repo, 'ub-workspace', 'changes', 'safe')
    const outside = join(repo, 'outside')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'forged-report.md'), 'not workflow evidence')
    symlinkSync(outside, join(workspace, 'linked'))

    expect(listChangeFiles(repo, 'safe')).toEqual([])
  })

  it('does not follow a change workspace that is itself a symlink', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-root-link-'))
    const changes = join(repo, 'ub-workspace', 'changes')
    const outside = join(repo, 'outside-change')
    mkdirSync(changes, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'forged-report.md'), 'not workflow evidence')
    symlinkSync(outside, join(changes, 'safe'))

    expect(listChangeFiles(repo, 'safe')).toEqual([])
  })

  it('fails closed when a workspace exceeds scan depth or entry budgets', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-scan-budget-'))
    const workspace = join(repo, 'ub-workspace', 'changes', 'safe')
    mkdirSync(join(workspace, 'one', 'two', 'three'), { recursive: true })
    writeFileSync(join(workspace, 'one', 'two', 'three', 'report.md'), 'evidence\n')

    expect(listChangeFiles(repo, 'safe', { maxDepth: 2 })).toEqual([])

    writeFileSync(join(workspace, 'first.md'), 'one\n')
    writeFileSync(join(workspace, 'second.md'), 'two\n')
    expect(listChangeFiles(repo, 'safe', { maxEntries: 1 })).toEqual([])
  })

  it('reads bounded non-empty event lines from the selected workspace', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-events-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    mkdirSync(knowledge, { recursive: true })
    writeFileSync(join(knowledge, 'events.ndjson'), '{"one":1}\n\n{"two":2}\n')

    expect(readChangeEventLines(repo, 'safe')).toEqual(['{"one":1}', '{"two":2}'])
    expect(readChangeEventLines(repo, '../../outside')).toEqual([])
  })

  it('rejects the whole event stream when any non-empty line exceeds its bound', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-events-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    mkdirSync(knowledge, { recursive: true })
    writeFileSync(join(knowledge, 'events.ndjson'), `{"valid":true}\n${'x'.repeat(256 * 1024 + 1)}\n`)

    expect(readChangeEventLines(repo, 'safe')).toEqual([])
  })

  it('does not follow a symlinked event stream', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-event-link-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    mkdirSync(knowledge, { recursive: true })
    const outside = join(repo, 'forged.ndjson')
    writeFileSync(outside, '{"forged":true}\n')
    symlinkSync(outside, join(knowledge, 'events.ndjson'))

    expect(readChangeEventLines(repo, 'safe')).toEqual([])
  })

  it('returns the current size and sha256 only for safe regular artifacts', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-artifact-meta-'))
    const workspace = join(repo, 'ub-workspace', 'changes', 'safe')
    mkdirSync(workspace, { recursive: true })
    const content = 'compile passed\n'
    writeFileSync(join(workspace, 'compile_report.md'), content)
    const outside = join(repo, 'outside.md')
    writeFileSync(outside, 'forged\n')
    symlinkSync(outside, join(workspace, 'linked.md'))

    expect(readChangeArtifactMetadata(repo, 'safe', [
      'compile_report.md',
      'linked.md',
      '../outside.md',
    ])).toEqual([{
      path: 'compile_report.md',
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    }])
  })

  it('fails the whole metadata read closed when path or byte budgets are exceeded', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-artifact-budget-'))
    const workspace = join(repo, 'ub-workspace', 'changes', 'safe')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'one.md'), 'one\n')
    writeFileSync(join(workspace, 'two.md'), 'two\n')

    expect(readChangeArtifactMetadata(repo, 'safe', ['one.md', 'two.md'], { maxArtifacts: 1 })).toEqual([])
    expect(readChangeArtifactMetadata(repo, 'safe', ['one.md', 'two.md'], { maxTotalBytes: 4 })).toEqual([])
  })

  it('does not accept shallow closeout JSON that was not rebuilt from the event stream', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-knowledge-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    mkdirSync(knowledge, { recursive: true })
    writeFileSync(join(knowledge, 'episode.json'), JSON.stringify({ schema_version: 1, change_id: 'safe' }))
    writeFileSync(join(knowledge, 'candidates.json'), '{broken')
    writeFileSync(join(knowledge, 'registry-receipt.json'), JSON.stringify({
      schema_version: 1,
      change_id: 'safe',
      content_sha256: '0'.repeat(64),
    }))

    const event = {
      schema_version: 1,
      module: 'udma',
      change_id: 'safe',
      session_id: 'ses_test',
      phase: 'workflow',
      skill: 'ub-leader',
      event_type: 'workflow.started',
      outcome: 'started',
      summary: 'started',
      artifacts: [],
      files: [],
      symbols: [],
      occurred_at: '2026-09-04T00:00:00+00:00',
      event_id: 'ke-111111111111111111111111',
      content_sha256: '1'.repeat(64),
    } satisfies WorkflowEvidenceEvent

    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [event], true)).toEqual([
      '.knowledge/events.ndjson',
    ])
    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [event], false)).not.toContain('.knowledge/events.ndjson')
    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [event], true)).not.toContain('.knowledge/episode.json')
  })

  it('accepts a closeout receipt only when episode, registry, transaction, and receipt agree end to end', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-knowledge-chain-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    const registryRoot = join(repo, 'ub-workspace', 'knowledge')
    const transactions = join(registryRoot, 'transactions')
    mkdirSync(knowledge, { recursive: true })
    mkdirSync(transactions, { recursive: true })
    const start = {
      schema_version: 1,
      module: 'udma',
      change_id: 'safe',
      session_id: 'ses_safe',
      phase: 'workflow',
      skill: 'ub-leader',
      event_type: 'workflow.started',
      outcome: 'started',
      summary: 'workflow started',
      artifacts: [], files: [], symbols: [],
      occurred_at: '2026-09-04T00:00:00+00:00',
      event_id: 'ke-111111111111111111111111',
      content_sha256: '1'.repeat(64),
    } satisfies WorkflowEvidenceEvent
    const completed = {
      ...start,
      event_type: 'workflow.completed',
      outcome: 'completed',
      summary: 'workflow finalized with status completed',
      occurred_at: '2026-09-04T00:01:00+00:00',
      event_id: 'ke-222222222222222222222222',
      content_sha256: '2'.repeat(64),
    } satisfies WorkflowEvidenceEvent
    const sourceEventIds = [start.event_id, completed.event_id]
    const episodeId = contentId('kep', {
      module: 'udma', change_id: 'safe', status: 'completed', source_event_ids: sourceEventIds,
    })
    const episode = {
      schema_version: 1,
      episode_id: episodeId,
      module: 'udma',
      change_id: 'safe',
      session_ids: ['ses_safe'],
      status: 'completed',
      started_at: start.occurred_at,
      ended_at: completed.occurred_at,
      event_count: 2,
      phases: [{ phase: 'workflow', event_count: 2, last_outcome: 'completed' }],
      skills: ['ub-leader'],
      artifacts: [], failures: [], candidate_ids: [], source_event_ids: sourceEventIds,
    }
    const candidates = { schema_version: 1, module: 'udma', change_id: 'safe', candidate_count: 0, candidates: [] }
    writeFileSync(join(knowledge, 'episode.json'), JSON.stringify(episode))
    writeFileSync(join(knowledge, 'candidates.json'), JSON.stringify(candidates))

    const operationId = contentId('kop', {
      action: 'ingest', module: 'udma', change_id: 'safe', episode_id: episodeId,
    })
    const emptyRegistry = seal({
      schema_version: 1,
      policy: {
        min_distinct_completed_changes: 2,
        independent_review_can_promote: true,
        supersede_requires_independent_review: true,
      },
      ingestions: [], entries: [], history: [],
    })
    const ingestion = {
      module: 'udma', change_id: 'safe', episode_id: episodeId,
      workspace: 'ub-workspace/changes/safe', ended_at: completed.occurred_at,
      candidate_ids: [], knowledge_ids: [], promotions: [], operation_id: operationId,
    }
    const registry = seal({
      schema_version: 1,
      policy: emptyRegistry.policy,
      ingestions: [ingestion], entries: [], history: [operationId],
    })
    writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify(registry))
    const transaction = seal({
      schema_version: 1, operation_id: operationId, action: 'ingest',
      occurred_at: completed.occurred_at, module: 'udma', change_id: 'safe', episode_id: episodeId,
      candidate_ids: [], knowledge_ids: [], promotions: [],
      before_registry_sha256: emptyRegistry.content_sha256,
      after_registry_sha256: registry.content_sha256,
    })
    writeFileSync(join(transactions, `${operationId}.json`), JSON.stringify(transaction))
    const receipt = seal({
      schema_version: 1, action: 'ingest', status: 'registered', module: 'udma', change_id: 'safe',
      episode_id: episodeId, candidate_count: 0, knowledge_ids: [], promotions: [], conflicts: [],
      operation_id: operationId, registry: 'ub-workspace/knowledge/registry.json',
      registry_sha256: registry.content_sha256,
    })
    writeFileSync(join(knowledge, 'registry-receipt.json'), JSON.stringify(receipt))

    const files = validatedKnowledgeArtifactFiles(repo, 'safe', [start, completed], true)
    expect(files).toEqual([
      '.knowledge/events.ndjson',
      '.knowledge/episode.json',
      '.knowledge/candidates.json',
      '.knowledge/registry-receipt.json',
    ])

    writeFileSync(join(knowledge, 'registry-receipt.json'), JSON.stringify(seal({
      ...receipt,
      candidate_count: 1,
    })))
    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [start, completed], true))
      .not.toContain('.knowledge/registry-receipt.json')

    const weakenedRegistry = seal({
      ...registry,
      policy: {
        ...registry.policy as Record<string, unknown>,
        min_distinct_completed_changes: 1,
      },
    })
    writeFileSync(join(registryRoot, 'registry.json'), JSON.stringify(weakenedRegistry))
    writeFileSync(join(knowledge, 'registry-receipt.json'), JSON.stringify(seal({
      ...receipt,
      candidate_count: 0,
      registry_sha256: weakenedRegistry.content_sha256,
    })))
    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [start, completed], true))
      .not.toContain('.knowledge/registry-receipt.json')
  })

  it('rejects crystallized knowledge when workflow.started is not the first event', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ub-workflow-knowledge-start-'))
    const knowledge = join(repo, 'ub-workspace', 'changes', 'safe', '.knowledge')
    mkdirSync(knowledge, { recursive: true })
    const terminal = {
      schema_version: 1, module: 'udma', change_id: 'safe', session_id: 'ses_safe',
      phase: 'workflow', skill: 'ub-leader', event_type: 'workflow.completed', outcome: 'completed',
      summary: 'workflow finalized with status completed', artifacts: [], files: [], symbols: [],
      occurred_at: '2026-09-04T00:01:00+00:00', event_id: 'ke-333333333333333333333333',
      content_sha256: '3'.repeat(64),
    } satisfies WorkflowEvidenceEvent
    writeFileSync(join(knowledge, 'episode.json'), '{}')
    writeFileSync(join(knowledge, 'candidates.json'), '{}')
    expect(validatedKnowledgeArtifactFiles(repo, 'safe', [terminal], true)).not.toContain('.knowledge/episode.json')
  })
})
