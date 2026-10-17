import { describe, expect, it } from 'vitest'
import { buildThread, dayLabel, emojiOnlyCount, linkify, listTimeLabel, matchesSearch, previewLine, seenLine } from './chatView'

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const msg = (id: string, sender: string, when: number) => ({ id, sender_id: sender, created_at: new Date(when).toISOString() })
const timeOf = (message: { created_at: string }) => Date.parse(message.created_at)

describe('buildThread', () => {
  it('groups one sender’s messages within three minutes into a run', () => {
    const items = buildThread([
      msg('a', 'milan', at(2026, 10, 14, 9, 0)),
      msg('b', 'milan', at(2026, 10, 14, 9, 2)),
      msg('c', 'milan', at(2026, 10, 14, 9, 4)),
      msg('d', 'me', at(2026, 10, 14, 9, 5)),
    ], 'me', timeOf)
    expect(items.map((item) => item.kind)).toEqual(['day', 'run', 'run'])
    const [, first, second] = items
    expect(first.kind === 'run' && first.messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(second.kind === 'run' && second.own).toBe(true)
  })

  it('starts a new run after a three-minute pause', () => {
    const items = buildThread([msg('a', 'ava', at(2026, 10, 14, 9, 0)), msg('b', 'ava', at(2026, 10, 14, 9, 3))], 'me', timeOf)
    expect(items.filter((item) => item.kind === 'run')).toHaveLength(2)
  })

  it('puts a day chip at each new calendar day and a time break after an hour', () => {
    const items = buildThread([
      msg('a', 'ava', at(2026, 10, 13, 23, 58)),
      msg('b', 'ava', at(2026, 10, 14, 0, 1)),
      msg('c', 'ava', at(2026, 10, 14, 1, 30)),
    ], 'me', timeOf)
    expect(items.map((item) => item.kind)).toEqual(['day', 'run', 'day', 'run', 'time', 'run'])
  })

  it('keeps keys stable as messages are added', () => {
    const base = [msg('a', 'ava', at(2026, 10, 14, 9, 0))]
    const before = buildThread(base, 'me', timeOf).map((item) => item.key)
    const after = buildThread([...base, msg('b', 'ava', at(2026, 10, 14, 9, 1))], 'me', timeOf).map((item) => item.key)
    expect(after).toEqual(before)
  })

  it('handles an empty list', () => {
    expect(buildThread([], 'me', timeOf)).toEqual([])
  })
})

describe('dayLabel', () => {
  const now = at(2026, 10, 16, 15)
  it('names recent days', () => {
    expect(dayLabel(at(2026, 10, 16, 1), now, 'en-US')).toBe('Today')
    expect(dayLabel(at(2026, 10, 15, 23), now, 'en-US')).toBe('Yesterday')
    expect(dayLabel(at(2026, 10, 12), now, 'en-US')).toBe('Monday')
  })
  it('dates older days, with the year only when it differs', () => {
    expect(dayLabel(at(2026, 10, 5), now, 'en-US')).toBe('Mon, Oct 5')
    expect(dayLabel(at(2025, 10, 6), now, 'en-US')).toBe('Mon, Oct 6, 2025')
  })
})

describe('listTimeLabel', () => {
  const now = at(2026, 10, 16, 15)
  const clock = () => '3:04 pm'
  it('shows a clock today, then Yesterday, a weekday and a date', () => {
    expect(listTimeLabel(at(2026, 10, 16, 9), clock, now, 'en-US')).toBe('3:04 pm')
    expect(listTimeLabel(at(2026, 10, 15, 9), clock, now, 'en-US')).toBe('Yesterday')
    expect(listTimeLabel(at(2026, 10, 13, 9), clock, now, 'en-US')).toBe('Tue')
    expect(listTimeLabel(at(2026, 9, 1, 9), clock, now, 'en-US')).toBe('Sep 1')
  })
})

describe('emojiOnlyCount', () => {
  it('counts short emoji-only messages, including joined and skin-tone emoji and flags', () => {
    expect(emojiOnlyCount('🔥')).toBe(1)
    expect(emojiOnlyCount(' 😂😂 ')).toBe(2)
    expect(emojiOnlyCount('👍🏽')).toBe(1)
    expect(emojiOnlyCount('👩‍🔬')).toBe(1)
    expect(emojiOnlyCount('🇲🇽 ❤️')).toBe(2)
  })
  it('is 0 for text, numbers, or long emoji runs', () => {
    expect(emojiOnlyCount('ok 👍')).toBe(0)
    expect(emojiOnlyCount('42')).toBe(0)
    expect(emojiOnlyCount('')).toBe(0)
    expect(emojiOnlyCount(null)).toBe(0)
    expect(emojiOnlyCount('🎉🎉🎉🎉🎉🎉🎉')).toBe(0)
  })
})

describe('linkify', () => {
  it('finds http(s) and www links and leaves punctuation outside', () => {
    expect(linkify('see https://khanacademy.org/bio, then www.quizlet.com.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://khanacademy.org/bio', href: 'https://khanacademy.org/bio' },
      { kind: 'text', text: ', then ' },
      { kind: 'link', text: 'www.quizlet.com', href: 'https://www.quizlet.com' },
      { kind: 'text', text: '.' },
    ])
  })
  it('keeps balanced brackets in a link', () => {
    expect(linkify('https://en.wikipedia.org/wiki/Cell_(biology)')[0]).toMatchObject({ kind: 'link', text: 'https://en.wikipedia.org/wiki/Cell_(biology)' })
    expect(linkify('(https://a.io/x)')).toEqual([
      { kind: 'text', text: '(' }, { kind: 'link', text: 'https://a.io/x', href: 'https://a.io/x' }, { kind: 'text', text: ')' },
    ])
  })
  it('never links other schemes', () => {
    expect(linkify('javascript:alert(1) data:text/html,hi')).toEqual([{ kind: 'text', text: 'javascript:alert(1) data:text/html,hi' }])
  })
})

describe('previewLine', () => {
  it('prefixes who sent it and describes photos', () => {
    expect(previewLine({ sender_id: 'me', body: 'see you\nat 4' }, 'me', 'Alex')).toBe('You: see you at 4')
    expect(previewLine({ sender_id: 'm', body: '', attachment_path: 'g/m/a.png' }, 'me', 'Milan Shah')).toBe('Milan: 📷 Photo')
  })
})

describe('seenLine', () => {
  it('reads naturally for one, two, several and everyone', () => {
    expect(seenLine([], 3)).toBe('Delivered')
    expect(seenLine(['Milan Shah'], 3)).toBe('Seen by Milan')
    expect(seenLine(['Milan', 'Ava Li'], 3)).toBe('Seen by Milan and Ava')
    expect(seenLine(['Milan', 'Ava', 'Jo', 'Kai'], 6)).toBe('Seen by Milan, Ava and 2 others')
    expect(seenLine(['Milan', 'Ava', 'Jo'], 3)).toBe('Seen by everyone')
  })
})

describe('matchesSearch', () => {
  it('ignores case and accents and matches any field', () => {
    expect(matchesSearch('jose', ['Bio squad', 'José Ruiz'])).toBe(true)
    expect(matchesSearch('  ', ['x'])).toBe(true)
    expect(matchesSearch('chem', ['Bio squad'])).toBe(false)
  })
})
