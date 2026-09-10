/**
 * Session-scoped side entrance for dsh-ub-workflow.
 *
 * The entry is mounted in the conversation header-action slot, so it is only
 * rendered for a real conversation. It derives visibility from the durable
 * `/ub-workflow` command node in that conversation's own transcript (never
 * from the in-memory run store), so other conversations never see it and the
 * workflow conversation never loses it across plugin restarts.
 *
 * The visible button and drawer are portaled to `document.body` so they float
 * beside the conversation with independent fixed positioning and animated
 * transitions.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ubWorkflowClient } from './api.ts'
import { WorkflowFlowView } from './WorkflowFlowView.tsx'
import dockCss from './workflow-dock.module.css'

export type WorkflowSidecarProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'ub-workflow'>

const CLOSE_ANIMATION_MS = 240
const SHIFT_TRANSITION = 'margin-right 240ms cubic-bezier(0.22, 0.9, 0.28, 1)'
/** The drawer is flush with the window's right edge, so its left edge is `innerWidth - drawerWidth`. */
const DRAWER_RIGHT = 0
/**
 * The drawer's left edge lands exactly on the conversation's right edge.
 * Flush matters: both surfaces composite the same two `--dsw-alias-bg-base`
 * layers (frame + panel), so a flush join is pixel-identical on both sides and
 * no divider line can appear — any gap would expose the single-layer frame
 * strip, which is visibly lighter and reads as a vertical divider between the
 * drawer and the conversation. The join also stays seam-free at fractional
 * DPI: both edges land on the same CSS pixel, so the browser rasterizes them
 * onto the same device pixel.
 */
const MIN_CENTER_WIDTH = 360

/**
 * The conversation column is the parent of the `conversation` slot wrapper.
 * This is the DSH-layout grid item (`centerCol`) that contains the whole
 * conversation surface inside the `sidebar | center | details` grid frame.
 *
 * While the drawer is open we shrink this item with an inline `margin-right`
 * (animated) until its right edge meets the drawer's left edge flush. Flush is
 * what erases the seam: the conversation surface and the drawer both composite
 * `--dsw-alias-bg-base` over the AppFrame, so at the join both sides show the
 * identical two-layer color and the drawer reads as a seamless extension of
 * the conversation. Any gap between them would expose the single-layer frame
 * strip — visibly lighter, i.e. a vertical divider — which is exactly the
 * artifact this design avoids. The item also stays anchored at the left edge
 * of its grid track, so nothing ever overlaps the sidebar and nothing is
 * clipped by the frame's `overflow: hidden`.
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
  const { sessionId, t, useSession } = props
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const shiftTargetRef = useRef<HTMLElement | null>(null)

  const transcriptHasWorkflow = useSession(snapshot => {
    const nodes: Array<{ kind?: string, name?: string }> = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
    return nodes.some(node => node?.kind === 'command' && node?.name === 'ub-workflow')
  })

  // Durable fallback: on very large sessions the restored transcript projection
  // drops early events, so the live-session command node alone cannot gate the
  // entry across restarts. The run registry (runs.json) persists the
  // conversation↔run binding, so one lightweight state fetch on mount keeps the
  // entry visible in restored sessions whose workflow history predates the
  // projection window.
  const [registryHasWorkflow, setRegistryHasWorkflow] = useState(false)
  useEffect(() => {
    if (transcriptHasWorkflow || registryHasWorkflow) return
    let alive = true
    void ubWorkflowClient.state()
      .then(snapshot => {
        if (alive) setRegistryHasWorkflow((snapshot.runs ?? []).some(run => run.sessionId === sessionId))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [transcriptHasWorkflow, registryHasWorkflow, sessionId])

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
                <WorkflowFlowView sessionId={sessionId} t={t} />
              </div>
            </aside>
          )
        : null}
    </div>,
    document.body,
  )
}
