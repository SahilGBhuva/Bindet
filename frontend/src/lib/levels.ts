/*
 * Easy / Medium / Hard for practice tests and flashcards. The server owns what each level
 * means (fixed prompt rules and presets); this file only names, describes and colors them,
 * and holds the small pure rules the setup screens use.
 */
export type Level = 'easy' | 'medium' | 'hard'

export const LEVELS: readonly Level[] = ['easy', 'medium', 'hard']
export const DEFAULT_LEVEL: Level = 'medium'

type LevelInfo = {
  label: string
  // One line under the label on the practice test setup screen.
  test: string
  // One line under the label on the flashcards level picker.
  cards: string
  // Green, amber, red: the picker's color for this level (see LevelPicker.css).
  tone: 'green' | 'amber' | 'red'
}

export const LEVEL_INFO: Record<Level, LevelInfo> = {
  easy: { label: 'Easy', test: 'Recall terms and definitions. Mostly multiple choice.', cards: 'Term → definition, one fact per card.', tone: 'green' },
  medium: { label: 'Medium', test: 'A mix of recall and applying ideas.', cards: 'A mix of facts and ideas. The usual deck.', tone: 'amber' },
  hard: { label: 'Hard', test: 'Multi-step, “explain why”, tricky choices. More written answers.', cards: 'Why and how, compare, cause and effect.', tone: 'red' },
}

export function isLevel(value: unknown): value is Level {
  return value === 'easy' || value === 'medium' || value === 'hard'
}

/* A level from the server, with older tests and unknown values read as medium. */
export function levelOf(value: unknown): Level {
  return isLevel(value) ? value : DEFAULT_LEVEL
}

/* Minutes per question at each level: Easy gets more time, Hard less, like a real exam.
 * The server's default is the same (practice_tests.SECONDS_PER_QUESTION). */
export const MINUTES_PER_QUESTION: Record<Level, number> = { easy: 2, medium: 1.5, hard: 1.2 }

/* Test mode (exam conditions) is on by default for Hard only; the student can change it. */
export function defaultTestMode(level: Level) {
  return level === 'hard'
}

/*
 * The level a unit's flashcard deck is at, from each note's level: the shared level, or
 * 'mixed' when notes differ, or 'custom' when they were made with the student's own
 * instructions. null with no cards yet.
 */
export function deckLevel(levels: readonly (Level | 'custom' | undefined)[]): Level | 'custom' | 'mixed' | null {
  const known = levels.filter((level): level is Level | 'custom' => level !== undefined)
  if (!known.length) return null
  return known.every((level) => level === known[0]) ? known[0] : 'mixed'
}

/*
 * The confirm before a deck is remade at another level. Remaking replaces the unit's cards:
 * the old level's cards are kept on the server (switching back reuses them without a new
 * AI write), and spaced-review progress carries over only for cards whose front is unchanged.
 */
export function levelRemakeQuestion(level: Level, current: Level | 'custom' | 'mixed' | null, unit: string) {
  const name = LEVEL_INFO[level].label
  if (current === null) return `Make ${name} cards for ${unit}?`
  const kept = current === 'mixed' || current === 'custom' ? 'Your current cards are' : `Your ${LEVEL_INFO[current].label} cards are`
  return `Make ${name} cards for ${unit}? ${kept} saved, so switching back brings them back. Review progress restarts for cards that change.`
}
