import { describe, expect, it } from 'vitest'
import { COURSE_TONES, mergeNoteScopes, notesFor, pickCourseTone, sameName, unitsFor, withCourseTones } from './session'
import type { Course, NoteDeposit, Notebook } from './types'

describe('withCourseTones', () => {
  it('gives Biology and Chemistry their pinned colors', () => {
    const [biology, chemistry] = withCourseTones([{ name: 'Biology', units: [] }, { name: 'Chemistry', units: [] }])
    expect(biology.tone).toBe(COURSE_TONES[0])
    expect(chemistry.tone).toBe(COURSE_TONES[1])
  })

  it('keeps colors a course already has', () => {
    expect(withCourseTones([{ name: 'Art', units: [], tone: COURSE_TONES[4] }])[0].tone).toBe(COURSE_TONES[4])
  })

  it('upgrades muted pre-refresh tones to the matching new color, in any case', () => {
    const [course] = withCourseTones([{ name: 'History', units: [], tone: '#2A6EA8' }])
    expect(course.tone).toBe(COURSE_TONES[0])
  })

  it('gives a course the next free color when its preferred one is taken', () => {
    const courses = withCourseTones([{ name: 'Art', units: [], tone: COURSE_TONES[0] }, { name: 'Biology', units: [] }])
    expect(courses[1].tone).toBe(COURSE_TONES[1])
  })

  it('gives up to seven new courses seven different colors', () => {
    const names = ['Algebra', 'Biology', 'Chemistry', 'Drama', 'English', 'French', 'Geography']
    const tones = withCourseTones(names.map((name) => ({ name, units: [] }))).map((course) => course.tone)
    expect(new Set(tones).size).toBe(7)
  })

  it('is stable: the same course always gets the same color', () => {
    const once = withCourseTones([{ name: 'Psychology', units: [] }])
    const again = withCourseTones([{ name: 'Psychology', units: [] }])
    expect(once[0].tone).toBe(again[0].tone)
  })

  it('does not change the courses passed in', () => {
    const input: Course[] = [{ name: 'Biology', units: [] }]
    withCourseTones(input)
    expect(input[0].tone).toBeUndefined()
  })
})

describe('pickCourseTone', () => {
  it('picks the first unused color', () => {
    expect(pickCourseTone([])).toBe(COURSE_TONES[0])
    expect(pickCourseTone([{ name: 'A', units: [], tone: COURSE_TONES[0] }])).toBe(COURSE_TONES[1])
  })

  it('cycles once every color is used', () => {
    const all = COURSE_TONES.map((tone, index) => ({ name: `C${index}`, units: [], tone }))
    expect(pickCourseTone(all)).toBe(COURSE_TONES[0])
  })
})

describe('name helpers', () => {
  it('compares names the way the server stores them: trimmed, case kept', () => {
    expect(sameName(' Unit 1 ', 'Unit 1')).toBe(true)
    expect(sameName('unit 1', 'Unit 1')).toBe(false)
  })

  it('lists a course’s units, or none for an unknown course', () => {
    const courses = [{ name: 'Biology', units: ['Cells', 'Genetics'] }]
    expect(unitsFor(courses, 'Biology')).toEqual(['Cells', 'Genetics'])
    expect(unitsFor(courses, 'Physics')).toEqual([])
  })

  it('finds a unit’s notes', () => {
    const deposits: NoteDeposit[] = [
      { id: '1', course: 'Biology', unit: 'Cells ', fileName: 'a', createdAt: '' },
      { id: '2', course: 'Biology', unit: 'Genetics', fileName: 'b', createdAt: '' },
    ]
    expect(notesFor(deposits, 'Biology', 'Cells').map((note) => note.id)).toEqual(['1'])
  })
})

describe('mergeNoteScopes', () => {
  const notebook: Notebook = {
    courses: [{ name: 'Biology', units: ['Cells'], tone: COURSE_TONES[0] }],
    activeCourse: 'Biology',
    activeUnit: 'Cells',
    deposits: [],
  }

  it('returns the same notebook when nothing is missing', () => {
    expect(mergeNoteScopes(notebook, [{ course: ' Biology', unit: 'Cells ' }])).toBe(notebook)
  })

  it('adds a missing unit to an existing course', () => {
    const merged = mergeNoteScopes(notebook, [{ course: 'Biology', unit: 'Genetics' }])
    expect(merged.courses[0].units).toEqual(['Cells', 'Genetics'])
    expect(merged.activeUnit).toBe('Cells')
  })

  it('adds a missing course with the next free color', () => {
    const merged = mergeNoteScopes(notebook, [{ course: 'Physics', unit: 'Forces' }, { course: 'Physics', unit: 'Waves' }])
    expect(merged.courses[1]).toEqual({ name: 'Physics', units: ['Forces', 'Waves'], tone: COURSE_TONES[1] })
  })

  it('skips blank scopes and courses deleted on this device', () => {
    const merged = mergeNoteScopes(notebook, [{ course: ' ', unit: 'X' }, { course: 'Physics', unit: '' }, { course: 'Physics ', unit: 'Forces' }], ['Physics'])
    expect(merged).toBe(notebook)
  })

  it('picks an active course and unit for an empty notebook', () => {
    const empty: Notebook = { courses: [], activeCourse: '', activeUnit: '', deposits: [] }
    const merged = mergeNoteScopes(empty, [{ course: 'Physics', unit: 'Forces' }])
    expect(merged.activeCourse).toBe('Physics')
    expect(merged.activeUnit).toBe('Forces')
  })

  it('does not change the notebook passed in', () => {
    mergeNoteScopes(notebook, [{ course: 'Biology', unit: 'Genetics' }])
    expect(notebook.courses[0].units).toEqual(['Cells'])
  })
})
