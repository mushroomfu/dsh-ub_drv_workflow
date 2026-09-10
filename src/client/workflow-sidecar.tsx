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
 * Layout: while the drawer is open the conversation column is pushed LEFT
 * with an animated inline margin-right until its right edge meets the
 * drawer's left edge flush — the conversation keeps its full surface (scroll,
 * composer, send) beside the drawer instead of being covered. On very narrow
 * viewports the push is capped and the drawer overlays instead. There is no
 * backdrop: clicking anywhere OUTSIDE the drawer closes it (the click still
 * reaches the conversation), and the conversation itself stays interactive.
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
const SHIFT_TRANSITION = 'margin-right 240ms cubic-bezier(0.22, 0.9, 0.28, 1)'
/** The drawer is flush with the window's right edge, so its left edge is `innerWidth - drawerWidth`. */
const DRAWER_RIGHT = 0
/** The conversation column is never squeezed below this width; past it the drawer overlays the conversation instead of pushing it. */
const MIN_CENTER_WIDTH = 360
/** The drawer never shrinks below this height when capping the overlay above the composer. */
const DRAWER_MIN_HEIGHT = 280
/** Fallback drawer top when the titlebar cannot be measured. Equals the app titlebar height. */
const TITLEBAR_BOTTOM = 36

/**
 * The conversation column is the parent of the `conversation` slot wrapper.
 * This is the DSH-layout grid item (`centerCol`) that contains the whole
 * conversation surface inside the `sidebar | center | details` grid frame.
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
 * Returns the shift plus whether the viewport was too narrow to fit it (the
 * drawer then overlays the conversation instead of pushing it).
 *
 * The measurement is transition-proof: with an inline margin `m`, the column's
 * right edge is `trackRight - m` and its width is `trackWidth - m`, so
 * `rect.right + currentMargin` and `rect.width + currentMargin` recover the
 * un-shifted track geometry even when read mid-animation (e.g. the drawer is
 * reopened while the closing transition is still running).
 */
function measureShift(center: HTMLElement, drawer: HTMLElement): { shift: number, capped: boolean } {
  const rect = center.getBoundingClientRect()
  const margin = Number.parseFloat(window.getComputedStyle(center).marginRight) || 0
  const trackRight = rect.right + margin
  const trackWidth = rect.width + margin
  const drawerLeft = window.innerWidth - DRAWER_RIGHT - drawer.offsetWidth
  const wanted = Math.round(trackRight - drawerLeft)
  const maxShift = Math.round(trackWidth - MIN_CENTER_WIDTH)
  if (wanted <= maxShift) return { shift: Math.max(0, wanted), capped: false }
  return { shift: Math.max(0, maxShift), capped: true }
}

/** Bottom edge (viewport px) of the window titlebar, or the documented fallback. */
function titlebarBottom(): number {
  const bar = document.querySelector('header.dshDesktopFrameTitlebar')
  if (bar instanceof HTMLElement) {
    const bottom = bar.getBoundingClientRect().bottom
    if (bottom > 0 && bottom < 120) return Math.round(bottom)
  }
  return TITLEBAR_BOTTOM
}

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
  const fabRef = useRef<HTMLButtonElement | null>(null)
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

  /**
   * Push the conversation column left while the drawer is open (and back on
   * close). The drawer meets the column's right edge flush, so the column
   * keeps its full interactive surface beside the drawer. When the viewport
   * is too narrow to push, the drawer overlays instead and then keeps its
   * bottom edge clear of the composer so the input stays usable.
   */
  const applyShift = useCallback((): void => {
    const center = shiftTargetRef.current
    const drawer = drawerRef.current
    if (center === null || drawer === null || !center.isConnected) return
    const { shift, capped } = measureShift(center, drawer)
    center.style.marginRight = `${shift}px`
    if (capped) {
      const composerTop = findComposerTop()
      let bottom = 10
      if (composerTop > titlebarBottom()) bottom = Math.max(10, Math.round(window.innerHeight - composerTop) + 12)
      const maxBottom = Math.max(10, window.innerHeight - titlebarBottom() - DRAWER_MIN_HEIGHT)
      drawer.style.bottom = `${Math.min(bottom, maxBottom)}px`
    } else {
      drawer.style.bottom = ''
    }
  }, [])

  useLayoutEffect(() => {
    if (!hasWorkflow) return

    if (panel === 'open') {
      const center = findConversationColumn()
      const drawer = drawerRef.current
      if (center === null || drawer === null) return
      shiftTargetRef.current = center
      drawer.style.top = `${titlebarBottom()}px`
      center.style.transition = SHIFT_TRANSITION
      applyShift()
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
    if (drawerRef.current !== null) {
      drawerRef.current.style.bottom = ''
      drawerRef.current.style.top = ''
    }
    shiftTargetRef.current = null
  }, [panel, hasWorkflow, applyShift])

  // Keep the push in sync with viewport resizes while the drawer is open.
  useEffect(() => {
    if (!hasWorkflow || panel !== 'open') return
    window.addEventListener('resize', applyShift)
    return () => window.removeEventListener('resize', applyShift)
  }, [panel, hasWorkflow, applyShift])

  /**
   * Click-outside close WITHOUT a backdrop: a document-level pointerdown that
   * lands outside the drawer (and outside our own FAB, which toggles itself)
   * closes the drawer. The event still reaches the conversation underneath,
   * so scrolling, typing and sending keep working — the first click on the
   * conversation simply also dismisses the drawer.
   */
  useEffect(() => {
    if (panel !== 'open') return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (drawerRef.current?.contains(target) === true) return
      if (fabRef.current?.contains(target) === true) return
      requestClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [panel, requestClose])

  // Esc closes the drawer, mirroring the header close button.
  useEffect(() => {
    if (panel !== 'open') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel, requestClose])

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

  // Safety net: never leave the host column shifted after unmount.
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

  return createPortal(
    <div className={dockCss.root} data-panel={panel}>
      <button
        ref={fabRef}
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
