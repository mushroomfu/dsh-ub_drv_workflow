/**
 * Session-scoped floating side entrance for dsh-ub-workflow.
 *
 * The entry is mounted in the conversation header-action slot, so it is only
 * rendered for a real conversation. Visibility is decided by two durable
 * signals: the session transcript's `/ub-workflow` command node (live
 * sessions project it instantly) and the run registry served over Connection
 * RPC — the RPC `state` endpoint is session-scoped by the host, so any
 * returned run belongs to THIS conversation and the entry survives restarts
 * even when a very large restored session no longer projects its early
 * command events.
 *
 * The visible button and drawer are portaled to `document.body`. The drawer
 * is a pure OVERLAY: it floats above the untouched conversation (the host
 * layout is never modified — no margin, no transform), so the chat keeps its
 * full width and scroll position while the workflow panel is open.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkflowFlowView } from './WorkflowFlowView.tsx'
import type { UbWorkflowClient } from './api.ts'
import dockCss from './workflow-dock.module.css'

export type WorkflowSidecarProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'ub-workflow'>
  & { workflowClient: UbWorkflowClient }

const CLOSE_ANIMATION_MS = 240

export function UbWorkflowSidecar(props: WorkflowSidecarProps): ReactNode {
  const { t, useSession, workflowClient } = props
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const transcriptHasWorkflow = useSession(snapshot => {
    // Snapshot shape varies across app versions: nodes live top-level or under
    // chat.legacy. Accept both; anything else means "no command node".
    const snap = snapshot as { nodes?: readonly unknown[], chat?: { legacy?: { nodes?: readonly unknown[] } } } | undefined
    const nodes: ReadonlyArray<{ kind?: string, name?: string }> = Array.isArray(snap?.nodes)
      ? snap.nodes
      : Array.isArray(snap?.chat?.legacy?.nodes)
        ? snap.chat.legacy.nodes
        : []
    return nodes.some(node => node?.kind === 'command' && node?.name === 'ub-workflow')
  })

  // Durable fallback: on very large sessions the restored transcript projection
  // drops early events, so the live-session command node alone cannot gate the
  // entry across restarts. The host's session-scoped run registry answers on
  // mount with this conversation's runs (any record implies the command ran).
  const [registryHasWorkflow, setRegistryHasWorkflow] = useState(false)
  useEffect(() => {
    if (transcriptHasWorkflow || registryHasWorkflow) return
    let alive = true
    void workflowClient.state()
      .then(snapshot => {
        if (alive) setRegistryHasWorkflow((snapshot.runs ?? []).length > 0)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [transcriptHasWorkflow, registryHasWorkflow, workflowClient])

  const hasWorkflow = transcriptHasWorkflow || registryHasWorkflow

  // Reset the panel when the conversation stops being a workflow conversation.
  useEffect(() => {
    if (hasWorkflow) return
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setPanel('closed')
  }, [hasWorkflow])

  // Safety net: cancel the close timer after unmount.
  useEffect(() => () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  if (!hasWorkflow) return null

  const openPanel = (): void => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setPanel('open')
  }

  const closePanel = (): void => {
    if (panel !== 'open') return
    setPanel('closing')
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setPanel('closed')
    }, CLOSE_ANIMATION_MS)
  }

  return createPortal(
    <div className={dockCss.root} data-panel={panel}>
      {panel !== 'closed'
        ? <div className={dockCss.backdrop} onClick={closePanel} aria-hidden="true" />
        : null}

      <button
        type="button"
        className={dockCss.fab}
        title={t('title')}
        aria-label={t('title')}
        aria-expanded={panel === 'open'}
        onClick={panel === 'open' ? closePanel : openPanel}
      >
        <span className={dockCss.fabIcon} aria-hidden="true">UB</span>
        <span className={dockCss.fabLabel}>{t('title')}</span>
      </button>

      {panel !== 'closed'
        ? (
            <aside className={dockCss.drawer} data-state={panel} onClick={event => { event.stopPropagation() }}>
              <header className={dockCss.drawerHeader}>
                <h2 className={dockCss.drawerTitle}>{t('title')}</h2>
              </header>
              <div className={dockCss.drawerBody}>
                {/* The view type wants the full session standard kit; both
                    slots are session-scoped, so forwarding this component's
                    props carries useSession/useProjection & friends through. */}
                <WorkflowFlowView {...props} workflowClient={workflowClient} />
              </div>
            </aside>
          )
        : null}
    </div>,
    document.body,
  )
}
