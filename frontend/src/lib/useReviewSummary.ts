import { useEffect, useState } from 'react'
import type { ReviewSummary } from './api'
import { useData } from './dataSource'
import { REVIEW_CHANGED_EVENT } from './review'

/*
 * How many flashcards are due today (the student's local day, via tz_offset) and how many
 * new ones are left. Loaded when the page opens, again whenever a grade is saved anywhere
 * (REVIEW_CHANGED_EVENT), and when the tab becomes visible again. Null until it loads or
 * if the server can't say; callers then show nothing rather than a wrong count.
 * In the landing demo this reads the in-memory sandbox.
 */
export function useReviewSummary(accessToken: string | undefined) {
  const data = useData()
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const canRead = Boolean(accessToken) || data.sandboxed

  useEffect(() => {
    if (!canRead) return
    let live = true
    let controller: AbortController | null = null
    const load = () => {
      controller?.abort()
      const current = new AbortController()
      controller = current
      data.getReviewSummary(accessToken, current.signal)
        .then((value) => { if (live && controller === current) setSummary(value) })
        .catch(() => undefined)
    }
    // Coming back to the tab refreshes (a day may have turned, or cards come due).
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    load()
    window.addEventListener(REVIEW_CHANGED_EVENT, load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      controller?.abort()
      window.removeEventListener(REVIEW_CHANGED_EVENT, load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [data, accessToken, canRead])

  return canRead ? summary : null
}

/* The hash that opens Study in Review mode over every unit (read and removed by Study). */
export const REVIEW_ALL_HASH = '#tools?review=all'
