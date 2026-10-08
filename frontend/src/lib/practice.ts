/*
 * Practice test answers in progress, kept in this tab's sessionStorage under the test's ID,
 * so a refresh doesn't lose them. Cleared when the test is submitted, and with every other
 * bindet key on sign-out (auth.ts clears sessionStorage). Every read and write is guarded:
 * storage can be unavailable, and the test still works without it.
 */
export type PracticeDraft = { answers: Record<number, string>; flags: number[]; current: number }

const draftKey = (testId: string) => `bindit:practice:${testId}`

export function loadPracticeDraft(testId: string): PracticeDraft | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(draftKey(testId)) ?? 'null') as Partial<PracticeDraft> | null
    if (!raw || typeof raw !== 'object') return null
    const answers: Record<number, string> = {}
    for (const [position, answer] of Object.entries(raw.answers ?? {})) {
      if (typeof answer === 'string' && /^\d+$/.test(position)) answers[Number(position)] = answer.slice(0, 500)
    }
    const flags = Array.isArray(raw.flags) ? raw.flags.filter((value): value is number => Number.isInteger(value)) : []
    const current = Number.isInteger(raw.current) ? Number(raw.current) : 0
    return { answers, flags, current }
  } catch {
    return null
  }
}

export function savePracticeDraft(testId: string, draft: PracticeDraft) {
  try {
    sessionStorage.setItem(draftKey(testId), JSON.stringify(draft))
  } catch {
    // Not saved; the answers stay on screen until the page is closed.
  }
}

export function clearPracticeDraft(testId: string) {
  try {
    sessionStorage.removeItem(draftKey(testId))
  } catch {
    // Nothing to clear.
  }
}

/* Minutes and seconds, as 12:05 (or 1:02:05 past an hour). */
export function formatClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/* The suggested time limit: 1.5 minutes a question, rounded up, between 5 and 60. */
export function suggestedMinutes(count: number) {
  return Math.min(60, Math.max(5, Math.ceil(count * 1.5)))
}
