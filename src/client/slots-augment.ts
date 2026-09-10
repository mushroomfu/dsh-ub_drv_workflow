/**
 * Locale and slot augmentation for the dsh-ub-workflow client.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { UbWorkflowKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'ub-workflow': UbWorkflowKey
  }
}