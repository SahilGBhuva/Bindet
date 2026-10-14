import { describe, expect, it, vi } from 'vitest'
import { parseServerTime } from './api'
import { isChatMessage, isSafeAttachmentPath, isTypingNow } from './chat'

// chat.ts and api.ts listen on window when they load (vi.hoisted runs before imports).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

describe('isSafeAttachmentPath', () => {
  const owner = { group_id: 'g1', sender_id: 's1' }

  it('accepts an image in the sender’s own folder of that group', () => {
    expect(isSafeAttachmentPath('g1/s1/photo-1.webp', owner)).toBe(true)
  })

  it('rejects a path in another member’s folder or another group', () => {
    expect(isSafeAttachmentPath('g1/s2/photo.webp', owner)).toBe(false)
    expect(isSafeAttachmentPath('g2/s1/photo.webp', owner)).toBe(false)
  })

  it('rejects traversal, nested folders and odd file names', () => {
    expect(isSafeAttachmentPath('g1/s1/../s2/photo.webp', owner)).toBe(false)
    expect(isSafeAttachmentPath('g1/s1/sub/photo.webp', owner)).toBe(false)
    expect(isSafeAttachmentPath('g1/s1/.hidden', owner)).toBe(false)
    expect(isSafeAttachmentPath('g1/s1/', owner)).toBe(false)
    expect(isSafeAttachmentPath('g1/s1/a b.png', owner)).toBe(false)
  })

  it('rejects missing paths or owners', () => {
    expect(isSafeAttachmentPath(null, owner)).toBe(false)
    expect(isSafeAttachmentPath('', owner)).toBe(false)
    expect(isSafeAttachmentPath('/s1/a.png', { group_id: '', sender_id: 's1' })).toBe(false)
  })
})

describe('isTypingNow', () => {
  const now = Date.parse('2026-10-14T12:00:00Z')
  const state = (typing_until: string) => ({ group_id: 'g', student_id: 's', display_name: 'Maya', typing_until })

  it('is typing until the signal expires', () => {
    expect(isTypingNow(state('2026-10-14T12:00:04Z'), now)).toBe(true)
    expect(isTypingNow(state('2026-10-14T12:00:00Z'), now)).toBe(false)
    expect(isTypingNow(state('2026-10-14T11:59:00Z'), now)).toBe(false)
  })

  it('ignores signals too far in the future or unreadable', () => {
    expect(isTypingNow(state('2026-10-14T12:00:15Z'), now)).toBe(true)
    expect(isTypingNow(state('2026-10-14T12:00:16Z'), now)).toBe(false)
    expect(isTypingNow(state('2099-01-01T00:00:00Z'), now)).toBe(false)
    expect(isTypingNow(state('soon'), now)).toBe(false)
  })
})

describe('isChatMessage', () => {
  const row = { id: 'm1', group_id: 'g1', sender_id: 's1', created_at: '2026-10-14T12:00:00Z', body: 'hi' }

  it('accepts a message row, with or without text (an image-only message)', () => {
    expect(isChatMessage(row)).toBe(true)
    expect(isChatMessage({ ...row, body: null })).toBe(true)
  })

  it('rejects rows missing what the chat needs', () => {
    expect(isChatMessage({ ...row, id: '' })).toBe(false)
    expect(isChatMessage({ ...row, sender_id: 7 })).toBe(false)
    expect(isChatMessage({ ...row, body: 42 })).toBe(false)
  })

  it('rejects error objects and non-objects', () => {
    expect(isChatMessage({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isChatMessage(null)).toBe(false)
    expect(isChatMessage('hello')).toBe(false)
  })
})

describe('parseServerTime', () => {
  it('reads UTC timestamps with or without a zone', () => {
    const utc = Date.UTC(2026, 9, 14, 12, 30)
    expect(parseServerTime('2026-10-14T12:30:00Z')).toBe(utc)
    expect(parseServerTime('2026-10-14T12:30:00')).toBe(utc)
    expect(parseServerTime('2026-10-14T12:30:00.000000')).toBe(utc)
  })

  it('respects an explicit offset', () => {
    expect(parseServerTime('2026-10-14T14:30:00+02:00')).toBe(Date.UTC(2026, 9, 14, 12, 30))
    expect(parseServerTime('2026-10-14T07:30:00-0500')).toBe(Date.UTC(2026, 9, 14, 12, 30))
  })

  it('is NaN for nothing', () => {
    expect(parseServerTime(null)).toBeNaN()
    expect(parseServerTime(undefined)).toBeNaN()
    expect(parseServerTime('')).toBeNaN()
  })
})
