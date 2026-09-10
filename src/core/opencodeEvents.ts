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

/** Collapse any JSON-ish value into readable text (arrays of blocks become lines). */
export function collapseText(value: unknown, maxLength = 1200): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map(item => collapseText(item, maxLength)).filter(Boolean).join('\n').slice(0, maxLength)
  }
  if (isRecord(value)) {
    const text = firstStringField(value, ['text', 'content', 'message', 'summary', 'title'])
    if (text !== undefined) return collapseText(text, maxLength)
    // Tool call / structured block: keep the tool-ish identifiers, not raw ids.
    const toolName = firstStringField(value, ['tool', 'toolName', 'name'])
    if (toolName !== undefined) return toolName
  }
  return ''
}

/** Recursively locate the first useful session id shaped string. */
export function findSessionId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    // Accept obvious session id shapes: ses_…, session_…, any 26-char cuid-like
    // token next to a session field is handled by the field-name search below.
    if (/^(ses_|session_)[A-Za-z0-9_-]+$/.test(value)) return value
    return undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (isRecord(value)) {
    const direct = firstStringField(value, ['sessionId', 'sessionID', 'session_id'])
    if (direct !== undefined && direct !== '') return direct
    for (const [key, child] of Object.entries(value)) {
      if (key === 'raw' || key === 'parts' || key === 'text') continue
      const found = findSessionId(child)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Recursively locate the first tool name in common opencode event shapes. */
export function findToolName(value: unknown): string | undefined {
  if (isRecord(value)) {
    const direct = firstStringField(value, ['tool', 'toolName', 'tool_name', 'name'])
    if (direct !== undefined) return direct
    for (const [key, child] of Object.entries(value)) {
      if (key === 'raw') continue
      const found = findToolName(child)
      if (found !== undefined) return found
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const found = findToolName(item)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Recursively locate the first human-readable text. */
export function findText(value: unknown, maxLength = 1200): string {
  if (typeof value === 'string') return value.trim().slice(0, maxLength)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = findText(item, maxLength)
      if (text !== '') return text
    }
    return ''
  }
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'message', 'summary', 'title', 'error']) {
      if (key in value) {
        const text = findText(value[key], maxLength)
        if (text !== '') return text
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'raw') continue
      if (typeof child === 'object' && child !== null) {
        const text = findText(child, maxLength)
        if (text !== '') return text
      }
    }
  }
  return ''
}

/**
 * Parse one line of `opencode run --format json`.
 * Always returns null or a normalized event; never throws.
 */
export function parseOpencodeLine(line: string): ParsedOpencodeEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null

  const type = firstStringField(raw, ['type', 'subtype', 'event'])
  const subtype = firstStringField(raw, ['subtype', 'kind'])
  const toolName = findToolName(raw)
  const sessionId = findSessionId(raw)
  const text = findText(raw)

  return { type, subtype, sessionId, toolName, text: text || undefined, raw }
}