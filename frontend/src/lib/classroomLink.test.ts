import { describe, expect, it } from 'vitest'
import { CLASSROOM_UNIT, checkClassroomLink, notebookWithClassroomCourse } from './classroomLink'
import { COURSE_TONES } from './session'
import type { Notebook } from './types'

const URL = 'https://calendar.google.com/calendar/ical/c_abc123%40classroom.google.com/private-0123456789abcdef0123456789abcdef/basic.ics'

describe('checkClassroomLink', () => {
  it('accepts the secret iCal address, with stray spaces', () => {
    expect(checkClassroomLink(URL)).toBe('ok')
    expect(checkClassroomLink(`  ${URL}\n`)).toBe('ok')
  })

  it('is quiet while empty', () => {
    expect(checkClassroomLink('   ')).toBe('empty')
  })

  it('points at the secret address when the public one is pasted', () => {
    expect(checkClassroomLink(URL.replace(/private-[0-9a-f]+/, 'public'))).toBe('public')
  })

  it('rejects other Google Calendar links and other hosts', () => {
    for (const value of [
      URL.replace('https://', 'http://'),
      URL + '?x=1',
      URL.replace('/basic.ics', '/basic.ics/../x'),
      URL.replace('c_abc123%40classroom.google.com', 'c%2F..'),
      'https://calendar.google.com/calendar/u/0/r/settings',
      URL.replace('calendar.google.com', 'calendar.google.com:8443'),
    ]) expect(checkClassroomLink(value), value).toBe(value.startsWith('https://calendar.google.com/') ? 'not_ical' : 'not_google')
    for (const value of [
      URL.replace('calendar.google.com', 'evil.com'),
      URL.replace('calendar.google.com', '127.0.0.1'),
      'webcal://calendar.google.com/calendar/ical/x/private-0123456789abcdef/basic.ics',
      'javascript:alert(1)',
    ]) expect(checkClassroomLink(value), value).toBe('not_google')
  })
})

describe('notebookWithClassroomCourse', () => {
  const notebook: Notebook = {
    courses: [{ name: 'Biology', units: ['Unit 1'], tone: COURSE_TONES[0] }],
    activeCourse: 'Biology',
    activeUnit: 'Unit 1',
    deposits: [],
  }

  it('adds a missing course with the next color and keeps what is open', () => {
    const next = notebookWithClassroomCourse(notebook, 'Chemistry', true)
    expect(next.courses[1]).toEqual({ name: 'Chemistry', units: [CLASSROOM_UNIT], tone: COURSE_TONES[1] })
    expect([next.activeCourse, next.activeUnit]).toEqual(['Biology', 'Unit 1'])
  })

  it('adds the Classroom unit to an existing course once', () => {
    const next = notebookWithClassroomCourse(notebook, ' Biology ', true)
    expect(next.courses[0].units).toEqual(['Unit 1', CLASSROOM_UNIT])
    expect(notebookWithClassroomCourse(next, 'Biology', true)).toBe(next)
    expect(notebookWithClassroomCourse(notebook, 'Biology', false)).toBe(notebook)
  })

  it('opens the first course of an empty notebook', () => {
    const next = notebookWithClassroomCourse({ courses: [], activeCourse: '', activeUnit: '', deposits: [] }, 'Art', false)
    expect([next.activeCourse, next.activeUnit]).toEqual(['Art', 'Unit 1'])
  })
})
