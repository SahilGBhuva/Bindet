import { addDays, isoDay, parseDay } from './time'

/*
 * One-line quick add: "Bio lab report due Friday" → title, due date and course, read
 * entirely on this device with plain patterns (no AI). Days are "YYYY-MM-DD" strings on
 * the device's clock, weeks start on Sunday, and every date is relative to `today`.
 *
 * Dates understood (an optional "due", "by" or "on" in front is dropped with them):
 *   today, tonight · tomorrow, tmrw, tmr
 *   weekday names (monday, mon, tues, wed, thurs, fri, saturday, sunday): the next one after today
 *   next monday: that day in next week (the week after this Sunday-to-Saturday week)
 *   next week: Monday of next week
 *   in 3 days, in a week, in 2 weeks
 *   oct 24, october 24th, 24 oct, oct 24 2027: this year, or next year once it has passed
 *   10/24, 10/24/26, 10/24/2026 (month first)
 * "sat" and "sun" alone are not weekdays ("SAT practice test"), and a month name needs a day.
 * When several dates appear, the last one wins (deadlines usually come last).
 *
 * Courses: a word matching a course's name, the first 3+ letters of its first word ("bio",
 * "chem"), or the initials of a multi-word name ("cs" for Computer Science), when only one
 * course matches. Such words stay in the title ("Bio lab report"). "#bio" or "#b" also picks a
 * course, by name start or initial, and is removed from the title.
 */

export type QuickAddMatch = { start: number; end: number; text: string }
export type QuickAddResult = {
  title: string
  due_date: string | null
  course: string | null
  date: QuickAddMatch | null
  courseMatch: QuickAddMatch | null
}
export type QuickAddOptions = { today: string; courses: string[]; ignoreDate?: boolean; ignoreCourse?: boolean }

const WEEKDAY_PATTERN = 'sunday|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday'
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6,
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_PATTERN = 'january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec'
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const LEAD = String.raw`(?:\b(?:due|by|on)\s+)?`

function monthIndex(name: string) {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase())
}

/* A real calendar day, or null ("Feb 30"). */
function makeDay(year: number, month: number, day: number) {
  const date = new Date(year, month, day)
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? isoDay(date) : null
}

/* This year's date, or next year's once this year's has passed. */
function upcoming(today: string, month: number, day: number, year?: number) {
  if (year !== undefined) return makeDay(year < 100 ? 2000 + year : year, month, day)
  const thisYear = parseDay(today).getFullYear()
  const date = makeDay(thisYear, month, day)
  if (!date) return makeDay(thisYear + 1, month, day)
  return date < today ? makeDay(thisYear + 1, month, day) : date
}

/* The next given weekday strictly after today. */
function nextWeekday(today: string, weekday: number) {
  const diff = (weekday - parseDay(today).getDay() + 7) % 7
  return addDays(today, diff === 0 ? 7 : diff)
}

/* That weekday in the week after this one (weeks run Sunday to Saturday). */
function weekdayNextWeek(today: string, weekday: number) {
  const nextSunday = addDays(today, 7 - parseDay(today).getDay())
  return addDays(nextSunday, weekday)
}

type Rule = { pattern: RegExp; read: (match: RegExpExecArray, today: string) => string | null }
const RULES: Rule[] = [
  { pattern: new RegExp(String.raw`${LEAD}\b(today|tonight)\b`, 'gi'), read: (_, today) => today },
  { pattern: new RegExp(String.raw`${LEAD}\b(tomorrow|tmrw|tmr)\b`, 'gi'), read: (_, today) => addDays(today, 1) },
  { pattern: new RegExp(String.raw`${LEAD}\bnext\s+week\b`, 'gi'), read: (_, today) => weekdayNextWeek(today, 1) },
  {
    pattern: new RegExp(String.raw`${LEAD}\b(next\s+)?(${WEEKDAY_PATTERN})\b\.?`, 'gi'),
    read: (match, today) => {
      const weekday = WEEKDAY_INDEX[match[2].toLowerCase()]
      return match[1] ? weekdayNextWeek(today, weekday) : nextWeekday(today, weekday)
    },
  },
  {
    pattern: new RegExp(String.raw`${LEAD}\bin\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?)\b`, 'gi'),
    read: (match, today) => {
      const count = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1].toLowerCase()]
      return addDays(today, count * (match[2].toLowerCase().startsWith('week') ? 7 : 1))
    },
  },
  {
    pattern: new RegExp(String.raw`${LEAD}\b(${MONTH_PATTERN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, 'gi'),
    read: (match, today) => upcoming(today, monthIndex(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined),
  },
  {
    pattern: new RegExp(String.raw`${LEAD}\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})\b\.?(?:\s+(\d{4})\b)?`, 'gi'),
    read: (match, today) => upcoming(today, monthIndex(match[2]), Number(match[1]), match[3] ? Number(match[3]) : undefined),
  },
  {
    pattern: new RegExp(String.raw`${LEAD}(?<![\d/])\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b(?![\d/])`, 'gi'),
    read: (match, today) => upcoming(today, Number(match[1]) - 1, Number(match[2]), match[3] ? Number(match[3]) : undefined),
  },
]

function findDate(text: string, today: string) {
  let best: (QuickAddMatch & { day: string }) | null = null
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (let match = rule.pattern.exec(text); match; match = rule.pattern.exec(text)) {
      const day = rule.read(match, today)
      if (!day) continue
      const candidate = { start: match.index, end: match.index + match[0].length, text: match[0].trim(), day }
      // The last date in the text wins; at the same spot, the longer reading ("Oct 24 2027" over "Oct 24").
      if ((!best || candidate.start > best.start || (candidate.start === best.start && candidate.end > best.end))) best = candidate
    }
  }
  return best
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((word) => word[0]).join('').toLowerCase()
}

/* The one course a word points to, or null when none or several do. */
function courseForWord(word: string, courses: string[], tagged: boolean) {
  const lower = word.toLowerCase()
  const exact = courses.filter((course) => course.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  const matches = courses.filter((course) => {
    const name = course.toLowerCase()
    const first = name.split(/\s+/)[0]
    if (tagged) return name.startsWith(lower) || initials(course) === lower
    return (lower.length >= 3 && first.startsWith(lower)) || (course.trim().includes(' ') && lower.length >= 2 && initials(course) === lower)
  })
  return matches.length === 1 ? matches[0] : null
}

function findCourse(text: string, courses: string[], skip: QuickAddMatch | null) {
  if (!courses.length) return null
  // "#bio" first: it is an explicit choice.
  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{N}]+)/gu)) {
    const course = courseForWord(match[2], courses, true)
    const start = (match.index ?? 0) + match[1].length
    if (course) return { course, match: { start, end: start + match[2].length + 1, text: `#${match[2]}` }, remove: true }
  }
  // Multi-word course names ("AP Biology") as a phrase, then single words.
  const lower = text.toLowerCase()
  for (const course of courses.toSorted((a, b) => b.length - a.length)) {
    if (!course.includes(' ')) continue
    const at = lower.search(new RegExp(String.raw`\b${course.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`))
    if (at >= 0) return { course, match: { start: at, end: at + course.length, text: text.slice(at, at + course.length) }, remove: false }
  }
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0
    if (skip && start >= skip.start && start < skip.end) continue
    const course = courseForWord(match[0], courses, false)
    if (course) return { course, match: { start, end: start + match[0].length, text: match[0] }, remove: false }
  }
  return null
}

/* Joins what's left after a phrase is cut out: single spaces, no dangling "due", commas or dashes. */
function tidy(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?:[\s,;:–—-]+|\s+(?:due|by|on))+$/i, '')
    .replace(/^[\s,;:–—-]+/, '')
    .trim()
}

export function parseQuickAdd(text: string, { today, courses, ignoreDate = false, ignoreCourse = false }: QuickAddOptions): QuickAddResult {
  const found = ignoreDate ? null : findDate(text, today)
  const date = found ? { start: found.start, end: found.end, text: found.text } : null
  const course = ignoreCourse ? null : findCourse(text, courses, date)
  const cuts = [date, course?.remove ? course.match : null].filter((item): item is QuickAddMatch => !!item).sort((a, b) => b.start - a.start)
  let title = text
  for (const cut of cuts) title = title.slice(0, cut.start) + ' ' + title.slice(cut.end)
  title = tidy(title)
  return {
    // A line that is only a date ("tomorrow") keeps its words as the title rather than saving nothing.
    title: title || tidy(text),
    due_date: found?.day ?? null,
    course: course?.course ?? null,
    date,
    courseMatch: course?.match ?? null,
  }
}
