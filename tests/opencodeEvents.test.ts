import { describe, expect, it } from 'vitest'
import { collapseText, findSessionId, findText, findToolName, parseOpencodeLine } from '../src/core/opencodeEvents.ts'

describe('parseOpencodeLine', () => {
  it('parses a session/message event shaped like opencode json', () => {
    const event = parseOpencodeLine(JSON.stringify({
      type: 'session',
      id: 'ses_abc123',
      title: 'hello',
    }))
    expect(event).not.toBeNull()
    expect(event?.type).toBe('session')
    expect(event?.sessionId).toBe('ses_abc123')
  })

  it('extracts text from nested message blocks', () => {
    const event = parseOpencodeLine(JSON.stringify({
      type: 'message',
      sessionId: 'ses_abc123',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
      },
    }))
    expect(event?.text).toContain('OK')
    expect(event?.sessionId).toBe('ses_abc123')
  })

  it('finds question tool names recursively', () => {
    const event = parseOpencodeLine(JSON.stringify({
      type: 'tool_call',
      data: { tool: 'question', input: { question: 'confirm?' } },
    }))
    expect(event?.toolName).toBe('question')
  })

  it('tolerates malformed lines', () => {
    expect(parseOpencodeLine('not json')).toBeNull()
    expect(parseOpencodeLine('')).toBeNull()
    expect(parseOpencodeLine('[1,2,3]')).toBeNull()
  })

  it('tolerates unknown event shapes without throwing', () => {
    const event = parseOpencodeLine(JSON.stringify({ foo: { bar: [1, 2, 3] } }))
    expect(event).not.toBeNull()
    expect(event?.type).toBeUndefined()
    // Nested numeric junk may be collapsed as text, but parsing must never throw.
    expect(() => parseOpencodeLine(JSON.stringify({ foo: { bar: [1, 2, 3] } }))).not.toThrow()
  })
})

describe('helper extractors', () => {
  it('collapses arrays into text', () => {
    expect(collapseText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toContain('a')
  })

  it('finds text recursively', () => {
    expect(findText({ parts: [{ text: 'hello' }] })).toContain('hello')
  })

  it('finds session ids recursively', () => {
    expect(findSessionId({ payload: { sessionId: 'ses_xyz' } })).toBe('ses_xyz')
  })

  it('finds tool names recursively', () => {
    expect(findToolName({ data: { name: 'bash' } })).toBe('bash')
  })
})