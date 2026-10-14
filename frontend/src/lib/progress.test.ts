import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopicStat } from './api'
import { areaPath, buildCoursePulse, loadUnitAttempts, paletteFor, recordUnitAttempt, smoothPath } from './progress'
import type { Course, NoteDeposit, UnitAttempt } from './types'

const biology: Course = { name: 'Biology', units: ['Cells', 'Genetics'], tone: '#0b58f5' }

function note(unit: string, course = 'Biology'): NoteDeposit {
  return { id: `${course}-${unit}-${Math.random()}`, course, unit, fileName: 'notes.txt', createdAt: '2026-10-01T00:00:00Z' }
}

/* Attempts in order, from a string such as "1101" (1 = right). */
function attempts(unit: string, pattern: string, course = 'Biology'): UnitAttempt[] {
  return [...pattern].map((mark, index) => ({ id: `${unit}-${index}`, course, unit, correct: mark === '1', at: index }))
}

function unitOf(pulse: ReturnType<typeof buildCoursePulse>, name: string) {
  const unit = pulse.units.find((item) => item.name === name)
  if (!unit) throw new Error(`no unit ${name}`)
  return unit
}

describe('buildCoursePulse: unit verdicts', () => {
  it('locks units with no notes and no answers', () => {
    const pulse = buildCoursePulse(biology, [], [], [])
    expect(pulse.units.map((unit) => unit.verdict)).toEqual(['locked', 'locked'])
    expect(pulse.verdict).toBe('locked')
    expect(pulse.mastery).toBe(0)
    expect(pulse.live).toBe(false)
    expect(pulse.overall).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('seeds a unit that has notes but no answers, nudging mastery by 2 per note', () => {
    const pulse = buildCoursePulse(biology, [note('Cells'), note('Cells')], [], [])
    const cells = unitOf(pulse, 'Cells')
    expect(cells.verdict).toBe('seeded')
    expect(cells.notes).toBe(2)
    // 38% prior with no answers, +4 for two notes.
    expect(cells.mastery).toBe(42)
    expect(pulse.verdict).toBe('seeded')
    expect(pulse.mastery).toBe(21)
    expect(pulse.recommended).toBe('Cells')
  })

  it('caps the notes nudge at 8 points', () => {
    const pulse = buildCoursePulse(biology, Array.from({ length: 10 }, () => note('Cells')), [], [])
    expect(unitOf(pulse, 'Cells').mastery).toBe(46)
  })

  it('is still warming with fewer than 4 answers', () => {
    const pulse = buildCoursePulse(biology, [], attempts('Cells', '111'), [])
    const cells = unitOf(pulse, 'Cells')
    expect(cells.verdict).toBe('warming')
    expect(cells.accuracy).toBe(100)
    // Confidence 3/9 pulls a perfect start toward the 38% prior.
    expect(cells.mastery).toBe(59)
  })

  it('calls a unit rising when recent answers beat earlier ones', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '000000111111'), []), 'Cells')
    expect(cells.verdict).toBe('rising')
    expect(cells.delta).toBe(100)
    expect(cells.accuracy).toBe(50)
    expect(cells.mastery).toBe(46)
  })

  it('calls a unit slipping when recent answers are worse', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '111111000000'), []), 'Cells')
    expect(cells.verdict).toBe('slipping')
    expect(cells.delta).toBe(-100)
  })

  it('calls high, stable mastery sharp', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '1'.repeat(20)), []), 'Cells')
    expect(cells.mastery).toBe(86)
    expect(cells.verdict).toBe('sharp')
    expect(cells.delta).toBe(0)
  })

  it('calls many tries under 45% mastery stuck', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '1000001000'), []), 'Cells')
    expect(cells.mastery).toBe(27)
    expect(cells.delta).toBe(-8)
    expect(cells.verdict).toBe('stuck')
  })

  it('calls a small change in the middle steady', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '1101101101'), []), 'Cells')
    expect(cells.mastery).toBe(58)
    expect(cells.verdict).toBe('steady')
  })

  it('compares recent answers with themselves when there are fewer than 3 earlier ones', () => {
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '1111'), []), 'Cells')
    expect(cells.delta).toBe(0)
    expect(cells.mastery).toBe(63)
    expect(cells.verdict).toBe('steady')
  })

  it('counts a one-answer gain over the last 6 (+17 points) as rising', () => {
    // Earlier 6: 3/6 = 50%; recent 6: 4/6 ≈ 67% → +17 points, rising.
    expect(unitOf(buildCoursePulse(biology, [], attempts('Cells', '101010' + '110110'), []), 'Cells').verdict).toBe('rising')
  })
})

describe('buildCoursePulse: data sources', () => {
  it('falls back to server topic stats when this device logged no answers', () => {
    const topics: TopicStat[] = [{ topic: ' cells ', attempts: 10, correct_answers: 9, accuracy: 90 }]
    const cells = unitOf(buildCoursePulse(biology, [], [], topics), 'Cells')
    expect(cells.attempts).toBe(10)
    expect(cells.correct).toBe(9)
    expect(cells.accuracy).toBe(90)
    expect(cells.mastery).toBe(71)
    expect(cells.verdict).toBe('steady')
  })

  it('prefers answers logged on this device over topic stats', () => {
    const topics: TopicStat[] = [{ topic: 'Cells', attempts: 50, correct_answers: 0, accuracy: 0 }]
    const cells = unitOf(buildCoursePulse(biology, [], attempts('Cells', '1111'), topics), 'Cells')
    expect(cells.attempts).toBe(4)
    expect(cells.correct).toBe(4)
  })

  it('matches course and unit names without regard to case or spacing', () => {
    const logged = attempts(' cells', '111', 'BIOLOGY ')
    const pulse = buildCoursePulse(biology, [note('CELLS', 'biology')], logged, [])
    expect(unitOf(pulse, 'Cells').attempts).toBe(3)
    expect(unitOf(pulse, 'Cells').notes).toBe(1)
  })

  it('ignores answers and notes from other courses', () => {
    const pulse = buildCoursePulse(biology, [note('Cells', 'Chemistry')], attempts('Cells', '1111', 'Chemistry'), [])
    expect(unitOf(pulse, 'Cells').verdict).toBe('locked')
  })

  it('rounds accuracy to one decimal place', () => {
    expect(unitOf(buildCoursePulse(biology, [], attempts('Cells', '100'), []), 'Cells').accuracy).toBe(33.3)
  })
})

describe('buildCoursePulse: course verdict and recommendation', () => {
  it('lets one slipping unit outweigh a rising one, and recommends it', () => {
    const logged = [...attempts('Cells', '000000111111'), ...attempts('Genetics', '111111000000')]
    const pulse = buildCoursePulse(biology, [], logged, [])
    expect(pulse.verdict).toBe('slipping')
    expect(pulse.recommended).toBe('Genetics')
    expect(pulse.reason).toBe('Recent answers are weaker than before')
  })

  it('is rising when a unit rises and none slip', () => {
    const logged = [...attempts('Cells', '000000111111'), ...attempts('Genetics', '1111')]
    expect(buildCoursePulse(biology, [], logged, []).verdict).toBe('rising')
  })

  it('is sharp only when every unit is sharp or steady and the average is high', () => {
    const logged = [...attempts('Cells', '1'.repeat(20)), ...attempts('Genetics', '1'.repeat(20))]
    expect(buildCoursePulse(biology, [], logged, []).verdict).toBe('sharp')
  })

  it('is warming while any unit is still warming', () => {
    const logged = [...attempts('Cells', '1'.repeat(20)), ...attempts('Genetics', '11')]
    const pulse = buildCoursePulse(biology, [], logged, [])
    expect(pulse.verdict).toBe('warming')
    expect(pulse.recommended).toBe('Genetics')
  })

  it('recommends the weakest unit when nothing needs attention', () => {
    const logged = [...attempts('Cells', '1'.repeat(20)), ...attempts('Genetics', '1111')]
    expect(buildCoursePulse(biology, [], logged, []).recommended).toBe('Genetics')
  })

  it('handles a course with no units', () => {
    const pulse = buildCoursePulse({ name: 'Empty', units: [] }, [], [], [])
    expect(pulse.mastery).toBe(0)
    expect(pulse.recommended).toBe('')
    expect(pulse.series).toEqual([])
    expect(pulse.overall).toHaveLength(8)
  })
})

describe('buildCoursePulse: chart series', () => {
  it('has 8 sessions, pads the start and ends at current mastery', () => {
    const pulse = buildCoursePulse(biology, [], attempts('Cells', '111111'), [])
    expect(pulse.labels).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
    // Sessions of 3 answers: 59 after the first, 69 after the second.
    expect(pulse.series[0].values).toEqual([59, 59, 59, 59, 59, 59, 59, 69])
    expect(pulse.series[0].values.at(-1)).toBe(unitOf(pulse, 'Cells').mastery)
  })

  it('keeps only the last 8 sessions', () => {
    const pulse = buildCoursePulse(biology, [], attempts('Cells', '0'.repeat(15) + '1'.repeat(15)), [])
    expect(pulse.series[0].values).toHaveLength(8)
  })

  it('averages unit lines into the overall line', () => {
    const pulse = buildCoursePulse(biology, [note('Cells')], [], [])
    // Cells is seeded at 40 every session, Genetics locked at 0.
    expect(pulse.series.map((line) => line.values[0])).toEqual([40, 0])
    expect(pulse.overall).toEqual(Array(8).fill(20))
  })
})

describe('paletteFor', () => {
  it('builds colors from the course hue', () => {
    const palette = paletteFor('#f00', 3)
    expect(palette.line).toBe('hsl(0 74% 42%)')
    expect(palette.fill).toBe('hsl(0 70% 50% / 0.16)')
    expect(palette.units).toEqual(['hsl(0 82% 44%)', 'hsl(42 82% 48%)', 'hsl(322 82% 52%)'])
  })

  it('treats grays as a neutral blue hue and always offers one unit color', () => {
    const palette = paletteFor('#888888', 0)
    expect(palette.line).toBe('hsl(210 74% 42%)')
    expect(palette.units).toHaveLength(1)
  })

  it('keeps unit hues in 0–359 even past the preset shifts', () => {
    for (const color of paletteFor('#0b58f5', 9).units) {
      const hue = Number(/^hsl\((\d+) /.exec(color)?.[1])
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})

describe('smoothPath and areaPath', () => {
  it('returns nothing for no values', () => {
    expect(smoothPath([], 100, 100, 10, 10)).toBe('')
    expect(areaPath([], 100, 100, 10, 10)).toBe('')
  })

  it('centers a single value', () => {
    expect(smoothPath([50], 100, 100, 10, 10)).toBe('M 50 50')
  })

  it('draws a curve from 0% at the bottom to 100% at the top', () => {
    expect(smoothPath([0, 100], 100, 100, 10, 10)).toBe('M 10 90 C 50 90, 50 10, 90 10')
  })

  it('closes the area along the baseline', () => {
    expect(areaPath([0, 100], 100, 100, 10, 10)).toBe('M 10 90 C 50 90, 50 10, 90 10 L 90 90 L 10 90 Z')
  })
})

describe('unit attempt log', () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('starts empty and survives corrupt or unexpected data', () => {
    expect(loadUnitAttempts()).toEqual([])
    store.set('bindet-unit-attempts', '{not json')
    expect(loadUnitAttempts()).toEqual([])
    store.set('bindet-unit-attempts', '{"course":"Biology"}')
    expect(loadUnitAttempts()).toEqual([])
    store.set('bindet-unit-attempts', JSON.stringify([null, { course: 'Biology' }, { course: 'Biology', unit: 'Cells', correct: true, at: 1, id: 'a' }]))
    expect(loadUnitAttempts()).toHaveLength(1)
  })

  it('records attempts and skips ones without a course or unit', () => {
    recordUnitAttempt({ course: 'Biology', unit: 'Cells', correct: true, at: 5 })
    recordUnitAttempt({ course: '', unit: 'Cells', correct: true })
    const saved = loadUnitAttempts()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ course: 'Biology', unit: 'Cells', correct: true, at: 5 })
    expect(typeof saved[0].id).toBe('string')
  })

  it('keeps only the newest 400 attempts', () => {
    store.set('bindet-unit-attempts', JSON.stringify(attempts('Cells', '0'.repeat(400))))
    recordUnitAttempt({ course: 'Biology', unit: 'Cells', correct: true, at: 999 })
    const saved = loadUnitAttempts()
    expect(saved).toHaveLength(400)
    expect(saved[0].id).toBe('Cells-1')
    expect(saved.at(-1)?.at).toBe(999)
  })
})
