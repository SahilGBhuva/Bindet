import { addDays, isoDay, parseDay } from './time'

/*
 * Date math for the Tasks calendar. Every day is a "YYYY-MM-DD" string on this device's
 * clock (see lib/time.ts), and weeks start on Sunday.
 */

/* The first day of the month that `day` falls in. */
export function monthStart(day: string) {
  return `${day.slice(0, 7)}-01`
}

/* The Sunday on or before `day`. */
export function weekStart(day: string) {
  return addDays(day, -parseDay(day).getDay())
}

/* The seven days (Sunday to Saturday) of the week that holds `day`. */
export function weekDays(day: string) {
  const start = weekStart(day)
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

/*
 * The weeks a month view shows: whole Sunday-to-Saturday rows, from the week holding the
 * 1st to the week holding the last day. Four to six rows, never a trailing empty week.
 */
export function monthGrid(day: string): string[][] {
  const first = monthStart(day)
  const date = parseDay(first)
  const last = isoDay(new Date(date.getFullYear(), date.getMonth() + 1, 0))
  const weeks: string[][] = []
  for (let start = weekStart(first); start <= last; start = addDays(start, 7)) weeks.push(weekDays(start))
  return weeks
}

/* The same day of the month `months` away, clamped to that month's length (Jan 31 + 1 → Feb 28). */
export function addMonths(day: string, months: number) {
  const date = parseDay(day)
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const length = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(date.getDate(), length))
  return isoDay(target)
}

export function sameMonth(a: string, b: string) {
  return a.slice(0, 7) === b.slice(0, 7)
}

export function isWeekend(day: string) {
  const weekday = parseDay(day).getDay()
  return weekday === 0 || weekday === 6
}

/* Where an arrow, Home/End or PageUp/PageDown key moves the focused day, or null for other keys. */
export function moveDay(day: string, key: string): string | null {
  switch (key) {
    case 'ArrowLeft': return addDays(day, -1)
    case 'ArrowRight': return addDays(day, 1)
    case 'ArrowUp': return addDays(day, -7)
    case 'ArrowDown': return addDays(day, 7)
    case 'Home': return weekStart(day)
    case 'End': return addDays(weekStart(day), 6)
    case 'PageUp': return addMonths(day, -1)
    case 'PageDown': return addMonths(day, 1)
    default: return null
  }
}

/* Items with a due day, grouped by that day (order within a day is kept). Undated items are left out. */
export function groupByDay<T extends { due_date: string | null }>(items: T[]) {
  const byDay = new Map<string, T[]>()
  for (const item of items) {
    if (!item.due_date) continue
    const list = byDay.get(item.due_date)
    if (list) list.push(item)
    else byDay.set(item.due_date, [item])
  }
  return byDay
}

/* Whole days from `from` to `to` (negative when `to` is earlier). Safe across daylight-saving changes. */
export function daysBetween(from: string, to: string) {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000)
}

/* "today", "tomorrow", "in 3 days", "yesterday", "2 days ago". */
export function dueCountdown(due: string, today: string) {
  const days = daysBetween(today, due)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return days > 0 ? `in ${days} days` : `${-days} days ago`
}
