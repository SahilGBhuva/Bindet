import { lazy, startTransition, Suspense, useCallback, useEffect, useState } from 'react'
import { AuthGate } from './components/AuthGate'
import { OfflineNotice, UpdatePrompt } from './components/AppPrompts'
import { CommandPalette } from './components/CommandPalette'
import { PROFILE_SETUP_ROUTED_KEY } from './components/ProfileSetupCard'
import { useAuth } from './lib/AuthContext'
import { getAccountProfile, getStudyGroups, recordDailyLogin } from './lib/api'
import { rememberPage, SCREEN_ALIASES, SCREENS, type Screen } from './lib/screens'
import { getStudentId } from './lib/session'
import { NavIcon, SiteSidebar } from './lib/SiteSidebar'
import { Home } from './pages/Home'
import './App.css'

const loaders = {
  tools: () => import('./pages/Tools').then((module) => ({ default: module.Tools })),
  tutor: () => import('./pages/Tutor').then((module) => ({ default: module.Tutor })),
  goals: () => import('./pages/Goals').then((module) => ({ default: module.Goals })),
  stats: () => import('./pages/ProjectStats').then((module) => ({ default: module.ProjectStats })),
  progress: () => import('./pages/Progress').then((module) => ({ default: module.Progress })),
  chat: () => import('./pages/Chat').then((module) => ({ default: module.Chat })),
  profile: () => import('./pages/Profile').then((module) => ({ default: module.Profile })),
  settings: () => import('./pages/Settings').then((module) => ({ default: module.Settings })),
  games: () => import('./pages/Games').then((module) => ({ default: module.Games })),
  more: () => import('./pages/More').then((module) => ({ default: module.More })),
  admin: () => import('./pages/Admin').then((module) => ({ default: module.Admin })),
}

const Tools = lazy(loaders.tools)
const Tutor = lazy(loaders.tutor)
const Goals = lazy(loaders.goals)
const ProjectStats = lazy(loaders.stats)
const Progress = lazy(loaders.progress)
const Chat = lazy(loaders.chat)
const Profile = lazy(loaders.profile)
const Settings = lazy(loaders.settings)
const Games = lazy(loaders.games)
const More = lazy(loaders.more)
const Admin = lazy(loaders.admin)

/* The routes students open most often after Home, fetched while the browser is idle. */
const PREFETCH: (keyof typeof loaders)[] = ['goals', 'stats', 'tools', 'tutor', 'chat']

/* Pointing at or focusing a page icon starts loading that page, so the click rarely waits. */
function warm(screen: Screen) {
  if (screen in loaders) void loaders[screen as keyof typeof loaders]().catch(() => undefined)
}

/* #admin is not a navigation screen: it only renders for accounts the server accepts as admins. */
function isAdminRoute() {
  return window.location.hash.replace('#', '').split('?')[0] === 'admin'
}

function currentScreen(): Screen {
  const raw = window.location.hash.replace('#', '').split('?')[0]
  const hash = (SCREEN_ALIASES[raw] ?? raw) as Screen
  return SCREENS.includes(hash) ? hash : 'home'
}

type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void }

function whenIdle(callback: () => void, timeout = 1500) {
  const idle = window as IdleWindow
  if (idle.requestIdleCallback) {
    const handle = idle.requestIdleCallback(callback, { timeout })
    return () => idle.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, 400)
  return () => window.clearTimeout(handle)
}

/* The sketch's row of tiny page icons, top-left of the main area. */
const PAGE_ICONS: { id: Screen; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'goals', label: 'Tasks' },
  { id: 'stats', label: 'Project statistics' },
  { id: 'tools', label: 'Study' },
  { id: 'tutor', label: 'Otto, your tutor' },
  { id: 'chat', label: 'Messages' },
  { id: 'profile', label: 'Friends & groups' },
]

const RAIL_KEY = 'bindit:sidebar:collapsed'

/* The student's own choice, if they ever made one. */
function readRailChoice(): boolean | null {
  try {
    const value = localStorage.getItem(RAIL_KEY)
    return value === 'true' ? true : value === 'false' ? false : null
  } catch {
    return null
  }
}

const TYPING_FIELD = 'textarea, select, [contenteditable="true"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="file"]):not([type="color"])'

/*
 * Phones: while a text field has focus the on-screen keyboard is (or is about to be) open.
 * html.is-typing hides the bottom tab bar so the field sits right above the keys, and
 * --keyboard-inset is the height the keyboard still covers when the browser does not
 * shrink the page for it (iOS Safari), so fixed message boxes can lift above it.
 */
function useKeyboardAwareness() {
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 860px)')
    const root = document.documentElement
    const viewport = window.visualViewport
    const measure = () => {
      if (!viewport || !root.classList.contains('is-typing')) {
        root.style.removeProperty('--keyboard-inset')
        return
      }
      const covered = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
      root.style.setProperty('--keyboard-inset', `${covered}px`)
    }
    // A focused field that is removed (a dialog closing) fires no focusout: watch for that while typing.
    const removal = new MutationObserver(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) window.setTimeout(sync, 0)
    })
    const sync = () => {
      const active = document.activeElement
      const typing = phone.matches && active instanceof HTMLElement && active.matches(TYPING_FIELD) && !active.matches(':disabled, [readonly]')
      root.classList.toggle('is-typing', typing)
      removal.disconnect()
      if (typing) removal.observe(document.body, { childList: true, subtree: true })
      measure()
    }
    // focusout fires before the next field gains focus, so wait a frame before deciding.
    const later = () => window.setTimeout(sync, 0)
    document.addEventListener('focusin', sync)
    document.addEventListener('focusout', later)
    viewport?.addEventListener('resize', sync)
    phone.addEventListener('change', sync)
    return () => {
      document.removeEventListener('focusin', sync)
      document.removeEventListener('focusout', later)
      viewport?.removeEventListener('resize', sync)
      removal.disconnect()
      phone.removeEventListener('change', sync)
      root.classList.remove('is-typing')
      root.style.removeProperty('--keyboard-inset')
    }
  }, [])
}

function AppShell() {
  const [screen, setScreen] = useState(currentScreen)
  // The nav highlight follows the click at once; the page itself swaps in a transition.
  const [navScreen, setNavScreen] = useState(currentScreen)
  const [adminRoute, setAdminRoute] = useState(isAdminRoute)
  const [notice, setNotice] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const { session, setSession } = useAuth()
  const [railChoice, setRailChoice] = useState(readRailChoice)
  const [unread, setUnread] = useState(0)
  // Until the student chooses, Project statistics opens with the rail merged (as drawn); other pages open it.
  const railCollapsed = railChoice ?? navScreen === 'stats'
  const setRailCollapsed = useCallback((value: boolean) => {
    setRailChoice(value)
    try {
      localStorage.setItem(RAIL_KEY, String(value))
    } catch {
      // Storage can be unavailable; the choice still applies for this visit.
    }
  }, [])
  const closeCommand = useCallback(() => setCommandOpen(false), [])
  const openCommand = useCallback(() => setCommandOpen(true), [])

  useEffect(() => {
    rememberPage(currentScreen())
    const sync = () => {
      setNavScreen(currentScreen())
      setAdminRoute(isAdminRoute())
      if (!isAdminRoute()) rememberPage(currentScreen())
      startTransition(() => setScreen(currentScreen()))
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [])

  useKeyboardAwareness()

  useEffect(() => {
    const studentId = session?.user.id ?? getStudentId()
    void recordDailyLogin(studentId, session?.access_token).catch(() => undefined)
  }, [session?.user.id, session?.access_token])

  // A new account without a bindet profile (a first Google sign-in) is taken to Settings
  // once per device to choose a name and username; Home and Friends & groups keep a
  // reminder card until it's done. The flag is a bindit- key, so signing out clears it.
  const accessToken = session?.access_token
  const userId = session?.user.id
  useEffect(() => {
    if (!accessToken || !userId) return
    let live = true
    void getAccountProfile(accessToken).then((profile) => {
      if (!live || profile) return
      try {
        if (localStorage.getItem(PROFILE_SETUP_ROUTED_KEY) === userId) return
        localStorage.setItem(PROFILE_SETUP_ROUTED_KEY, userId)
      } catch {
        return
      }
      if (currentScreen() !== 'settings') window.location.hash = 'settings'
    }).catch(() => undefined)
    return () => { live = false }
  }, [accessToken, userId])

  // Warm the next likely screens and the group list after Home has painted.
  useEffect(() => whenIdle(() => {
    for (const key of PREFETCH) void loaders[key]().catch(() => undefined)
    if (session?.access_token) void getStudyGroups(session.access_token).catch(() => undefined)
  }), [session?.access_token])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  return (
    <div className={`app-shell${railCollapsed ? ' is-rail-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      <SiteSidebar active={navScreen} session={session} onOpenCommand={openCommand} collapsed={railCollapsed} onCollapsedChange={setRailCollapsed} onUnreadChange={setUnread} commandOpen={commandOpen} />
      <header className="app-bar">
        <nav className="app-bar__pages" aria-label="Pages">
          {PAGE_ICONS.map((item) => {
            const current = navScreen === item.id
            return (
              <a key={item.id} className={`app-bar__page${current ? ' is-active' : ''}`} href={`#${item.id}`} aria-current={current ? 'page' : undefined} aria-label={item.id === 'chat' && unread ? `${item.label}, ${unread} unread` : item.label} title={item.label} onPointerEnter={() => warm(item.id)} onFocus={() => warm(item.id)}>
                <NavIcon kind={item.id} />
                {item.id === 'chat' && unread ? <i className="app-bar__dot" aria-hidden="true" /> : null}
              </a>
            )
          })}
        </nav>
        <div className="app-bar__panels">
          <button type="button" className="app-bar__merge" aria-pressed={railCollapsed} onClick={() => setRailCollapsed(true)} title="Merge the sidebar into the icon strip">Merge</button>
          <button type="button" className="app-bar__expand" aria-label="Expand sidebar" aria-pressed={!railCollapsed} title="Expand sidebar" onClick={() => setRailCollapsed(false)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5" /></svg>
          </button>
        </div>
      </header>
      <main className={`sheet is-${adminRoute ? 'admin' : screen}`} id="main-content" tabIndex={-1} key={adminRoute ? 'admin' : screen}>
        {screen !== 'tools' && !adminRoute ? <OfflineNotice /> : null}
        <Suspense fallback={<PageSkeleton sketch={!adminRoute && (screen === 'goals' || screen === 'stats')} />}>
          {adminRoute ? <Admin session={session} /> : null}
          {!adminRoute && screen === 'home' ? <Home session={session} /> : null}
          {screen === 'tools' ? <Tools accessToken={session?.access_token} /> : null}
          {screen === 'tutor' ? <Tutor session={session} /> : null}
          {screen === 'goals' ? <Goals session={session} /> : null}
          {screen === 'stats' ? <ProjectStats session={session} /> : null}
          {screen === 'progress' ? <Progress session={session} /> : null}
          {screen === 'games' ? <Games session={session} /> : null}
          {screen === 'chat' ? <Chat session={session} /> : null}
          {screen === 'profile' ? <Profile session={session} onError={setNotice} /> : null}
          {screen === 'settings' ? <Settings session={session} onSession={setSession} /> : null}
          {screen === 'more' ? <More session={session} /> : null}
        </Suspense>
      </main>
      {notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      <CommandPalette open={commandOpen} onClose={closeCommand} />
    </div>
  )
}

/*
 * Matches the page frame so the swap does not jump: a ruled header and panels for the standard
 * pages; for the sketch pages (Tasks, Project statistics) a small title and open blocks, no rule.
 */
function PageSkeleton({ sketch = false }: { sketch?: boolean }) {
  return (
    <div className={`app-skeleton ui-page${sketch ? ' is-sketch' : ''}`} aria-busy="true" aria-label="Loading page">
      <div className="app-skeleton__header"><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
      <div className="app-skeleton__body"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
    </div>
  )
}

function App() {
  return (
    <>
      <AuthGate>
        <AppShell />
      </AuthGate>
      <UpdatePrompt />
    </>
  )
}

export default App
