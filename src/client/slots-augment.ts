/**
 * Locale and slot augmentation for the dsh-ub-workflow client. The
 * conversation.view slot is declared by ui-conversation; we only merge our
 * locale namespace because no child slots are owned.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { UbWorkflowKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'ub-workflow': UbWorkflowKey
  }
}