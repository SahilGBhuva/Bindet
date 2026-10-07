/*
 * Per-device study preferences kept in localStorage. Every read and write is guarded:
 * storage can be unavailable (private mode, blocked site data), and the page must work
 * the same without it.
 */

/** Focus mode text size. Cosmetic: listed in COSMETIC_KEYS so signing out keeps it. */
export const FOCUS_SIZE_KEY = 'bindit:focus-text-size'
export const FOCUS_SIZES = [1, 1.2, 1.45, 1.75] as const

export function loadFocusSize(): number {
  try {
    const raw = localStorage.getItem(FOCUS_SIZE_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(value) && value >= 0 && value < FOCUS_SIZES.length ? value : 1
  } catch {
    return 1
  }
}

export function saveFocusSize(step: number) {
  try {
    localStorage.setItem(FOCUS_SIZE_KEY, String(step))
  } catch {
    // Not saved; the size still applies until the page is closed.
  }
}

/**
 * Custom instructions for a unit's quiz or flashcards. Study data, not cosmetic: under
 * the bindit: prefix but not in COSMETIC_KEYS, so signing out clears them.
 */
export const INSTRUCTIONS_MAX = 200
export type InstructionKind = 'quiz' | 'cards'

export function instructionsKey(kind: InstructionKind, course: string, unit: string) {
  return `bindit:instructions:${kind}:${course.trim()}|${unit.trim()}`
}

export function loadInstructions(key: string): string {
  try {
    return (localStorage.getItem(key) ?? '').slice(0, INSTRUCTIONS_MAX)
  } catch {
    return ''
  }
}

export function saveInstructions(key: string, value: string) {
  try {
    if (value.trim()) localStorage.setItem(key, value.slice(0, INSTRUCTIONS_MAX))
    else localStorage.removeItem(key)
  } catch {
    // Not saved; the instructions still apply until the page is closed.
  }
}
