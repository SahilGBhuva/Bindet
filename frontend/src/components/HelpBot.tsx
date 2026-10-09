import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import type { Screen } from '../lib/screens'
import { OPEN_HELP_EVENT } from '../lib/helpEvents'
import './HelpBot.css'

/*
 * The small "how to use bindet" helper in the corner of the signed-in app. Separate
 * from Otto: it only explains the app. The panel (and its FAQ) loads on first open.
 *
 * Mounted only by AppShell, so it never appears on the logged-out landing page, the
 * auth screens or the landing demo. It stays out of the way where a corner button
 * would cover something: Otto and Messages (their message boxes sit there on phones),
 * a practice test in progress, and Focus mode. On phones it also tucks away while the
 * page scrolls down (back on scroll up or after a pause), and the Menu sheet has a "Help"
 * row that opens the same panel, so the corner button is never the only way in.
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

const TUCK_DELTA = 8
const IDLE_MS = 1200

/** True while the reader is scrolling down; false on scroll up and after a short pause. */
function useTuckOnScroll(active: boolean) {
  const [tucked, setTucked] = useState(false)
  useEffect(() => {
    if (!active) return
    const last = new WeakMap<object, number>()
    const page = document.scrollingElement
    if (page) last.set(page, page.scrollTop)
    let idle = 0
    const onScroll = (event: Event) => {
      const target = event.target
      // Scrolling inside the help panel itself never hides its button.
      if (target instanceof Element && target.closest('.helpbot__panel')) return
      const node = target === document || target === window ? document.scrollingElement : target
      if (!(node instanceof Element)) return
      const top = node.scrollTop
      const previous = last.get(node)
      last.set(node, top)
      if (previous === undefined) return
      if (top - previous > TUCK_DELTA) setTucked(true)
      else if (previous - top > TUCK_DELTA) setTucked(false)
      window.clearTimeout(idle)
      idle = window.setTimeout(() => setTucked(false), IDLE_MS)
    }
    // Capture: pages scroll the window on phones, but some panels scroll on their own.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.clearTimeout(idle)
    }
  }, [active])
  return active && tucked
}

export function HelpBot({ screen, session }: { screen: Screen; session: AuthSession }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const hiddenScreen = HIDDEN_SCREENS.includes(screen)
  const busy = useBusyStudy(!hiddenScreen)
  const hidden = hiddenScreen || busy
  const tucked = useTuckOnScroll(!hidden && !open)
  // Where focus goes back to when the panel was opened from somewhere other than the corner button.
  const opener = useRef<HTMLElement | null>(null)

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (!restoreFocus) return
    window.setTimeout(() => {
      const fab = button.current
      // The corner button can be hidden (narrow phones, Otto, Messages): fall back to the opener.
      const target = fab && fab.offsetParent !== null ? fab : opener.current?.isConnected ? opener.current : null
      opener.current = null
      target?.focus({ preventScroll: true })
    }, 0)
  }, [])

  // The Menu sheet's Help row (and anything else) can open the panel, even where the button is hidden.
  useEffect(() => {
    const onOpen = () => {
      const active = document.activeElement
      opener.current = active instanceof HTMLElement && active !== document.body ? active : document.querySelector<HTMLElement>('.bindit-tabbar button[aria-controls="bindit-menu"]')
      void loadPanel().catch(() => undefined)
      setOpen(true)
    }
    window.addEventListener(OPEN_HELP_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_HELP_EVENT, onOpen)
  }, [])

  // Leaving for a page where the helper is hidden closes it (adjusted during render, not in an effect).
  const [wasHidden, setWasHidden] = useState(hidden)
  if (hidden !== wasHidden) {
    setWasHidden(hidden)
    if (hidden) setOpen(false)
  }

  if (hidden && !open) return null

  return (
    <>
      {hidden ? null : <button
        ref={button}
        type="button"
        className={`helpbot__fab${open ? ' is-open' : ''}${tucked ? ' is-tucked' : ''}`}
        aria-label="Help using bindet"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onPointerEnter={() => void loadPanel().catch(() => undefined)}
        onFocus={() => void loadPanel().catch(() => undefined)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" /></svg>
        <span className="helpbot__fab-label">Help</span>
      </button>}
      {open ? (
        <Suspense fallback={<div className="helpbot__panel helpbot__panel--loading" aria-busy="true" aria-label="Loading help"><span className="ui-skeleton" /><span className="ui-skeleton" /></div>}>
          <HelpBotPanel session={session} onClose={close} />
        </Suspense>
      ) : null}
    </>
  )
}
