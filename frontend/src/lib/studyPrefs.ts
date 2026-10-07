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
