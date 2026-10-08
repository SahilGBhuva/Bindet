import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import type { Screen } from '../lib/screens'
import './HelpBot.css'

/*
 * The small "how to use bindet" helper in the corner of the signed-in app. Separate
 * from Otto: it only explains the app. The panel (and its FAQ) loads on first open.
 *
 * Mounted only by AppShell, so it never appears on the logged-out landing page, the
 * auth screens or the landing demo. It stays out of the way where a corner button
 * would cover something: Otto and Messages (their message boxes sit there on phones),
 * a practice test in progress, and Focus mode.
 */

const loadPanel = () => import('./HelpBotPanel')
const HelpBotPanel = lazy(() => loadPanel().then((module) => ({ default: module.HelpBotPanel })))

const HIDDEN_SCREENS: Screen[] = ['tutor', 'chat']
/* A practice test being taken (its Submit bar) or Focus mode on flashcards or the quiz. */
const BUSY_SELECTOR = '.practice__submit, .tools__cards.is-focus, .tools__quiz.is-focus'

function useBusyStudy(active: boolean) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!active) return
    const main = document.getElementById('main-content')
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setBusy(Boolean(document.querySelector(BUSY_SELECTOR))))
    }
    check()
    const observer = new MutationObserver(check)
    // The page itself is re-keyed per screen, so watch the shell's main area.
    observer.observe(main ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [active])
  return active && busy
}

export function HelpBot({ screen, session }: { screen: Screen; session: AuthSession }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const hiddenScreen = HIDDEN_SCREENS.includes(screen)
  const busy = useBusyStudy(!hiddenScreen)
  const hidden = hiddenScreen || busy

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) window.setTimeout(() => button.current?.focus(), 0)
  }, [])

  // Leaving for a page where the helper is hidden closes it (adjusted during render, not in an effect).
  const [wasHidden, setWasHidden] = useState(hidden)
  if (hidden !== wasHidden) {
    setWasHidden(hidden)
    if (hidden) setOpen(false)
  }

  if (hidden) return null

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`helpbot__fab${open ? ' is-open' : ''}`}
        aria-label="Help using bindet"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onPointerEnter={() => void loadPanel().catch(() => undefined)}
        onFocus={() => void loadPanel().catch(() => undefined)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" /></svg>
        <span className="helpbot__fab-label">Help</span>
      </button>
      {open ? (
        <Suspense fallback={<div className="helpbot__panel helpbot__panel--loading" aria-busy="true" aria-label="Loading help"><span className="ui-skeleton" /><span className="ui-skeleton" /></div>}>
          <HelpBotPanel session={session} onClose={close} />
        </Suspense>
      ) : null}
    </>
  )
}
