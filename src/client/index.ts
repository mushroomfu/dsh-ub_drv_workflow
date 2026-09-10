/**
 * Browser-half entry for dsh-ub-workflow — runs inside the DSH web GUI.
 * Registers the locale dictionaries, mounts the workflow flow chart into
 * the conversation view ring (`conversation.view`, a tab beside the chat),
 * and mounts the session-scoped floating sidecar (FAB + drawer) into the
 * conversation header actions so any conversation that ran `/ub-workflow`
 * keeps a one-click live-progress entrance.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createElement, useMemo, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createUbWorkflowClient } from './api.ts'
import { en, zh } from './locales.ts'
import './slots-augment.ts'
import { UbWorkflowSidecar, type WorkflowSidecarProps } from './workflow-sidecar.tsx'
import { WorkflowFlowView, type WorkflowFlowViewProps } from './WorkflowFlowView.tsx'

export type { WorkflowFlowViewProps } from './WorkflowFlowView.tsx'
export { WorkflowFlowView } from './WorkflowFlowView.tsx'

/** Required services: slots for the view ring and locale for copy. */
export const inject = ['slots', 'locale', 'connection']

/** Dictionary namespace owned by this plugin. */
const NS = 'ub-workflow'

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'ub-workflow: dictionaries')

  ctx.inject(['slots', 'connection'], (scope: ClientContext) => {
    const connection = (scope as unknown as { connection: { rpc: ClientConnectionRpc } }).connection
    const clientOf = (sessionId: string) => createUbWorkflowClient(connection.rpc, sessionId)
    const SessionWorkflowFlowView = (props: Omit<WorkflowFlowViewProps, 'workflowClient'>): ReactNode => {
      const workflowClient = useMemo(
        () => clientOf(props.sessionId),
        [props.sessionId],
      )
      return createElement(WorkflowFlowView, { key: props.sessionId, ...props, workflowClient })
    }
    const SessionSidecar = (props: Omit<WorkflowSidecarProps, 'workflowClient'>): ReactNode => {
      const workflowClient = useMemo(
        () => clientOf(props.sessionId),
        [props.sessionId],
      )
      return createElement(UbWorkflowSidecar, { key: props.sessionId, ...props, workflowClient })
    }
    const disposeView = scope.slots.inject('conversation.view', () => (
      scope.slots.register(
        {
          name: 'conversation.view',
          id: 'ub-workflow',
          order: 300,
          label: () => 'UB 工作流',
          locale: NS,
        },
        SessionWorkflowFlowView,
      )
    ))
    const disposeSidecar = scope.slots.inject('conversation.session.header.actions', () => (
      scope.slots.register(
        {
          name: 'conversation.session.header.actions',
          id: 'ub-workflow-sidecar',
          order: 40,
          locale: NS,
        },
        SessionSidecar,
      )
    ))
    return () => {
      disposeView?.()
      disposeSidecar?.()
    }
  })
}
