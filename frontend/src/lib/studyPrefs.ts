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

/** Keeps a unit's custom instructions when the unit (or its course) is renamed. */
export function moveInstructions(from: { course: string; unit: string }, to: { course: string; unit: string }) {
  for (const kind of ['quiz', 'cards'] as const) {
    const fromKey = instructionsKey(kind, from.course, from.unit)
    const toKey = instructionsKey(kind, to.course, to.unit)
    if (fromKey === toKey) continue
    const value = loadInstructions(fromKey)
    if (!value) continue
    if (!loadInstructions(toKey)) saveInstructions(toKey, value)
    saveInstructions(fromKey, '')
  }
}

/**
 * Courses deleted from this device. Their notes stay saved on the server, so without this
 * list the next sync (which adds every course that holds notes) would bring them back.
 * Study data: cleared on sign-out like the instructions.
 */
const HIDDEN_COURSES_KEY = 'bindit:hidden-courses'

export function loadHiddenCourses(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_COURSES_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function setCourseHidden(name: string, hidden: boolean) {
  const key = name.trim()
  if (!key) return
  try {
    const current = loadHiddenCourses().filter((item) => item.trim() !== key)
    const next = hidden ? [...current, key] : current
    if (next.length) localStorage.setItem(HIDDEN_COURSES_KEY, JSON.stringify(next.slice(-200)))
    else localStorage.removeItem(HIDDEN_COURSES_KEY)
  } catch {
    // Not saved; the course may come back on the next sync.
  }
}
