import type { CardReview, ReviewGrade, ReviewState } from './api'
import { previewFor as computePreview } from './reviewSchedule'

/*
 * Spaced-repetition helpers shared by the Review mode, Home and the sidebar.
 *
 * The schedule is decided on the server (backend/review.py). reviewSchedule.ts ports its
 * formulas exactly: Review mode uses them for the grade buttons' interval previews, and
 * the landing demo's in-memory sandbox uses them to schedule cards.
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

// --- Scheduler (an exact port of backend/review.py lives in reviewSchedule.ts) -----------

export { nextValues, previewFor, type SchedulerState } from './reviewSchedule'

/* Each grade's next interval, computed here from the card's own schedule (the server's
 * preview is used only if a response predates the scheduler fields). */
export function gradePreview(card: { id: string; review: CardReview }): CardReview['preview'] {
  const { review } = card
  if (review.state === 'new') return computePreview(null, card.id)
  if (typeof review.ease === 'number' && typeof review.reps === 'number') {
    return computePreview({ interval_days: review.interval_days, ease: review.ease, reps: review.reps, lapses: review.lapses ?? 0 }, card.id)
  }
  return review.preview
}

export function stateName(intervalDays: number | null): ReviewState {
  if (intervalDays === null) return 'new'
  return intervalDays < 1 ? 'learning' : 'review'
}
