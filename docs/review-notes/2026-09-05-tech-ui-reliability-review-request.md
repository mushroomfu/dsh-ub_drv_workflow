# Review Request: DSH Embedded Read-only UB Workflow

Review-Target-ID: `tech-ui-reliability`
Branch: `codex/tech-ui-reliability`
Worktree: `/Users/mufengyan/Documents/ai_work/dsh-plugins/dsh-ub_drv_workflow-tech-ui`

## Problem and resulting behavior

The baseline presented progress in a standalone route and could infer success from weak file/process signals. The final implementation contributes only `conversation.view#ub-workflow` inside the existing DSH conversation, and enables only a host-confirmed, read-only Explore path. Production has no HTML entry or page route; `preview/` is a package-excluded host fixture.

A run now displays its exact workflow bundle, writable workspace, and every manifest→physical source mapping before confirmation. After confirmation, a dedicated minimal Explore leader can read only those frozen source roots and selected references and can write only `exploration_notes.md`. Green completion requires normal process exit, a stable structured note receipt, workspace allowlist, and unchanged selected-root fingerprints.

## Main implementation

- Replaced page-relative HTTP with lifecycle-owned DSH Connection RPC and session-scoped operations.
- Split `workflowPath`, `workspacePath`, `sourcePath`, and `sourceRootOverrides`; persisted frozen source mappings and revalidated them at gate/runtime boundaries.
- Added selected-root fingerprint v3 across independent Git repositories, hashing raw index tuples plus stable working bytes without invoking repository filters.
- Added a per-run immutable runtime snapshot, dedicated Explore leader, deny-first OpenCode permissions, path guard, skill/task/shell/question/patch denial, and supervised process-tree cleanup.
- Added SSE missed-idle recovery from bounded message history while keeping errors and incomplete messages fail-closed.
- Made routing and Explore host-verified. A file/event cannot confirm routing or complete Explore; final notes must contain substantive `## Domain Exploration` and `## Code Structure` sections and record size/SHA-256.
- Hardened state/lease reads and writes, cross-process ownership, async generations, transactional deletion, legacy recovery, and disabled-state behavior.
- Rebuilt the contributed view with responsive control-tower styling, current-stage centering, motion/reduced-motion handling, full route-scope review, accessible status, 44px actions, and expandable history.
- Added safe clean build so removed route declarations and stale bundles cannot enter the package.

## Review focus

1. Verify production registers only `conversation.view` and has no standalone route/page artifact.
2. Look for false success in routing, OpenCode exit, note validation, selected-root fingerprinting, or SSE recovery.
3. Look for path escape, cross-run mutation, stale callback, lease adoption, and runtime permission widening.
4. Check embedded container/flex behavior, narrow route-scope readability, status accessibility, polling order, and destructive UI actions.

## Verification

- `pnpm exec vitest run --configLoader runner` → 24 files / 204 tests passed after the final UI and Explore workspace regressions.
- `pnpm typecheck` → passed before final bundle freeze; final gate repeats it.
- Real OpenCode 1.18.3 health/OpenAPI/agent/skill probe runs under the production startup boundary without submitting a model prompt.
- Real UMMU source-root fingerprint probe covered `libummu` and `drivers/iommu/hisilicon` from independent repositories in about 156 ms.
- The 639px in-app preview was inspected in running, route-waiting, and idle states. Its accessibility tree exposes the DSH-owned title/Tab/composer, full source mappings, hard-gate buttons, and online/sync status.
- Final clean build, bundle marker check, `git diff --check`, and package inventory are recorded in `docs/reviews/2026-09-05-quality-gate.md`.

## Known external validation boundary

The full DSH Desktop and a live model-backed Explore are unavailable in this worktree. The remaining integration step is to install the bundle in DSH, configure the three path roles/overrides, and run one minimal Explore with an authenticated OpenCode account. Design, development, UT, and deployment remain rejected until DSH supplies an auditable inline question/permission broker.
