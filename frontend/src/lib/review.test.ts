import { describe, expect, it } from 'vitest'
import type { CardReview, ReviewGrade } from './api'
import { formatInterval, gradePreview, pendingGrades, relativeDue, spokenInterval, stateName, withFailedGrade, withoutCard } from './review'
import { nextValues, previewFor, type SchedulerState } from './reviewSchedule'

/*
 * Expected values were produced by backend/review.py (next_values / preview), so these
 * tests prove the TypeScript port schedules cards exactly like the server: the same
 * Python-style rounding and the same SHA-256 fuzz for intervals of 3+ days.
 */
const SERVER_CASES: [SchedulerState | null, ReviewGrade, string, SchedulerState][] = [
  [null, 'again', 'card-1', { interval_days: 10 / 1440, ease: 2.3, reps: 0, lapses: 0 }],
  [null, 'hard', 'card-1', { interval_days: 0.5, ease: 2.35, reps: 0, lapses: 0 }],
  [null, 'good', 'card-1', { interval_days: 1, ease: 2.5, reps: 1, lapses: 0 }],
  [null, 'easy', 'card-1', { interval_days: 4, ease: 2.65, reps: 1, lapses: 0 }],
  [{ interval_days: 1, ease: 2.5, reps: 1, lapses: 0 }, 'good', 'abc', { interval_days: 3, ease: 2.5, reps: 2, lapses: 0 }],
  [{ interval_days: 1, ease: 2.5, reps: 1, lapses: 0 }, 'easy', 'abc', { interval_days: 4, ease: 2.65, reps: 2, lapses: 0 }],
  [{ interval_days: 10, ease: 2.5, reps: 3, lapses: 1 }, 'good', '3f1c0e2a-9b7d-4c1e-8a55-0d2b6f9e7a10', { interval_days: 25, ease: 2.5, reps: 4, lapses: 1 }],
  [{ interval_days: 10, ease: 2.5, reps: 3, lapses: 1 }, 'hard', '3f1c0e2a-9b7d-4c1e-8a55-0d2b6f9e7a10', { interval_days: 12, ease: 2.35, reps: 4, lapses: 1 }],
  [{ interval_days: 10, ease: 2.5, reps: 3, lapses: 1 }, 'again', 'x', { interval_days: 10 / 1440, ease: 2.3, reps: 0, lapses: 2 }],
  [{ interval_days: 300, ease: 2.8, reps: 9, lapses: 0 }, 'easy', 'long', { interval_days: 365, ease: 2.95, reps: 10, lapses: 0 }],
  [{ interval_days: 5, ease: 1.4, reps: 4, lapses: 2 }, 'hard', 'floor', { interval_days: 6, ease: 1.3, reps: 5, lapses: 2 }],
  [{ interval_days: 0.5, ease: 2.5, reps: 0, lapses: 0 }, 'again', 'learn', { interval_days: 10 / 1440, ease: 2.3, reps: 0, lapses: 0 }],
  [{ interval_days: 2, ease: 1.35, reps: 2, lapses: 0 }, 'again', 'min', { interval_days: 10 / 1440, ease: 1.3, reps: 0, lapses: 1 }],
  [{ interval_days: 7, ease: 2.35, reps: 2, lapses: 0 }, 'good', 'émoji-ü-✓', { interval_days: 17, ease: 2.35, reps: 3, lapses: 0 }],
]

describe('nextValues matches backend/review.py', () => {
  it.each(SERVER_CASES)('state %j graded %s (card %s)', (state, grade, cardId, expected) => {
    expect(nextValues(state, grade, cardId)).toEqual(expected)
  })

  it('matches the server preview for every grade', () => {
    expect(previewFor({ interval_days: 4, ease: 2.2, reps: 2, lapses: 0 }, 'prev')).toEqual({ again: 10 / 1440, hard: 5, good: 9, easy: 12 })
  })
})

describe('nextValues rules', () => {
  it('only counts a lapse when a graduated card (1+ day) is forgotten', () => {
    expect(nextValues({ interval_days: 0.5, ease: 2.5, reps: 0, lapses: 3 }, 'again', 'c').lapses).toBe(3)
    expect(nextValues({ interval_days: 1, ease: 2.5, reps: 2, lapses: 3 }, 'again', 'c').lapses).toBe(4)
  })

  it('never lets ease fall below 1.3', () => {
    let state: SchedulerState | null = null
    for (let i = 0; i < 20; i++) state = nextValues(state, 'again', 'c')
    expect(state?.ease).toBe(1.3)
  })

  it('caps intervals at a year', () => {
    expect(nextValues({ interval_days: 365, ease: 3, reps: 20, lapses: 0 }, 'easy', 'c').interval_days).toBe(365)
  })

  it('orders grades: again < hard < good < easy', () => {
    for (const state of [null, { interval_days: 1, ease: 2.5, reps: 1, lapses: 0 }, { interval_days: 20, ease: 2.1, reps: 5, lapses: 1 }]) {
      const preview = previewFor(state, 'order')
      expect(preview.again).toBeLessThan(preview.hard)
      expect(preview.hard).toBeLessThan(preview.good)
      expect(preview.good).toBeLessThan(preview.easy)
    }
  })

  it('keeps fuzz within ±5% and the same for the same card', () => {
    const state = { interval_days: 40, ease: 2.5, reps: 6, lapses: 0 }
    const a = nextValues(state, 'good', 'card-a').interval_days
    expect(nextValues(state, 'good', 'card-a').interval_days).toBe(a)
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const days = nextValues(state, 'good', id).interval_days
      expect(days).toBeGreaterThanOrEqual(Math.round(100 * 0.95))
      expect(days).toBeLessThanOrEqual(Math.round(100 * 1.05))
    }
  })
})

describe('formatInterval and spokenInterval', () => {
  it.each([
    [10 / 1440, '10m', '10 minutes'],
    [0, '1m', '1 minute'],
    [0.5, '12h', '12 hours'],
    [1, '1d', '1 day'],
    [20, '20d', '20 days'],
    [21, '3w', '3 weeks'],
    [59, '8w', '8 weeks'],
    [60, '2mo', '2 months'],
    [364, '12mo', '12 months'],
    [365, '1y', '1 year'],
    [548, '1.5y', '1.5 years'],
  ])('%f days → %s / %s', (days, short, spoken) => {
    expect(formatInterval(days)).toBe(short)
    expect(spokenInterval(days)).toBe(spoken)
  })
})

describe('relativeDue', () => {
  const now = new Date(2026, 9, 14, 10, 0, 0).getTime()
  const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString()

  it('is empty without a due date and "now" when due or unparseable', () => {
    expect(relativeDue(null, now)).toBe('')
    expect(relativeDue(at(2026, 9, 14, 9, 0), now)).toBe('now')
    expect(relativeDue(new Date(now).toISOString(), now)).toBe('now')
    expect(relativeDue('not a date', now)).toBe('now')
  })

  it('counts minutes within the hour', () => {
    expect(relativeDue(at(2026, 9, 14, 10, 8), now)).toBe('in 8 minutes')
    expect(relativeDue(at(2026, 9, 14, 10, 1), now)).toBe('in 1 minute')
  })

  it('says "in 1 minute" (singular) when less than half a minute is left', () => {
    expect(relativeDue(new Date(now + 20_000).toISOString(), now)).toBe('in 1 minute')
  })

  it('counts hours later today', () => {
    expect(relativeDue(at(2026, 9, 14, 11, 0), now)).toBe('in 1 hour')
    expect(relativeDue(at(2026, 9, 14, 13, 0), now)).toBe('in 3 hours')
  })

  it('uses calendar days from then on', () => {
    expect(relativeDue(at(2026, 9, 15, 0, 0), now)).toBe('tomorrow')
    expect(relativeDue(at(2026, 9, 18, 0, 0), now)).toBe('in 4 days')
  })
})

describe('gradePreview and stateName', () => {
  const base: CardReview = { state: 'review', due_at: null, interval_days: 4, preview: { again: 1, hard: 2, good: 3, easy: 4 } }

  it('computes a new card the way the server does', () => {
    expect(gradePreview({ id: 'card-1', review: { ...base, state: 'new' } })).toEqual(previewFor(null, 'card-1'))
  })

  it('computes from the scheduler fields when present', () => {
    const review = { ...base, ease: 2.2, reps: 2 }
    expect(gradePreview({ id: 'prev', review })).toEqual({ again: 10 / 1440, hard: 5, good: 9, easy: 12 })
  })

  it('falls back to the server preview for older responses', () => {
    expect(gradePreview({ id: 'c', review: base })).toBe(base.preview)
  })

  it('names the state from the interval', () => {
    expect(stateName(null)).toBe('new')
    expect(stateName(0.5)).toBe('learning')
    expect(stateName(1)).toBe('review')
  })
})

describe('pendingGrades (Review more waits for grades still saving)', () => {
  it('settles only after every tracked grade has finished, saved or not', async () => {
    const grades = pendingGrades()
    let save!: () => void
    let fail!: (error: Error) => void
    void grades.track(new Promise<void>((resolve) => { save = resolve }))
    grades.track(new Promise<void>((_, reject) => { fail = reject })).catch(() => {})
    let settled = false
    const waiting = grades.settled().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    save()
    await Promise.resolve()
    expect(settled).toBe(false)
    fail(new Error('offline'))
    await waiting
    expect(settled).toBe(true)
    expect(grades.size).toBe(0)
  })
})

describe('failed grades (kept for Retry, never re-queued)', () => {
  it('keeps one grade per card, the newest', () => {
    const card = { id: 'a' }
    let failed = withFailedGrade([], card, 'again')
    failed = withFailedGrade(failed, { id: 'b' }, 'good')
    failed = withFailedGrade(failed, card, 'easy')
    expect(failed.map((item) => [item.card.id, item.grade])).toEqual([['b', 'good'], ['a', 'easy']])
    expect(withoutCard(failed, 'a').map((item) => item.card.id)).toEqual(['b'])
  })
})
