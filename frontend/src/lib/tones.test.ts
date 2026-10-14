import { describe, expect, it } from 'vitest'
import { courseInitial, toneClass, toneForName, TONES } from './tones'

describe('toneForName', () => {
  it('gives the same name the same tone every time', () => {
    expect(toneForName('Maya Chen')).toBe(toneForName('Maya Chen'))
    expect(toneForName('')).toBe(toneForName(''))
  })

  it('always returns one of the seven tones', () => {
    for (const name of ['a', 'Ben', 'Priya Patel', 'Ω', '数学', 'x'.repeat(500)]) {
      expect(TONES).toContain(toneForName(name))
    }
  })

  it('matches the documented 31-multiplier hash (so colors never shift between releases)', () => {
    // "a" = 97 → 97 % 7 = 6 → amber; "" = 0 → blue.
    expect(toneForName('a')).toBe('amber')
    expect(toneForName('')).toBe('blue')
  })

  it('spreads a class of names across several tones', () => {
    const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella', 'Finn', 'Grace', 'Hugo', 'Isla', 'Jai', 'Kai', 'Leo']
    expect(new Set(names.map(toneForName)).size).toBeGreaterThanOrEqual(4)
  })
})

describe('toneClass', () => {
  it('builds the ui-tone modifier class', () => {
    expect(toneClass('violet')).toBe('ui-tone--violet')
  })
})

describe('courseInitial', () => {
  it('uses the first visible letter, uppercased', () => {
    expect(courseInitial('  biology')).toBe('B')
    expect(courseInitial('AP Chem')).toBe('A')
  })

  it('falls back to ? for a blank name', () => {
    expect(courseInitial('')).toBe('?')
    expect(courseInitial('   ')).toBe('?')
  })
})
