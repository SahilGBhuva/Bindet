import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPracticeDraft, formatClock, loadPracticeDraft, savePracticeDraft, suggestedMinutes } from './practice'
import { avoidOpeningWith, lengthLabel, scopeLabel, scoreAnswers } from './practiceLab'

// practiceLab imports api.ts, which listens on window when it loads (vi.hoisted runs before imports).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [600, '10:00'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [59.6, '1:00'],
    [-10, '0:00'],
  ])('%f seconds → %s', (seconds, text) => {
    expect(formatClock(seconds)).toBe(text)
  })
})

describe('suggestedMinutes', () => {
  it('allows 1.5 minutes a question, rounded up, between 5 and 60', () => {
    expect(suggestedMinutes(1)).toBe(5)
    expect(suggestedMinutes(10)).toBe(15)
    expect(suggestedMinutes(15)).toBe(23)
    expect(suggestedMinutes(100)).toBe(60)
  })

  it('gives Easy more time a question and Hard less, still between 5 and 60', () => {
    expect([5, 10, 15].map((count) => suggestedMinutes(count, 'easy'))).toEqual([10, 20, 30])
    expect([5, 10, 15].map((count) => suggestedMinutes(count, 'medium'))).toEqual([8, 15, 23])
    expect([5, 10, 15].map((count) => suggestedMinutes(count, 'hard'))).toEqual([6, 12, 18])
    expect(suggestedMinutes(10)).toBe(suggestedMinutes(10, 'medium'))
    expect(suggestedMinutes(1, 'hard')).toBe(5)
    expect(suggestedMinutes(40, 'easy')).toBe(60)
    for (const count of [5, 10, 15]) {
      expect(suggestedMinutes(count, 'easy')).toBeGreaterThan(suggestedMinutes(count, 'medium'))
      expect(suggestedMinutes(count, 'medium')).toBeGreaterThan(suggestedMinutes(count, 'hard'))
    }
  })
})

describe('practice drafts', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a draft and clears it', () => {
    savePracticeDraft('t1', { answers: { 0: 'B', 3: 'mitosis' }, flags: [2], current: 3 })
    expect(loadPracticeDraft('t1')).toEqual({ answers: { 0: 'B', 3: 'mitosis' }, flags: [2], current: 3 })
    clearPracticeDraft('t1')
    expect(loadPracticeDraft('t1')).toBeNull()
  })

  it('drops malformed fields from a tampered or old draft', () => {
    store.set('bindit:practice:t1', JSON.stringify({ answers: { 0: 'ok', x: 'bad', 1: 7, 2: 'y'.repeat(900) }, flags: [1, 'two', 2.5], current: 'three' }))
    const draft = loadPracticeDraft('t1')
    expect(draft?.answers).toEqual({ 0: 'ok', 2: 'y'.repeat(500) })
    expect(draft?.flags).toEqual([1])
    expect(draft?.current).toBe(0)
  })

  it('returns null for corrupt JSON or blocked storage instead of throwing', () => {
    store.set('bindit:practice:t1', '{oops')
    expect(loadPracticeDraft('t1')).toBeNull()
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
    expect(loadPracticeDraft('t1')).toBeNull()
    expect(() => savePracticeDraft('t1', { answers: {}, flags: [], current: 0 })).not.toThrow()
  })
})

describe('scoreAnswers (Practice lab, matches the server)', () => {
  it('scores nothing for no answers', () => {
    expect(scoreAnswers([])).toEqual({ score: 0, correct: 0, total: 0, bestStreak: 0 })
  })

  it('gives one point per right answer, and two from the 5th in a row', () => {
    expect(scoreAnswers([true, true, true, true, true])).toEqual({ score: 6, correct: 5, total: 5, bestStreak: 5 })
  })

  it('resets the streak bonus after a miss', () => {
    const results = [true, true, true, true, true, true, false, true]
    expect(scoreAnswers(results)).toEqual({ score: 9, correct: 7, total: 8, bestStreak: 6 })
  })

  it('remembers the best streak, not the last one', () => {
    expect(scoreAnswers([true, true, true, false, true]).bestStreak).toBe(3)
  })
})

describe('Practice lab labels', () => {
  it('names round lengths and scopes', () => {
    expect(lengthLabel(60)).toBe('1 min')
    expect(lengthLabel(300)).toBe('5 min')
    expect(scopeLabel('Biology', 'Cells')).toBe('Biology · Cells')
    expect(scopeLabel('Biology', '')).toBe('Biology · All units')
  })
})

describe('avoidOpeningWith (Play again)', () => {
  const card = (front: string) => ({ id: front, front })
  const [a, b, c] = [card('A'), card('B'), card('C')]

  it('never opens the new round on the card the last round ended on', () => {
    expect(avoidOpeningWith([c, a, b], [c]).map((item) => item.front)).toEqual(['A', 'C', 'B'])
    expect(avoidOpeningWith([c, b, a], [c, b]).map((item) => item.front)).toEqual(['A', 'B', 'C'])
  })

  it('keeps an order that already opens on another card, and a one-card deck', () => {
    expect(avoidOpeningWith([a, b, c], [c])).toEqual([a, b, c])
    expect(avoidOpeningWith([c], [c])).toEqual([c])
    expect(avoidOpeningWith([], [c])).toEqual([])
    expect(avoidOpeningWith([a, b], [undefined])).toEqual([a, b])
  })
})
