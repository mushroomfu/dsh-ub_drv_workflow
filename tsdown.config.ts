/**
 * Standalone build config for dsh-ub-workflow.
 *
 * Uses the vendored client-bundle preset (build/tsdown.client.ts + its
 * build/web-platform.ts sibling): node-half lib/ plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__).
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-ub-workflow', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
  ],
})