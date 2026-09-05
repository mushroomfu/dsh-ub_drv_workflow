/**
 * Browser-half entry for dsh-ub-workflow — runs inside the DSH web GUI.
 * Registers the locale dictionaries and mounts the workflow flow chart into
 * the conversation view ring (`conversation.view`), so it appears as a tab
 * beside the regular chat view.
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
    const SessionWorkflowFlowView = (props: Omit<WorkflowFlowViewProps, 'workflowClient'>): ReactNode => {
      const workflowClient = useMemo(
        () => createUbWorkflowClient(connection.rpc, props.sessionId),
        [props.sessionId],
      )
      return createElement(WorkflowFlowView, { key: props.sessionId, ...props, workflowClient })
    }
    return scope.slots.inject('conversation.view', () => (
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
  })
}
