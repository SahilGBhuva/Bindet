import { useEffect } from 'react'

/*
 * Screen-reader announcements for toasts and status lines. A live region only speaks
 * when its text changes while it is already on the page, so a toast that mounts with
 * its text is often missed. LiveAnnouncer (mounted once in App, never removed) keeps
 * two empty regions: a polite one for status and an assertive one for errors. Pages
 * call announce() or useAnnounce() and keep their visual toast without a role.
 */

export const LIVE_POLITE_ID = 'bindit-live-polite'
export const LIVE_ASSERTIVE_ID = 'bindit-live-assertive'
const CLEAR_MS = 7000

const timers: Record<string, number[]> = {}

export function announce(text: string, options: { error?: boolean } = {}) {
  const message = text.trim()
  if (!message || typeof document === 'undefined') return
  const id = options.error ? LIVE_ASSERTIVE_ID : LIVE_POLITE_ID
  const region = document.getElementById(id)
  if (!region) return
  for (const timer of timers[id] ?? []) window.clearTimeout(timer)
  // Empty first, then fill: the same words twice in a row are still read again.
  region.textContent = ''
  timers[id] = [
    window.setTimeout(() => { region.textContent = message }, 60),
    // Cleared after a while so the old message isn't found later when reading the page.
    window.setTimeout(() => { region.textContent = '' }, CLEAR_MS),
  ]
}

/** Announces `text` whenever it changes to something non-empty. */
export function useAnnounce(text: string | null | undefined, options: { error?: boolean } = {}) {
  const error = Boolean(options.error)
  useEffect(() => {
    if (text) announce(text, { error })
  }, [text, error])
}
