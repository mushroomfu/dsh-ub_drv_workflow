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
 * The visible button and drawer are portaled to `document.body` so they float
 * beside the conversation with independent fixed positioning and animated
 * transitions.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
const SHIFT_TRANSITION = 'margin-right 240ms cubic-bezier(0.22, 0.9, 0.28, 1)'
/** The drawer is flush with the window's right edge, so its left edge is `innerWidth - drawerWidth`. */
const DRAWER_RIGHT = 0
/** The conversation column is never squeezed below this width; past it the drawer overlays the conversation instead of pushing it. */
const MIN_CENTER_WIDTH = 360

/**
 * The conversation column is the parent of the `conversation` slot wrapper.
 * This is the DSH-layout grid item (`centerCol`) that contains the whole
 * conversation surface inside the `sidebar | center | details` grid frame.
 *
 * While the drawer is open we shrink this item with an inline `margin-right`
 * (animated) until its right edge meets the drawer's left edge flush. Flush is
 * what erases the seam: the conversation surface and the drawer composite the
 * same family of translucent background, so at the join no divider line can
 * appear. The item also stays anchored at the left edge of its grid track, so
 * nothing ever overlaps the sidebar and nothing is clipped by the frame's
 * `overflow: hidden`.
 */
function findConversationColumn(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const root = document.getElementById('root') ?? document.body
  const slot = root.querySelector('[data-slot="conversation"]')
  return slot instanceof HTMLElement ? slot.parentElement : null
}

/**
 * Resolve how far the column must shrink so its right edge meets the drawer's
 * left edge exactly (integer CSS pixels on both sides → no seam, no overlap).
 *
 * The measurement is transition-proof: with an inline margin `m`, the column's
 * right edge is `trackRight - m` and its width is `trackWidth - m`, so
 * `rect.right + currentMargin` and `rect.width + currentMargin` recover the
 * un-shifted track geometry even when read mid-animation (e.g. the drawer is
 * reopened while the closing transition is still running).
 */
function measureShift(center: HTMLElement, drawer: HTMLElement): number {
  const rect = center.getBoundingClientRect()
  const margin = Number.parseFloat(window.getComputedStyle(center).marginRight) || 0
  const trackRight = rect.right + margin
  const trackWidth = rect.width + margin
  const drawerLeft = window.innerWidth - DRAWER_RIGHT - drawer.offsetWidth
  const shift = Math.round(trackRight - drawerLeft)
  const maxShift = Math.round(trackWidth - MIN_CENTER_WIDTH)
  return Math.min(Math.max(0, shift), Math.max(0, maxShift))
}

export function UbWorkflowSidecar(props: WorkflowSidecarProps): ReactNode {
  const { sessionId, t, useSession, workflowClient } = props
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const shiftTargetRef = useRef<HTMLElement | null>(null)

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

  // Shrink the conversation column while the drawer is open and grow it back
  // while the drawer closes. Only the inline margin-right changes, with the
  // same duration/easing as the drawer slide, so the two animations stay
  // symmetrical; the column's left edge and the frame background never move.
  useLayoutEffect(() => {
    if (!hasWorkflow) return

    if (panel === 'open') {
      const center = findConversationColumn()
      const drawer = drawerRef.current
      if (center === null || drawer === null) return
      shiftTargetRef.current = center
      center.style.transition = SHIFT_TRANSITION
      center.style.marginRight = `${measureShift(center, drawer)}px`
      return
    }

    if (panel === 'closing') {
      const center = shiftTargetRef.current
      if (center === null || !center.isConnected) return
      center.style.transition = SHIFT_TRANSITION
      center.style.marginRight = '0px'
      return
    }

    // Drawer fully closed: remove our inline styles so the layout is
    // completely back in the host's hands.
    const center = shiftTargetRef.current
    if (center !== null && center.isConnected) {
      center.style.transition = ''
      center.style.marginRight = ''
    }
    shiftTargetRef.current = null
  }, [panel, hasWorkflow])

  // Keep the push in sync with viewport resizes while the drawer is open.
  useEffect(() => {
    if (!hasWorkflow || panel !== 'open') return
    const onResize = (): void => {
      const center = shiftTargetRef.current
      const drawer = drawerRef.current
      if (center === null || drawer === null || !center.isConnected) return
      center.style.marginRight = `${measureShift(center, drawer)}px`
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [panel, hasWorkflow])

  // If this conversation stops being a workflow conversation, restore the
  // column and reset the panel so nothing is left behind.
  useEffect(() => {
    if (hasWorkflow) return
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setPanel('closed')
    const center = shiftTargetRef.current
    if (center !== null && center.isConnected) {
      center.style.transition = ''
      center.style.marginRight = ''
    }
    shiftTargetRef.current = null
  }, [hasWorkflow])

  // Safety net: never leave the host column shrunk after unmount.
  useEffect(() => () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    const center = shiftTargetRef.current
    if (center !== null && center.isConnected) {
      center.style.transition = ''
      center.style.marginRight = ''
    }
    shiftTargetRef.current = null
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
            <aside ref={drawerRef} className={dockCss.drawer} data-state={panel} onClick={event => { event.stopPropagation() }}>
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
