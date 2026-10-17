/*
 * What Otto made for a reply, from the reply's attachments (backend otto_make.py):
 *   "deck:<note id>"               a flashcard deck (that note's cards)
 *   "quiz:<test id>:<note id>"     an inline practice quiz and the note it was written from
 *   "pick:flashcards" | "pick:quiz:<count>"   Otto asks which course and unit to save to
 */

export type OttoMade =
  | { type: 'deck'; noteId: string }
  | { type: 'quiz'; testId: string; noteId: string }
  | { type: 'pick'; kind: 'flashcards' | 'quiz'; count: number }

export const QUIZ_COUNTS = [5, 8, 12] as const
export const DEFAULT_QUIZ_COUNT = 8

const ID = '[0-9A-Za-z-]{1,64}'

export function ottoMadeFrom(attachment: string): OttoMade | null {
  let match = new RegExp(`^deck:(${ID})$`).exec(attachment)
  if (match) return { type: 'deck', noteId: match[1] }
  match = new RegExp(`^quiz:(${ID}):(${ID})$`).exec(attachment)
  if (match) return { type: 'quiz', testId: match[1], noteId: match[2] }
  if (attachment === 'pick:flashcards') return { type: 'pick', kind: 'flashcards', count: DEFAULT_QUIZ_COUNT }
  match = /^pick:quiz:(\d{1,2})$/.exec(attachment)
  if (match) return { type: 'pick', kind: 'quiz', count: Number(match[1]) }
  return null
}

/* The progress line while Otto works on it. */
export function makingLabel(making: { kind: 'flashcards' | 'quiz'; count: number }) {
  if (making.kind === 'quiz') return 'Writing your practice test…'
  return making.count > 1 ? `Making ${making.count} flashcards…` : 'Making flashcards…'
}

/* What a chip sends: an ordinary message Otto recognizes, so typing it works the same way. */
export function makePrompt(kind: 'flashcards' | 'quiz', count = DEFAULT_QUIZ_COUNT) {
  return kind === 'flashcards' ? 'Make flashcards on this' : `Make a practice test on this with ${count} questions`
}

/* Study opens a practice test from this link ("Open as full practice test"). */
export function practiceTestHash(testId: string, course: string, unit: string | null) {
  const query = new URLSearchParams({ test: testId, course })
  if (unit) query.set('unit', unit)
  return `#tools?${query}`
}

/* Keyboard choice keys for the inline quiz: 1–4 or A–D. */
export function choiceForKey(key: string, choices: number): number | null {
  const lower = key.toLowerCase()
  const index = /^[1-9]$/.test(lower) ? Number(lower) - 1 : /^[a-z]$/.test(lower) ? lower.charCodeAt(0) - 97 : -1
  return index >= 0 && index < choices ? index : null
}
