import type { CardReview, ReviewGrade, ReviewState } from './api'

/*
 * Spaced-repetition helpers shared by the Review mode, Home and the sidebar.
 *
 * The app's schedule is computed on the server (backend/review.py), which sends each
 * card's next interval per grade. nextValues() mirrors that scheduler for the landing
 * demo's in-memory sandbox only; its fuzz uses a small string hash instead of SHA-256,
 * so demo intervals of three days or more can differ from the server's by a day.
 */

export const GRADES: ReviewGrade[] = ['again', 'hard', 'good', 'easy']
export const GRADE_LABELS: Record<ReviewGrade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' }

/* Fired on window after a grade, so due counts elsewhere (Home, sidebar, Study header) refresh. */
export const REVIEW_CHANGED_EVENT = 'bindit:review-changed'

export function announceReviewChange() {
  window.dispatchEvent(new Event(REVIEW_CHANGED_EVENT))
}

/* "10m", "12h", "1d", "3w", "4mo", "1y": compact, for the grade buttons. */
export function formatInterval(days: number) {
  const minutes = Math.round(days * 1440)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  if (days < 1) return `${Math.round(minutes / 60)}h`
  const whole = Math.round(days)
  if (whole < 21) return `${whole}d`
  if (whole < 60) return `${Math.round(whole / 7)}w`
  if (whole < 365) return `${Math.round(whole / 30)}mo`
  return `${Math.round((whole / 365) * 10) / 10}y`
}

/* The same interval in words, for screen readers: "10 minutes", "3 days". */
export function spokenInterval(days: number) {
  const short = formatInterval(days)
  const value = Number.parseFloat(short)
  const unit = short.replace(/^[\d.]+/, '')
  const names: Record<string, string> = { m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' }
  return `${value} ${names[unit] ?? unit}${value === 1 ? '' : 's'}`
}

/* "in 8 minutes", "in 3 hours", "tomorrow", "in 4 days", "now" — for "next review …". */
export function relativeDue(dueAt: string | null, now: number) {
  if (!dueAt) return ''
  const diff = Date.parse(dueAt) - now
  if (Number.isNaN(diff) || diff <= 0) return 'now'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  const due = new Date(Date.parse(dueAt))
  const today = new Date(now)
  const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()
    - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

// --- Scheduler mirror (landing demo only) ---------------------------------------------

export type SchedulerState = { interval_days: number; ease: number; reps: number; lapses: number }

const DEFAULT_EASE = 2.5
const MIN_EASE = 1.3
const MAX_INTERVAL = 365
const RELEARN_DAYS = 10 / 1440

function fuzz(cardId: string, reps: number) {
  let hash = 2166136261
  for (const char of `${cardId}:${reps}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return 1 + ((hash / 0xffffffff) * 2 - 1) * 0.05
}

export function nextValues(state: SchedulerState | null, grade: ReviewGrade, cardId: string): SchedulerState {
  const interval = state?.interval_days ?? 0
  const ease = state?.ease ?? DEFAULT_EASE
  const reps = state?.reps ?? 0
  const lapses = state?.lapses ?? 0
  if (grade === 'again') {
    return { interval_days: RELEARN_DAYS, ease: Math.max(MIN_EASE, ease - 0.2), reps: 0, lapses: lapses + (interval >= 1 ? 1 : 0) }
  }
  let hard = 0.5
  let good = 1
  let easy = 4
  if (reps > 0) {
    hard = Math.max(interval * 1.2, interval + 1)
    good = Math.max(reps === 1 ? 3 : interval * ease, hard + 1)
    easy = Math.max(interval * ease * 1.3, good + 1)
  }
  let chosen = { hard, good, easy }[grade]
  if (chosen >= 1) {
    if (chosen >= 3) chosen *= fuzz(cardId, reps)
    chosen = Math.min(MAX_INTERVAL, Math.max(1, Math.round(chosen)))
  }
  const nextEase = { hard: ease - 0.15, good: ease, easy: ease + 0.15 }[grade]
  return { interval_days: chosen, ease: Math.max(MIN_EASE, nextEase), reps: grade === 'hard' && reps === 0 ? reps : reps + 1, lapses }
}

export function stateName(intervalDays: number | null): ReviewState {
  if (intervalDays === null) return 'new'
  return intervalDays < 1 ? 'learning' : 'review'
}

export function previewFor(state: SchedulerState | null, cardId: string): CardReview['preview'] {
  return {
    again: nextValues(state, 'again', cardId).interval_days,
    hard: nextValues(state, 'hard', cardId).interval_days,
    good: nextValues(state, 'good', cardId).interval_days,
    easy: nextValues(state, 'easy', cardId).interval_days,
  }
}
