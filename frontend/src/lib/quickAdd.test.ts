import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './quickAdd'

// Friday, October 16, 2026.
const today = '2026-10-16'
const courses = ['Biology', 'Chemistry', 'Calculus', 'Spanish', 'US History', 'Computer Science']
const parse = (text: string, extra: Partial<Parameters<typeof parseQuickAdd>[1]> = {}) => parseQuickAdd(text, { today, courses, ...extra })

describe('quick add dates', () => {
  it('reads today and tomorrow', () => {
    expect(parse('Read ch. 4 today')).toMatchObject({ title: 'Read ch. 4', due_date: '2026-10-16' })
    expect(parse('Finish essay tonight').due_date).toBe('2026-10-16')
    expect(parse('Lab write-up due tomorrow')).toMatchObject({ title: 'Lab write-up', due_date: '2026-10-17' })
    expect(parse('flashcards tmrw').due_date).toBe('2026-10-17')
  })

  it('reads weekday names as the next one after today', () => {
    expect(parse('Quiz monday').due_date).toBe('2026-10-19')
    expect(parse('Quiz Wed').due_date).toBe('2026-10-21')
    expect(parse('Quiz thurs').due_date).toBe('2026-10-22')
    // Today is Friday: "Friday" means next week's.
    expect(parse('Bio lab report due Friday')).toMatchObject({ title: 'Bio lab report', due_date: '2026-10-23' })
    expect(parse('Practice saturday').due_date).toBe('2026-10-17')
    expect(parse('Practice Sunday').due_date).toBe('2026-10-18')
  })

  it('reads "next <weekday>" as that day in next week', () => {
    // Next week runs Sun Oct 18 – Sat Oct 24.
    expect(parse('Essay next Monday').due_date).toBe('2026-10-19')
    expect(parse('Essay next friday').due_date).toBe('2026-10-23')
    expect(parseQuickAdd('Essay next friday', { today: '2026-10-12', courses }).due_date).toBe('2026-10-23')
    expect(parseQuickAdd('Essay friday', { today: '2026-10-12', courses }).due_date).toBe('2026-10-16')
    expect(parse('Plan project next week').due_date).toBe('2026-10-19')
  })

  it('reads "in N days / weeks"', () => {
    expect(parse('Test in 3 days')).toMatchObject({ title: 'Test', due_date: '2026-10-19' })
    expect(parse('Project in 2 weeks').due_date).toBe('2026-10-30')
    expect(parse('Project in a week').due_date).toBe('2026-10-23')
    expect(parse('Reading in one day').due_date).toBe('2026-10-17')
  })

  it('reads month names with a day, rolling past dates into next year', () => {
    expect(parse('History essay Oct 24')).toMatchObject({ title: 'History essay', due_date: '2026-10-24' })
    expect(parse('History essay October 24th').due_date).toBe('2026-10-24')
    expect(parse('Paper due 24 Oct').due_date).toBe('2026-10-24')
    expect(parse('Paper due Sept. 3').due_date).toBe('2027-09-03')
    expect(parse('Final Jan 12 2027').due_date).toBe('2027-01-12')
    expect(parse('Final Oct 16').due_date).toBe('2026-10-16')
  })

  it('reads numeric month/day dates', () => {
    expect(parse('Lab 10/24')).toMatchObject({ title: 'Lab', due_date: '2026-10-24' })
    expect(parse('Lab 1/5').due_date).toBe('2027-01-05')
    expect(parse('Lab by 11/2/26').due_date).toBe('2026-11-02')
    expect(parse('Lab by 11/2/2027').due_date).toBe('2027-11-02')
  })

  it('ignores things that only look like dates', () => {
    expect(parse('SAT practice test').due_date).toBeNull()
    expect(parse('Sun and moon worksheet').due_date).toBeNull()
    expect(parse('You may need a calculator').due_date).toBeNull()
    expect(parse('Feb 30 trivia').due_date).toBeNull()
    expect(parse('Score 13/20 again').due_date).toBeNull()
    expect(parse('Read chapter 7')).toMatchObject({ title: 'Read chapter 7', due_date: null })
  })

  it('uses the last date when there are several', () => {
    expect(parse('Monday notes, quiz Oct 30').due_date).toBe('2026-10-30')
  })

  it('keeps a lone date as the title instead of saving nothing', () => {
    expect(parse('tomorrow')).toMatchObject({ title: 'tomorrow', due_date: '2026-10-17' })
  })

  it('can ignore the date the student removed', () => {
    expect(parse('Bio lab report due Friday', { ignoreDate: true })).toMatchObject({ title: 'Bio lab report due Friday', due_date: null })
  })
})

describe('quick add courses', () => {
  it('matches a course by name or the start of its name, keeping the word', () => {
    expect(parse('Bio lab report due Friday')).toMatchObject({ course: 'Biology', title: 'Bio lab report' })
    expect(parse('chem worksheet')).toMatchObject({ course: 'Chemistry', title: 'chem worksheet' })
    expect(parse('Spanish vocab').course).toBe('Spanish')
  })

  it('matches multi-word names and their initials', () => {
    expect(parse('US History reading').course).toBe('US History')
    expect(parse('CS project in 2 weeks')).toMatchObject({ course: 'Computer Science', due_date: '2026-10-30' })
  })

  it('needs one clear match', () => {
    // "ca" is too short and "c" matches several courses' initials.
    expect(parse('Call grandma').course).toBeNull()
    expect(parse('Read the Odyssey').course).toBeNull()
  })

  it('reads #tags by name start or initial and removes them from the title', () => {
    expect(parse('Worksheet #chem tomorrow')).toMatchObject({ course: 'Chemistry', title: 'Worksheet', due_date: '2026-10-17' })
    expect(parse('Worksheet #s')).toMatchObject({ course: 'Spanish', title: 'Worksheet' })
    expect(parse('Worksheet #c').course).toBeNull()
  })

  it('does not take a course from the date words', () => {
    expect(parseQuickAdd('Essay friday', { today, courses: ['Friday Club'] }).course).toBeNull()
  })

  it('can ignore the course the student removed, and works with no courses', () => {
    expect(parse('Bio lab report', { ignoreCourse: true }).course).toBeNull()
    expect(parseQuickAdd('Bio lab Friday', { today, courses: [] })).toMatchObject({ course: null, due_date: '2026-10-23' })
  })
})
