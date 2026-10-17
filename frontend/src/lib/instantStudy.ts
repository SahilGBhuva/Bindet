import type { NoteScope, ReviewSummary, TopicStat } from './api'
import type { NoteDeposit, UnitAttempt } from './types'

/*
 * Instant Study: which unit one tap on Home studies. No AI, no network: it reads what Home
 * already has (saved notes per unit, the review summary, quiz attempts) and picks, in order,
 *  1. the unit with the most flashcards due now;
 *  2. otherwise the weakest unit by quiz accuracy (with enough answers to judge);
 *  3. otherwise the unit whose notes were added most recently.
 * Units studied earlier in this sitting are skipped so "Another round" moves on; when every
 * unit has had its turn, the same order picks again (more cards from the same unit).
 */

export type InstantReason = 'due' | 'weak' | 'recent'

export type InstantPick = {
  course: string
  unit: string
  reason: InstantReason
  due: number
  /* New (never studied) cards waiting in the unit. */
  fresh: number
  /* Share of quiz answers right in this unit (0 to 1), or null with too few answers. */
  accuracy: number | null
  notes: number
}

export type InstantInput = {
  scopes: NoteScope[] | null
  deposits: NoteDeposit[]
  review: ReviewSummary | null
  attempts: UnitAttempt[]
  topics?: TopicStat[]
  /* unitKey()s already studied in this sitting. */
  exclude?: string[]
}

/* Answers needed before a unit's accuracy counts, and the accuracy below which it is "weak". */
export const WEAK_MIN_ANSWERS = 3
export const WEAK_BELOW = 0.85

export const SESSION_CARDS = 8
export const SESSION_QUESTIONS = 3

const same = (a: string, b: string) => a.trim() === b.trim()

/* Server times are UTC; some drivers drop the zone (like api.parseServerTime, without importing the API). */
function serverTime(value: string) {
  const zoned = /(?:z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}Z`
  return Date.parse(zoned) || 0
}

export function unitKey(course: string, unit: string) {
  return `${course.trim()}\u0000${unit.trim()}`
}

type Candidate = InstantPick & { added: number }

function candidates(input: InstantInput): Candidate[] {
  const byKey = new Map<string, Candidate>()
  const add = (course: string, unit: string, notes: number, added: number) => {
    if (!course.trim() || !unit.trim() || notes <= 0) return
    const key = unitKey(course, unit)
    const current = byKey.get(key)
    if (current) {
      current.notes = Math.max(current.notes, notes)
      current.added = Math.max(current.added, added)
      return
    }
    byKey.set(key, { course, unit, reason: 'recent', due: 0, fresh: 0, accuracy: null, notes, added })
  }
  for (const scope of input.scopes ?? []) add(scope.course, scope.unit, scope.note_count, scope.last_added ? serverTime(scope.last_added) : 0)
  // This device's own notes count too (a note just added may not be in the scopes yet).
  const local = new Map<string, { course: string; unit: string; count: number; added: number }>()
  for (const note of input.deposits) {
    const key = unitKey(note.course, note.unit)
    const entry = local.get(key) ?? { course: note.course, unit: note.unit, count: 0, added: 0 }
    entry.count += 1
    entry.added = Math.max(entry.added, Date.parse(note.createdAt) || 0)
    local.set(key, entry)
  }
  for (const entry of local.values()) add(entry.course, entry.unit, entry.count, entry.added)

  for (const item of byKey.values()) {
    const counts = input.review?.by_unit.find((entry) => same(entry.course, item.course) && same(entry.unit, item.unit))
    item.due = counts?.due ?? 0
    item.fresh = counts?.new ?? 0
    const mine = input.attempts.filter((attempt) => same(attempt.course, item.course) && same(attempt.unit, item.unit))
    const topic = input.topics?.find((entry) => same(entry.topic, item.unit))
    const answers = mine.length || topic?.attempts || 0
    const right = mine.length ? mine.filter((attempt) => attempt.correct).length : topic?.correct_answers ?? 0
    item.accuracy = answers >= WEAK_MIN_ANSWERS ? right / answers : null
  }
  return [...byKey.values()]
}

export function pickInstantUnit(input: InstantInput): InstantPick | null {
  const all = candidates(input)
  if (!all.length) return null
  const skipped = new Set(input.exclude ?? [])
  const open = all.filter((item) => !skipped.has(unitKey(item.course, item.unit)))
  const pool = open.length ? open : all
  const newest = (a: Candidate, b: Candidate) => b.added - a.added || a.course.localeCompare(b.course) || a.unit.localeCompare(b.unit)

  const due = pool.filter((item) => item.due > 0).toSorted((a, b) => b.due - a.due || newest(a, b))[0]
  if (due) return finish(due, 'due')
  const weak = pool
    .filter((item) => item.accuracy !== null && item.accuracy < WEAK_BELOW)
    .toSorted((a, b) => (a.accuracy ?? 1) - (b.accuracy ?? 1) || newest(a, b))[0]
  if (weak) return finish(weak, 'weak')
  return finish(pool.toSorted(newest)[0], 'recent')
}

function finish(item: Candidate, reason: InstantReason): InstantPick {
  const { added: _added, ...pick } = item
  return { ...pick, reason }
}

/* About how long a session takes: key points, the cards, three questions. */
export function sessionMinutes(pick: Pick<InstantPick, 'due' | 'fresh'>) {
  const cards = Math.min(SESSION_CARDS, Math.max(6, pick.due + pick.fresh))
  return Math.max(3, Math.round(1 + cards * 0.3 + SESSION_QUESTIONS * 0.6))
}

/* "5 min · AP Biology · Photosynthesis" */
export function instantHint(pick: InstantPick | null) {
  if (!pick) return 'Add notes and get a 5-minute session from them'
  return `${sessionMinutes(pick)} min · ${pick.course} · ${pick.unit}`
}

/* Why this unit, in a few words (shown beside the hint and in the session header). */
export function instantReason(pick: InstantPick) {
  if (pick.reason === 'due') return `${pick.due} ${pick.due === 1 ? 'card' : 'cards'} due`
  if (pick.reason === 'weak') return `${Math.round((pick.accuracy ?? 0) * 100)}% on quizzes`
  return 'Your newest notes'
}
