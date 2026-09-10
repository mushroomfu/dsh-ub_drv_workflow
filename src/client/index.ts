/**
 * Browser-half entry for dsh-ub-workflow — runs inside the DSH web GUI.
 *
 * The visible entry is a session-scoped floating side button + animated right
 * drawer. It is registered into `conversation.session.header.actions`, so the
 * session-scoped component receives the conversation snapshot and decides from
 * the durable `/ub-workflow` command node whether this conversation owns a
 * workflow; other conversations never see it.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, zh } from './locales.ts'
import './slots-augment.ts'
import { UbWorkflowSidecar } from './workflow-sidecar.tsx'
import { WorkflowFlowView } from './WorkflowFlowView.tsx'

export type { WorkflowFlowViewProps } from './WorkflowFlowView.tsx'
export { WorkflowFlowView } from './WorkflowFlowView.tsx'

/** Required services: slots for the session header, conversation for the seam, locale for copy. */
export const inject = ['slots', 'conversation', 'locale']

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

  ctx.inject(['slots', 'conversation'], (scope: ClientContext) => {
    try {
      // Wait for the session header-actions slot declaration, then register.
      // `slots.inject` guarantees the declaration exists before our entry.
      return scope.slots.inject('conversation.session.header.actions', () => {
        try {
          return scope.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'ub-workflow',
              order: 40,
              locale: NS,
            },
            UbWorkflowSidecar,
          )
        } catch (error) {
          console.warn('[ub-workflow] failed to register workflow sidecar', error)
          return () => {}
        }
      })
    } catch (error) {
      console.warn('[ub-workflow] failed to wait for workflow sidecar slot', error)
      return () => {}
    }
  })
}