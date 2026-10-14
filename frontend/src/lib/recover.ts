/*
 * Recovering from a page piece that failed to download. The app is split into pieces that load
 * on demand; after a new version is deployed, a tab opened earlier may ask for a piece that no
 * longer exists. Instead of a blank screen, the page reloads once to pick up the new version.
 * A short guard stops a reload loop when the network itself is down.
 */
const RELOAD_KEY = 'bindet:recover-reload'
const RELOAD_GUARD_MS = 30_000

export function isChunkLoadError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '')
  return /dynamically imported module|Importing a module script failed|error loading dynamically|ChunkLoadError|Unable to preload CSS|Failed to load module script|Expected a JavaScript/i.test(text)
}

/** Reloads the page unless it already did so in the last 30 s. True when a reload started. */
export function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_GUARD_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // Storage blocked: reload anyway; the browser's own back-off keeps this from looping fast.
  }
  window.location.reload()
  return true
}

/** Vite reports a failed piece of a page here before React sees it. */
export function listenForStaleChunks() {
  window.addEventListener('vite:preloadError', (event) => {
    // Only swallow the error when the page is reloading: otherwise it must reach the page's
    // error boundary (a swallowed error leaves the import empty and the page crashes oddly).
    if (reloadOnce()) event.preventDefault()
  })
}
