import { describe, expect, it } from 'vitest'
import type { NoteScope, ReviewSummary } from './api'
import { DEFAULT_INSTANT_PREFS, INSTANT_PREFS_KEY, instantHint, instantReason, loadInstantPrefs, pickInstantUnit, saveInstantPrefs, sessionMinutes, unitKey, type InstantInput } from './instantStudy'
import type { NoteDeposit, UnitAttempt } from './types'

const scope = (course: string, unit: string, note_count: number, last_added: string | null): NoteScope => ({ course, unit, note_count, last_added })
const review = (by_unit: ReviewSummary['by_unit']): ReviewSummary => ({
  due: by_unit.reduce((sum, item) => sum + item.due, 0),
  new_available: by_unit.reduce((sum, item) => sum + item.new, 0),
  next_due_at: null,
  by_unit,
})
let n = 0
const attempts = (course: string, unit: string, right: number, wrong: number): UnitAttempt[] => [
  ...Array.from({ length: right }, () => ({ id: `a${n++}`, course, unit, correct: true, at: 1 })),
  ...Array.from({ length: wrong }, () => ({ id: `a${n++}`, course, unit, correct: false, at: 1 })),
]

const SCOPES = [
  scope('AP Biology', 'Photosynthesis', 2, '2026-10-10T10:00:00Z'),
  scope('Chemistry', 'Stoichiometry', 1, '2026-10-14T10:00:00Z'),
  scope('US History', 'WWI causes', 3, '2026-10-12T10:00:00Z'),
]
const base = (extra: Partial<InstantInput> = {}): InstantInput => ({ scopes: SCOPES, deposits: [], review: null, attempts: [], ...extra })

describe('pickInstantUnit', () => {
  it('returns null when the student has no notes anywhere', () => {
    expect(pickInstantUnit({ scopes: [], deposits: [], review: null, attempts: [] })).toBeNull()
    expect(pickInstantUnit({ scopes: null, deposits: [], review: review([{ course: 'X', unit: 'Y', due: 4, new: 0 }]), attempts: [] })).toBeNull()
  })

  it('picks the unit with the most due cards first', () => {
    const pick = pickInstantUnit(base({
      review: review([
        { course: 'AP Biology', unit: 'Photosynthesis', due: 2, new: 5 },
        { course: 'US History', unit: 'WWI causes', due: 6, new: 0 },
      ]),
      attempts: attempts('Chemistry', 'Stoichiometry', 0, 5),
    }))
    expect(pick).toMatchObject({ course: 'US History', unit: 'WWI causes', reason: 'due', due: 6 })
  })

  it('ignores due counts for units without notes', () => {
    const pick = pickInstantUnit(base({ review: review([{ course: 'Spanish', unit: 'Verbs', due: 9, new: 0 }]) }))
    expect(pick?.reason).toBe('recent')
  })

  it('falls back to the weakest unit by quiz accuracy', () => {
    const pick = pickInstantUnit(base({
      review: review([{ course: 'AP Biology', unit: 'Photosynthesis', due: 0, new: 4 }]),
      attempts: [...attempts('AP Biology', 'Photosynthesis', 3, 2), ...attempts('US History', 'WWI causes', 1, 3)],
    }))
    expect(pick).toMatchObject({ course: 'US History', unit: 'WWI causes', reason: 'weak', accuracy: 0.25 })
  })

  it('needs a few answers and a low score before calling a unit weak', () => {
    // Two answers is too few to judge; 90% is not weak.
    const pick = pickInstantUnit(base({ attempts: [...attempts('AP Biology', 'Photosynthesis', 0, 2), ...attempts('US History', 'WWI causes', 9, 1)] }))
    expect(pick).toMatchObject({ course: 'Chemistry', unit: 'Stoichiometry', reason: 'recent' })
  })

  it('uses server topic stats when this device has no attempts for the unit', () => {
    const pick = pickInstantUnit(base({ topics: [{ topic: 'Photosynthesis', attempts: 10, correct_answers: 4, accuracy: 40 }] }))
    expect(pick).toMatchObject({ unit: 'Photosynthesis', reason: 'weak', accuracy: 0.4 })
  })

  it('otherwise studies the most recently added notes, counting notes on this device', () => {
    expect(pickInstantUnit(base())).toMatchObject({ course: 'Chemistry', unit: 'Stoichiometry', reason: 'recent' })
    const deposits: NoteDeposit[] = [{ id: 'n1', course: 'Art', unit: 'Color', fileName: 'a.txt', createdAt: '2026-10-15T08:00:00Z' }]
    expect(pickInstantUnit(base({ deposits }))).toMatchObject({ course: 'Art', unit: 'Color', notes: 1 })
  })

  it('moves on to another unit for another round, then comes back when all had a turn', () => {
    const due = review([{ course: 'US History', unit: 'WWI causes', due: 6, new: 0 }])
    const first = pickInstantUnit(base({ review: due }))!
    const second = pickInstantUnit(base({ review: due, exclude: [unitKey(first.course, first.unit)] }))!
    expect(second).toMatchObject({ course: 'Chemistry', reason: 'recent' })
    const everything = SCOPES.map((item) => unitKey(item.course, item.unit))
    expect(pickInstantUnit(base({ review: due, exclude: everything }))).toMatchObject({ unit: 'WWI causes', reason: 'due' })
  })

  it('matches names the way the server trims them', () => {
    const pick = pickInstantUnit(base({ review: review([{ course: 'AP Biology ', unit: ' Photosynthesis', due: 3, new: 0 }]) }))
    expect(pick).toMatchObject({ unit: 'Photosynthesis', due: 3 })
  })
})

describe('hint text', () => {
  it('reads as minutes, course and unit', () => {
    const pick = pickInstantUnit(base({ review: review([{ course: 'AP Biology', unit: 'Photosynthesis', due: 3, new: 5 }]) }))
    expect(instantHint(pick)).toBe('5 min · AP Biology · Photosynthesis')
    expect(instantReason(pick!)).toBe('3 cards due')
    expect(instantHint(null)).toMatch(/Add notes/)
  })

  it('keeps sessions short', () => {
    expect(sessionMinutes({ due: 0, fresh: 0 })).toBe(5)
    expect(sessionMinutes({ due: 40, fresh: 40 })).toBe(5)
  })
})

describe('Instant Study settings', () => {
  const busy = () => base({
    review: review([{ course: 'US History', unit: 'WWI causes', due: 6, new: 0 }]),
    attempts: attempts('AP Biology', 'Photosynthesis', 0, 5),
  })

  it('Smart pick (the default) keeps today’s order: due, then weak, then newest', () => {
    expect(pickInstantUnit(busy())).toMatchObject({ unit: 'WWI causes', reason: 'due' })
    expect(pickInstantUnit({ ...busy(), mode: 'smart' })).toMatchObject({ unit: 'WWI causes', reason: 'due' })
  })

  it('My latest notes always picks the unit with the newest notes, even with cards due or a weak unit', () => {
    expect(pickInstantUnit({ ...busy(), mode: 'latest' })).toMatchObject({ course: 'Chemistry', unit: 'Stoichiometry', reason: 'recent' })
    const deposits: NoteDeposit[] = [{ id: 'n9', course: 'Art', unit: 'Color', fileName: 'a.txt', createdAt: '2026-10-15T08:00:00Z' }]
    expect(pickInstantUnit({ ...busy(), deposits, mode: 'latest' })).toMatchObject({ course: 'Art', unit: 'Color' })
  })

  it('My latest notes works without the review summary and still moves on for another round', () => {
    const latest = { ...base(), review: null, mode: 'latest' as const }
    expect(pickInstantUnit(latest)).toMatchObject({ unit: 'Stoichiometry' })
    expect(pickInstantUnit({ ...latest, exclude: [unitKey('Chemistry', 'Stoichiometry')] })).toMatchObject({ unit: 'WWI causes' })
    expect(pickInstantUnit({ ...latest, scopes: [] })).toBeNull()
  })

  function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, data }
  }

  it('loads the defaults when nothing or something unreadable is saved', () => {
    expect(loadInstantPrefs(memory())).toEqual(DEFAULT_INSTANT_PREFS)
    expect(loadInstantPrefs(memory({ [INSTANT_PREFS_KEY]: '{oops' }))).toEqual(DEFAULT_INSTANT_PREFS)
    expect(loadInstantPrefs(memory({ [INSTANT_PREFS_KEY]: '{"mode":"loud","skipKeyPoints":"yes"}' }))).toEqual(DEFAULT_INSTANT_PREFS)
    expect(loadInstantPrefs(null)).toEqual(DEFAULT_INSTANT_PREFS)
  })

  it('saves and reads back both settings', () => {
    const store = memory()
    saveInstantPrefs({ mode: 'latest', skipKeyPoints: true }, store)
    expect(loadInstantPrefs(store)).toEqual({ mode: 'latest', skipKeyPoints: true })
    saveInstantPrefs({ mode: 'smart', skipKeyPoints: true }, store)
    expect(loadInstantPrefs(store)).toEqual({ mode: 'smart', skipKeyPoints: true })
  })

  it('keeps the choice for this page when storage refuses it', () => {
    const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked') } }
    saveInstantPrefs({ mode: 'latest', skipKeyPoints: false }, blocked)
    expect(loadInstantPrefs(blocked)).toEqual({ mode: 'latest', skipKeyPoints: false })
    // Once a save works again, the stored value is used.
    const store = memory()
    saveInstantPrefs({ mode: 'smart', skipKeyPoints: false }, store)
    expect(loadInstantPrefs(store)).toEqual({ mode: 'smart', skipKeyPoints: false })
  })
})
