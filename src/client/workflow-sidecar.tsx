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
 * is a pure OVERLAY with NO backdrop: the conversation underneath stays fully
 * interactive (scroll, composer input, send) while the drawer is open. The
 * drawer's bottom edge dynamically clears the composer so the input box is
 * never covered.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
/** Drawer inset from the window bottom when no composer clearance applies. */
const DRAWER_BOTTOM = 10
/** The drawer never shrinks below this height; past it, it may overlap the composer. */
const DRAWER_MIN_HEIGHT = 280

/**
 * Top edge of the conversation's input card, or -1 when absent.
 *
 * The composer slot wrappers are `display: contents` (zero-sized), so the
 * measurement starts from the live text editor (textarea / contenteditable)
 * and walks up to the first ancestor with real box geometry — the input card
 * that carries the editor, send button and accessory rows.
 */
function findComposerTop(): number {
  if (typeof document === 'undefined') return -1
  const composerSlot = document.querySelector('[data-slot="conversation.composer"]')
  if (composerSlot === null) return -1
  const editor = composerSlot.querySelector('textarea, [contenteditable="true"]')
  if (!(editor instanceof HTMLElement)) return -1
  let el: HTMLElement | null = editor
  for (let i = 0; i < 6 && el !== null && el !== document.body; i++) {
    const rect = el.getBoundingClientRect()
    if (rect.height >= 50 && rect.width > 200) return rect.top
    el = el.parentElement
  }
  return editor.getBoundingClientRect().top - 16
}

export function UbWorkflowSidecar(props: WorkflowSidecarProps): ReactNode {
  const { t, useSession, workflowClient } = props
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)

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

  const requestClose = useCallback((): void => {
    setPanel(current => {
      if (current !== 'open') return current
      if (closeTimer.current !== null) clearTimeout(closeTimer.current)
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null
        setPanel('closed')
      }, CLOSE_ANIMATION_MS)
      return 'closing'
    })
  }, [])

  // Esc closes the drawer, mirroring the header close button.
  useEffect(() => {
    if (panel !== 'open') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, requestClose])

  /**
   * Keep the drawer clear of the conversation's input card: the composer
   * (editor, send button, accessory rows) stays fully visible and usable
   * while the drawer is open. Without a composer (blank hero) fall back to
   * the plain window inset.
   */
  const applyComposerClearance = useCallback((): void => {
    const drawer = drawerRef.current
    if (drawer === null) return
    const composerTop = findComposerTop()
    let bottom = DRAWER_BOTTOM
    if (composerTop > 44) bottom = Math.max(DRAWER_BOTTOM, Math.round(window.innerHeight - composerTop) + 12)
    const maxBottom = Math.max(DRAWER_BOTTOM, window.innerHeight - 44 - DRAWER_MIN_HEIGHT)
    drawer.style.bottom = `${Math.min(bottom, maxBottom)}px`
  }, [])

  useLayoutEffect(() => {
    if (panel !== 'open') return
    applyComposerClearance()
    window.addEventListener('resize', applyComposerClearance)
    return () => window.removeEventListener('resize', applyComposerClearance)
  }, [panel, applyComposerClearance])

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

  return createPortal(
    <div className={dockCss.root} data-panel={panel}>
      <button
        type="button"
        className={dockCss.fab}
        title={t('title')}
        aria-label={t('title')}
        aria-expanded={panel === 'open'}
        onClick={panel === 'open' ? requestClose : openPanel}
      >
        <span className={dockCss.fabIcon} aria-hidden="true">UB</span>
        <span className={dockCss.fabLabel}>{t('title')}</span>
      </button>

      {panel !== 'closed'
        ? (
            <aside ref={drawerRef} className={dockCss.drawer} data-state={panel}>
              <header className={dockCss.drawerHeader}>
                <h2 className={dockCss.drawerTitle}>{t('title')}</h2>
                <button
                  type="button"
                  className={dockCss.drawerClose}
                  onClick={requestClose}
                  aria-label="关闭"
                  title="关闭 (Esc)"
                >
                  <span aria-hidden="true">✕</span>
                </button>
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
