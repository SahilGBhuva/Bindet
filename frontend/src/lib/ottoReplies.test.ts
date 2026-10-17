import { describe, expect, it, vi } from 'vitest'
import { awaitingReply, REPLY_GRACE_MS, replyArrivedAfter } from './ottoReplies'

// api.ts listens on window when it loads (vi.hoisted runs before imports).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

const NOW = Date.parse('2026-10-16T12:00:00Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const question = (id: number, msAgo: number) => ({ id, role: 'user' as const, created_at: at(msAgo), attachments: [] as string[] })
const reply = (id: number) => ({ id, role: 'assistant' as const, created_at: at(0), attachments: [] as string[] })

describe('awaitingReply', () => {
  it('waits for a reply to a question sent moments ago (reloaded mid-reply)', () => {
    expect(awaitingReply([reply(1), question(2, 5_000)], NOW)).toBe(true)
  })

  it('calls an old unanswered question unanswered', () => {
    expect(awaitingReply([question(2, REPLY_GRACE_MS + 1_000)], NOW)).toBe(false)
  })

  it('is not waiting once the reply is there', () => {
    expect(awaitingReply([question(2, 5_000), reply(3)], NOW)).toBe(false)
  })
})

describe('replyArrivedAfter', () => {
  it('finds a reply saved after the question, so Retry does not send it twice', () => {
    expect(replyArrivedAfter([question(2, 5_000), reply(3)], 2)).toBe(true)
    expect(replyArrivedAfter([reply(1), question(2, 5_000)], 2)).toBe(false)
    expect(replyArrivedAfter([reply(3)], 0)).toBe(false)
  })
})
