import { pickCourseTone, sameName } from './session'
import type { Notebook } from './types'

/* Pure helpers for the Google Classroom import (no network, no DOM), tested in classroomLink.test.ts. */

/* Unit that holds the "<assignment> — instructions" notes. */
export const CLASSROOM_UNIT = 'Classroom'

// Same shape the server accepts (backend/classroom.py URL_PATTERN).
const CALENDAR_URL = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([A-Za-z0-9._%+-]{1,200})\/private-[0-9a-f]{16,64}\/basic\.ics$/

export type LinkCheck = 'empty' | 'ok' | 'public' | 'not_ical' | 'not_google'

/* What is wrong with a pasted link, if anything. */
export function checkClassroomLink(value: string): LinkCheck {
  const text = value.trim()
  if (!text) return 'empty'
  const match = CALENDAR_URL.exec(text)
  if (match) {
    const id = match[1]
    if (/%(?![0-9A-Fa-f]{2})/.test(id) || /%(2f|5c|2e)/i.test(id) || id === '.' || id === '..') return 'not_ical'
    return 'ok'
  }
  if (/^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/]+\/public\/basic\.ics$/.test(text)) return 'public'
  if (/^https:\/\/calendar\.google\.com\//.test(text)) return 'not_ical'
  return 'not_google'
}

export const LINK_HINTS: Record<Exclude<LinkCheck, 'empty' | 'ok'>, string> = {
  public: 'That’s the public address. Copy the “Secret address in iCal format” instead.',
  not_ical: 'That isn’t a Google Calendar iCal link. Copy the “Secret address in iCal format”.',
  not_google: 'That isn’t a Google Calendar iCal link. It starts with https://calendar.google.com/calendar/ical/',
}

/*
 * The notebook with the course added if missing (next free color), keeping what is open.
 * With withUnit, the course also gets the "Classroom" unit where instruction notes go.
 */
export function notebookWithClassroomCourse(current: Notebook, name: string, withUnit: boolean): Notebook {
  const index = current.courses.findIndex((course) => sameName(course.name, name))
  if (index === -1) {
    const units = withUnit ? [CLASSROOM_UNIT] : ['Unit 1']
    const courses = [...current.courses, { name: name.trim(), units, tone: pickCourseTone(current.courses) }]
    return current.courses.length ? { ...current, courses } : { ...current, courses, activeCourse: name.trim(), activeUnit: units[0] }
  }
  if (!withUnit || current.courses[index].units.some((unit) => sameName(unit, CLASSROOM_UNIT))) return current
  const courses = current.courses.map((course, at) => (at === index ? { ...course, units: [...course.units, CLASSROOM_UNIT] } : course))
  return { ...current, courses }
}
