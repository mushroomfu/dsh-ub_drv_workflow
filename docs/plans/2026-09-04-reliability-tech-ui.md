# UB Workflow Reliability and Control Tower UI Implementation Plan

**Feature:** Align the visual workflow plugin with the current `ub-drv-develop` contract and make its live status trustworthy and easier to read.
**Goal:** A developer can launch or inspect a run, answer the requirement clarification gate, and trust that the highlighted stage belongs to the current process and durable artifacts.
**Acceptance Criteria:**
- The main chain includes the current upstream requirement clarification hard gate and resumes design with the user's written response.
- Success and failure come from integrity-checked upstream terminal events plus the referenced artifact, rather than report-file existence alone.
- Successful evidence matches each declared artifact's current on-disk path, byte size, and SHA-256; an existing change workspace cannot be reused for a new run.
- Upstream event artifacts and visible-step artifact hints are validated independently, including the artifact-free `workflow.completed` shape.
- A fresh OpenCode run captures its real session id, and every continuation resumes that exact session through the `ub-leader` agent.
- Intentional runner stops cannot deliver a stale exit callback or detach a newly started continuation process.
- Stop, gate, delete, and launch operations are scoped to the configured repository and the targeted active run.
- Disabling the plugin stops a waiting run and prevents gate continuations until it is enabled again.
- Artifact hints require exact file or glob matches; path-like change ids cannot escape the change workspace.
- Explore remains a one-segment, read-only `exploration_notes.md` flow, requires a normal process exit for success, and never enters requirement/design gates.
- Connection RPC payloads and identifiers are bounded and validated, and failures preserve exact host validation errors.
- The dashboard shows overall progress, active-stage position, status legend, artifact evidence, live logs, expandable history details, and a launch form in a responsive control-tower layout.
- The production client registers only in DSH's existing `conversation.view` ring; container-based breakpoints follow the embedded slot width, and the active stage centers inside its own horizontal track without moving the host page vertically.
- Running/waiting states have restrained motion, with a complete `prefers-reduced-motion` fallback.
- Tests, type checking, a clean production build, and the package manifest pass.
**Architecture:** Keep the Cordis host/client split. Harden pure contracts and process ownership in the host, then render the serialized run through a stateless dashboard shell so both the DSH slot and a local visual fixture use the same UI.
**Tech Stack:** TypeScript, React 18, Cordis/DSH client slots, CSS Modules, Vitest, tsdown.
**前端验证:** Yes — run a local Vite fixture in the isolated worktree and inspect the responsive dashboard in the in-app browser.

---

### Task 1: Lock down workflow evidence and identifiers

**Files:**
- Modify: `src/core/artifacts.ts`
- Modify: `src/artifact-watcher.ts`
- Modify: `src/core/parseArgs.ts`
- Create: `src/core/ids.ts`
- Create: `src/core/workflowEvents.ts`
- Modify: `src/store.ts`
- Test: `tests/artifacts.test.ts`
- Test: `tests/artifact-watcher.test.ts`
- Test: `tests/parseArgs.test.ts`
- Test: `tests/store.test.ts`
- Test: `tests/workflowEvents.test.ts`

1. Add failing tests for exact nested artifact matching and unsafe `change-id` values.
2. Run the focused tests and confirm the false-positive/path traversal cases fail.
3. Replace directory-prefix inference with exact literal/glob matching, validate hash-verified terminal events, and centralize safe id validation.
4. Re-run the focused tests.

### Task 2: Make process ownership and continuation race-safe

**Files:**
- Modify: `src/runner.ts`
- Modify: `src/engine.ts`
- Test: `tests/runner.test.ts`
- Test: `tests/engine.test.ts`

1. Add fake-child tests proving an intentionally stopped child cannot fire its exit callback after a continuation starts.
2. Add engine tests proving terminal/history actions cannot stop another active run.
3. Give each spawned child an identity and invalidate callbacks on stop; scope runner mutations to the active run id.
4. Start a fresh OpenCode session without a fabricated `--session`, capture its JSON session id, and resume only that exact id with `--agent ub-leader`.
5. Re-run the focused tests.

### Task 3: Align the interactive chain with upstream requirement clarification

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/stages.ts`
- Modify: `src/engine.ts`
- Delete: `src/routes.ts`
- Create: `src/rpc.ts`
- Modify: `src/client/api.ts`
- Test: `tests/stages.test.ts`
- Test: `tests/stateMachine.test.ts`
- Test: `tests/engine.test.ts`
- Create: `src/core/inputValidation.ts`
- Test: `tests/inputValidation.test.ts`

1. Add failing tests for the `requirement-clarify` hard gate, required response, and five physical OpenCode segments.
2. Update the serialized contract and prompts so requirement draft, clarification, design gate, deploy gate, deployment result gate, STC, and closeout are separate transitions.
3. Replace page-relative HTTP with DSH Connection RPC and reject repository overrides, cross-session access, duplicate ids, invalid step ids, oversized input, and malformed gate responses at that boundary.
4. Re-run the focused tests.

### Task 4: Build the control-tower dashboard

**Files:**
- Modify: `src/client/WorkflowFlowView.tsx`
- Modify: `src/client/StepCard.tsx`
- Modify: `src/client/RunLaunchForm.tsx`
- Modify: `src/client/useWorkflowRun.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/locales.ts`
- Modify: `src/client/workflow-flow.module.css`
- Modify: `src/client/step-card.module.css`
- Modify: `src/client/run-launch-form.module.css`
- Create: `src/client/workflowMetrics.ts`
- Test: `tests/workflowMetrics.test.ts`

1. Add failing tests for progress, active index, duration, and next-action view metrics.
2. Implement the pure metrics helper.
3. Compose the responsive dashboard, requirement response control, action error handling, non-overlapping polling, and accessible status presentation.
4. Add glass/grid/telemetry styling, focused-stage motion, and reduced-motion fallbacks.
5. Re-run tests and type checking.

### Task 5: Visual and release verification

**Files:**
- Create: `preview/index.html`
- Create: `preview/main.tsx`
- Create: `preview/preview.css`
- Modify: `package.json`
- Modify: `README.md`

1. Add a local fixture that renders representative running, waiting, full-deployment-gate, and idle states through the production components inside a DSH-like conversation shell.
2. Start the fixture on an isolated port and inspect desktop and narrow layouts in the in-app browser.
3. Fix visible overflow, contrast, focus, or motion defects.
4. Run `pnpm test`, `pnpm typecheck`, and `pnpm build`; inspect the final Git diff and repository hygiene.

### Implemented verification

- 22 test files / 161 tests pass, covering host state, canonical upstream events, on-disk evidence integrity, receipt reconstruction, develop retries, strict fresh-workspace checks, Explore confinement, disabled gates, path confinement, full lease ownership, process generations, exact OpenCode sessions, authenticated SSE questions, DSH session ownership, input bounds, history details, stage metrics, current-stage centering, hidden-page polling, and stale response ordering.
- TypeScript type checking and a clean host/client production build pass. The build now removes its output directory first so deleted declarations cannot leak into a later package.
- `npm pack --dry-run --json --ignore-scripts` lists 40 files: only the production bundles, declarations, patch, package metadata, READMEs, design note, and reliability report; neither `preview/` nor the removed `routes.d.ts` is present.
- The local fixture was inspected in the in-app browser at the current 639px DSH content width across running, clarification, deployment-result gate, and idle states. The active card centers inside the pipeline, the DSH title/tab/composer remain owned by the shell, and the console has zero warnings or errors.
- No `.pen` design artifact is present, so no separate Pencil render validation applies.
