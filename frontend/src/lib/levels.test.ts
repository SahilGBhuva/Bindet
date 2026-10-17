import { describe, expect, it } from 'vitest'
import { deckLevel, defaultTestMode, isLevel, LEVEL_INFO, LEVELS, levelOf, levelRemakeQuestion, MINUTES_PER_QUESTION } from './levels'

describe('levels', () => {
  it('names three levels, green to red, each with a description for tests and for cards', () => {
    expect(LEVELS).toEqual(['easy', 'medium', 'hard'])
    expect(LEVELS.map((level) => LEVEL_INFO[level].tone)).toEqual(['green', 'amber', 'red'])
    for (const level of LEVELS) {
      expect(LEVEL_INFO[level].test.length).toBeGreaterThan(10)
      expect(LEVEL_INFO[level].cards.length).toBeGreaterThan(10)
    }
  })

  it('reads unknown or missing levels as medium', () => {
    expect(levelOf('hard')).toBe('hard')
    expect(levelOf(undefined)).toBe('medium')
    expect(levelOf('HARD')).toBe('medium')
    expect(isLevel('easy')).toBe(true)
    expect(isLevel('custom')).toBe(false)
  })

  it('matches the server minutes per question and turns test mode on for Hard only', () => {
    // backend practice_tests.SECONDS_PER_QUESTION: 120, 90, 72.
    expect(LEVELS.map((level) => MINUTES_PER_QUESTION[level] * 60)).toEqual([120, 90, 72])
    expect(LEVELS.map(defaultTestMode)).toEqual([false, false, true])
  })

  it('works out a deck level from its notes', () => {
    expect(deckLevel([])).toBeNull()
    expect(deckLevel([undefined])).toBeNull()
    expect(deckLevel(['hard', 'hard'])).toBe('hard')
    expect(deckLevel(['easy', undefined])).toBe('easy')
    expect(deckLevel(['easy', 'hard'])).toBe('mixed')
    expect(deckLevel(['custom'])).toBe('custom')
  })

  it('asks before remaking a deck and says what happens to the old cards and review progress', () => {
    expect(levelRemakeQuestion('hard', 'easy', 'Cells')).toBe(
      'Make Hard cards for Cells? Your Easy cards are saved, so switching back brings them back. Review progress restarts for cards that change.',
    )
    expect(levelRemakeQuestion('easy', 'custom', 'Cells')).toContain('Your current cards are saved')
    expect(levelRemakeQuestion('easy', null, 'Cells')).toMatch(/^Make Easy cards for Cells\?/)
  })
})
