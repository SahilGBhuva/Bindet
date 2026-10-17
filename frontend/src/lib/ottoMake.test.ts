import { describe, expect, it } from 'vitest'
import { choiceForKey, makePrompt, makingLabel, ottoMadeFrom, practiceTestHash } from './ottoMake'

const id = '0b7c2f5e-1a2b-4c3d-8e9f-001122334455'

describe('ottoMadeFrom', () => {
  it('reads decks, quizzes and the unit picker', () => {
    expect(ottoMadeFrom(`deck:${id}`)).toEqual({ type: 'deck', noteId: id })
    expect(ottoMadeFrom(`quiz:${id}:${id}`)).toEqual({ type: 'quiz', testId: id, noteId: id })
    expect(ottoMadeFrom('pick:flashcards')).toEqual({ type: 'pick', kind: 'flashcards', count: 8 })
    expect(ottoMadeFrom('pick:quiz:12')).toEqual({ type: 'pick', kind: 'quiz', count: 12 })
  })

  it('ignores image names and other attachments', () => {
    for (const value of ['photo.jpg', `guide:${id}:summary`, 'deck:', 'quiz:abc', 'pick:quiz:', `deck:${id}/x`]) expect(ottoMadeFrom(value)).toBeNull()
  })
})

describe('labels and prompts', () => {
  it('says what Otto is making', () => {
    expect(makingLabel({ kind: 'flashcards', count: 10 })).toBe('Making 10 flashcards…')
    expect(makingLabel({ kind: 'quiz', count: 8 })).toBe('Writing your practice test…')
  })

  it('chips send messages Otto recognizes', () => {
    expect(makePrompt('flashcards')).toBe('Make flashcards on this')
    expect(makePrompt('quiz', 5)).toBe('Make a practice test on this with 5 questions')
  })

  it('links a test into Study', () => {
    expect(practiceTestHash('t1', 'Bio & Chem', 'Unit 1')).toBe('#tools?test=t1&course=Bio+%26+Chem&unit=Unit+1')
  })

  it('maps 1–4 and A–D to choices', () => {
    expect(['1', '4', 'a', 'D', '5', 'e', 'Enter'].map((key) => choiceForKey(key, 4))).toEqual([0, 3, 0, 3, null, null, null])
  })
})
