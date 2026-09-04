/**
 * Browser-half entry for dsh-ub-workflow — runs inside the DSH web GUI.
 * Registers the locale dictionaries and mounts the workflow flow chart into
 * the conversation view ring (`conversation.view`), so it appears as a tab
 * beside the regular chat view.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh } from './locales.ts'
import './slots-augment.ts'
import { WorkflowFlowView } from './WorkflowFlowView.tsx'

export type { WorkflowFlowViewProps } from './WorkflowFlowView.tsx'
export { WorkflowFlowView } from './WorkflowFlowView.tsx'

/** Required services: slots for the view ring, conversation for the seam, locale for copy. */
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
      scope.slots.register(
        {
          name: 'conversation.view',
          id: 'ub-workflow',
          order: 300,
          label: () => 'UB 工作流',
          locale: NS,
        },
        WorkflowFlowView,
      )
    } catch (error) {
      console.warn('[ub-workflow] failed to register into conversation.view', error)
    }
  })
}