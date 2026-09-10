/**
 * Loopback-only HTTP API for the browser half. Mirrors the guard pattern from
 * dsh-safeguard: every route is fenced to loopback requests because they can
 * start/stop processes on the host.
 *
 * The webserver route table only supports exact/prefix paths (no URL params),
 * so run-scoped operations address the run through query params or the JSON
 * body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { UB_WORKFLOW_API } from './core/apiPaths.ts'
import type { RunInput, StepId } from './core/types.ts'
import type { WorkflowEngine } from './engine.ts'
import type { WorkflowStore } from './store.ts'

export { UB_WORKFLOW_API }

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    return null
  }
}

function route(path: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      await handle(req, res)
    },
  }
}

function queryParam(req: IncomingMessage, name: string): string | null {
  const url = new URL(req.url ?? '', 'http://127.0.0.1')
  return url.searchParams.get(name)
}

function requireRunId(res: ServerResponse, value: string | null): string | null {
  if (value === null || value.trim() === '') {
    writeJson(res, 400, { error: 'runId is required' })
    return null
  }
  return value.trim()
}

interface RouteComposition {
  repoPath: () => string
  store: () => WorkflowStore
  engine: () => WorkflowEngine
}

export function makeRoutes(get: RouteComposition): WebRoute[] {
  return [
    route(UB_WORKFLOW_API.state, async (_req, res) => {
      get.engine() // refresh workspace set (sessions resume after boot)
      writeJson(res, 200, get.store().snapshot(get.repoPath()))
    }),

    route(UB_WORKFLOW_API.runs, async (_req, res) => {
      get.engine() // refresh workspace set (sessions resume after boot)
      // Runs follow their conversation workspaces, so the client filters by
      // session from the full cross-workspace list.
      writeJson(res, 200, { runs: get.store().listAll() })
    }),

    route(UB_WORKFLOW_API.run, async (req, res) => {
      if (req.method === 'GET') {
        get.engine() // refresh workspace set (sessions resume after boot)
        const run = get.store().get(queryParam(req, 'run') ?? '')
        if (run === undefined) {
          writeJson(res, 404, { error: 'run not found' })
          return
        }
        writeJson(res, 200, { run })
        return
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }

      const body = await readJson<Partial<RunInput> & { runId?: string; sessionId?: string }>(req)
      if (body === null || typeof body.requirement !== 'string' || body.requirement.trim() === '') {
        writeJson(res, 400, { error: 'requirement is required' })
        return
      }
      const repo = typeof body.repoPath === 'string' && body.repoPath.trim() !== '' ? body.repoPath : get.repoPath()
      if (get.store().anyActive(repo)) {
        writeJson(res, 409, { error: 'a workflow run is already active for this repo' })
        return
      }
      const mode = body.mode === 'explore' ? 'explore' : body.mode === 'full' ? 'full' : 'dev'
      const run = get.engine().createRun({
        runId: typeof body.runId === 'string' && body.runId !== '' ? body.runId : undefined,
        repoPath: repo,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        changeId: typeof body.changeId === 'string' ? body.changeId : undefined,
        module: typeof body.module === 'string' ? body.module : undefined,
        requirement: body.requirement.trim(),
        mode,
        designOnly: body.designOnly === true,
        deploy: body.deploy === true,
      })
      const ok = await get.engine().launch(run)
      writeJson(res, ok ? 201 : 500, ok ? { runId: run.runId, run } : { error: 'failed to launch workflow runner' })
    }),

    route(UB_WORKFLOW_API.gate, async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJson<{ runId?: unknown; stepId?: unknown; action?: unknown }>(req)
      if (body === null || typeof body.stepId !== 'string') {
        writeJson(res, 400, { error: 'stepId is required' })
        return
      }
      const runId = requireRunId(res, typeof body.runId === 'string' ? body.runId : null)
      if (runId === null) return
      const action = body.action === 'cancel' ? 'cancel' : 'confirm'
      const ok = await get.engine().resolveGate(runId, body.stepId as StepId, action)
      writeJson(res, ok ? 200 : 404, { ok })
    }),

    route(UB_WORKFLOW_API.stop, async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJson<{ runId?: unknown }>(req)
      const runId = requireRunId(res, typeof body?.runId === 'string' ? body.runId : null)
      if (runId === null) return
      const ok = await get.engine().stopRun(runId)
      writeJson(res, ok ? 200 : 404, { ok })
    }),

    route(UB_WORKFLOW_API.delete, async (req, res) => {
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJson<{ runId?: unknown }>(req)
      const runId = requireRunId(res, typeof body?.runId === 'string' ? body.runId : null)
      if (runId === null) return
      const active = get.store().get(runId)
      if (active !== undefined && (active.status === 'running' || active.status === 'waiting_user')) {
        writeJson(res, 409, { error: 'cannot delete an active run' })
        return
      }
      const ok = get.store().delete(runId)
      // Persist the workspace the run actually tracked, so its record leaves
      // the right runs.json.
      get.store().persist(active?.repoPath ?? get.repoPath())
      writeJson(res, ok ? 200 : 404, { ok })
    }),
  ]
}