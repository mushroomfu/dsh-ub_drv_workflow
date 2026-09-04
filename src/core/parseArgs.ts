/**
 * Lightweight parser for the slash-command trigger input. It recognizes the
 * ub-leader explicit parameters needed to choose the stage chain and repo
 * metadata, and returns the cleaned natural-language requirement. Unknown
 * tokens are preserved in the requirement instead of being silently dropped.
 */

import type { RunMode } from './types.ts'

export interface ParsedWorkflowArgs {
  module?: string
  mode: RunMode
  designOnly: boolean
  deploy: boolean
  changeId?: string
  requirement: string
}

const MODULES = new Set(['ubase', 'cdma', 'udma', 'ummu', 'ubus'])
const MODES = new Set(['dev', 'full', 'explore'])

function isMode(value: string): value is RunMode {
  return MODES.has(value)
}

export function parseWorkflowArgs(rawInput: string): ParsedWorkflowArgs {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  const rest: string[] = []

  let module: string | undefined
  let mode: RunMode = 'dev'
  let designOnly = false
  let deploy = false
  let changeId: string | undefined
  let explicitMode = false

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const next = tokens[i + 1]

    if (token === '--module' && next !== undefined && MODULES.has(next)) {
      module = next
      i += 1
    } else if (token === '--mode' && next !== undefined && isMode(next)) {
      mode = next
      explicitMode = true
      i += 1
    } else if (token === '--stage' && next === 'design') {
      designOnly = true
      i += 1
    } else if (token === '--deploy') {
      deploy = true
    } else if (token === '--change-id' && next !== undefined && !next.startsWith('--')) {
      changeId = next
      i += 1
    } else {
      rest.push(token)
    }
  }

  // `--deploy` implies the full chain; without an explicit different mode the
  // run is full mode (the same semantic as the launch form's deploy checkbox).
  if (deploy && !explicitMode) mode = 'full'

  const requirement = rest.join(' ').trim()

  return {
    module,
    mode,
    designOnly,
    deploy,
    changeId,
    requirement,
  }
}