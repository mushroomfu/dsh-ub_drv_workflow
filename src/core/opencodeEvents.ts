/**
 * Tolerant parser for `opencode run --format json` output lines. The JSON
 * event schema varies across opencode versions, so the parser never throws:
 * every line either yields a coarse ParsedOpencodeEvent or null.
 */

export interface ParsedOpencodeEvent {
  type?: string
  subtype?: string
  sessionId?: string
  toolName?: string
  /** Human-readable text carried by the event, collapsed to a single string. */
  text?: string
  raw: Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

const MAX_SEARCH_DEPTH = 32
const MAX_SEARCH_NODES = 4_096

interface SearchNode {
  value: unknown
  depth: number
}

function boundedSearch<T>(root: unknown, inspect: (value: unknown) => T | undefined, childKeys?: readonly string[]): T | undefined {
  const pending: SearchNode[] = [{ value: root, depth: 0 }]
  let visited = 0
  while (pending.length > 0 && visited < MAX_SEARCH_NODES) {
    const current = pending.pop()
    if (current === undefined) break
    visited += 1
    const found = inspect(current.value)
    if (found !== undefined) return found
    if (current.depth >= MAX_SEARCH_DEPTH) continue
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 })
      }
    } else if (isRecord(current.value)) {
      const record = current.value
      const preferred = childKeys === undefined ? [] : childKeys.filter(key => key in record)
      const preferredSet = new Set(preferred)
      const other = Object.keys(record).filter(key => key !== 'raw' && !preferredSet.has(key))
      const ordered = [...preferred, ...other]
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        pending.push({ value: record[ordered[index]], depth: current.depth + 1 })
      }
    }
  }
  return undefined
}

/** Collapse any JSON-ish value into readable text (arrays of blocks become lines). */
export function collapseText(value: unknown, maxLength = 1200): string {
  const parts: string[] = []
  const pending: SearchNode[] = [{ value, depth: 0 }]
  let visited = 0
  let length = 0
  while (pending.length > 0 && visited < MAX_SEARCH_NODES && length < maxLength) {
    const current = pending.pop()
    if (current === undefined) break
    visited += 1
    if (typeof current.value === 'string' || typeof current.value === 'number' || typeof current.value === 'boolean') {
      const part = String(current.value).trim()
      if (part !== '') {
        parts.push(part)
        length += part.length + 1
      }
      continue
    }
    if (current.depth >= MAX_SEARCH_DEPTH) continue
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 })
      }
    } else if (isRecord(current.value)) {
      const text = firstStringField(current.value, ['text', 'content', 'message', 'summary', 'title'])
      const toolName = firstStringField(current.value, ['tool', 'toolName', 'name'])
      const selected = text ?? toolName
      if (selected !== undefined) pending.push({ value: selected, depth: current.depth + 1 })
    }
  }
  return parts.join('\n').slice(0, maxLength)
}

/** Recursively locate the first useful session id shaped string. */
export function findSessionId(value: unknown): string | undefined {
  return boundedSearch(value, current => {
    if (typeof current === 'string' && /^(ses_|session_)[A-Za-z0-9_-]+$/.test(current)) return current
    if (isRecord(current)) {
      const direct = firstStringField(current, ['sessionId', 'sessionID', 'session_id'])
      if (direct !== undefined && direct !== '') return direct
    }
    return undefined
  })
}

/** Recursively locate the first tool name in common opencode event shapes. */
export function findToolName(value: unknown): string | undefined {
  return boundedSearch(value, current => (
    isRecord(current) ? firstStringField(current, ['tool', 'toolName', 'tool_name', 'name']) : undefined
  ))
}

/** Recursively locate the first human-readable text. */
export function findText(value: unknown, maxLength = 1200): string {
  return boundedSearch(value, current => {
    if (typeof current === 'string') {
      const text = current.trim().slice(0, maxLength)
      return text === '' ? undefined : text
    }
    if (typeof current === 'number' || typeof current === 'boolean') return String(current)
    return undefined
  }, ['text', 'content', 'message', 'summary', 'title', 'error']) ?? ''
}

/**
 * Parse one line of `opencode run --format json`.
 * Always returns null or a normalized event; never throws.
 */
export function parseOpencodeLine(line: string): ParsedOpencodeEvent | null {
  if (line.length > 256 * 1024) return null
  const trimmed = line.trim()
  if (trimmed === '') return null

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null

  try {
    const type = firstStringField(raw, ['type', 'subtype', 'event'])
    const subtype = firstStringField(raw, ['subtype', 'kind'])
    const toolName = findToolName(raw)
    const sessionId = findSessionId(raw)
    const text = findText(raw)
    return { type, subtype, sessionId, toolName, text: text || undefined, raw }
  } catch {
    return null
  }
}
