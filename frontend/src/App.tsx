import { lazy, startTransition, Suspense, useCallback, useEffect, useState } from 'react'
import { AuthGate } from './components/AuthGate'
import { CommandPalette } from './components/CommandPalette'
import { useAuth } from './lib/AuthContext'
import { getStudyGroups, recordDailyLogin } from './lib/api'
import { SCREEN_ALIASES, SCREENS, type Screen } from './lib/screens'
import { getStudentId } from './lib/session'
import { SiteSidebar } from './lib/SiteSidebar'
import { Home } from './pages/Home'
import './App.css'

const loaders = {
  tools: () => import('./pages/Tools').then((module) => ({ default: module.Tools })),
  tutor: () => import('./pages/Tutor').then((module) => ({ default: module.Tutor })),
  goals: () => import('./pages/Goals').then((module) => ({ default: module.Goals })),
  progress: () => import('./pages/Progress').then((module) => ({ default: module.Progress })),
  chat: () => import('./pages/Chat').then((module) => ({ default: module.Chat })),
  profile: () => import('./pages/Profile').then((module) => ({ default: module.Profile })),
  settings: () => import('./pages/Settings').then((module) => ({ default: module.Settings })),
  games: () => import('./pages/Games').then((module) => ({ default: module.Games })),
  more: () => import('./pages/More').then((module) => ({ default: module.More })),
}

const Tools = lazy(loaders.tools)
const Tutor = lazy(loaders.tutor)
const Goals = lazy(loaders.goals)
const Progress = lazy(loaders.progress)
const Chat = lazy(loaders.chat)
const Profile = lazy(loaders.profile)
const Settings = lazy(loaders.settings)
const Games = lazy(loaders.games)
const More = lazy(loaders.more)

/* The routes students open most often after Home, fetched while the browser is idle. */
const PREFETCH: (keyof typeof loaders)[] = ['tools', 'goals', 'tutor', 'chat']

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

function AppShell() {
  const [screen, setScreen] = useState(currentScreen)
  // The nav highlight follows the click at once; the page itself swaps in a transition.
  const [navScreen, setNavScreen] = useState(currentScreen)
  const [notice, setNotice] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const { session, setSession } = useAuth()
  const closeCommand = useCallback(() => setCommandOpen(false), [])
  const openCommand = useCallback(() => setCommandOpen(true), [])

  useEffect(() => {
    const sync = () => {
      setNavScreen(currentScreen())
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

  useEffect(() => {
    const studentId = session?.user.id ?? getStudentId()
    void recordDailyLogin(studentId, session?.access_token).catch(() => undefined)
  }, [session?.user.id, session?.access_token])

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
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to content</a>
      <SiteSidebar active={navScreen} session={session} onOpenCommand={openCommand} />
      <main className={`sheet is-${screen}`} id="main-content" tabIndex={-1} key={screen}>
        <Suspense fallback={<PageSkeleton />}>
          {screen === 'home' ? <Home session={session} /> : null}
          {screen === 'tools' ? <Tools accessToken={session?.access_token} /> : null}
          {screen === 'tutor' ? <Tutor session={session} /> : null}
          {screen === 'goals' ? <Goals session={session} /> : null}
          {screen === 'progress' ? <Progress session={session} /> : null}
          {screen === 'games' ? <Games /> : null}
          {screen === 'chat' ? <Chat session={session} /> : null}
          {screen === 'profile' ? <Profile session={session} onError={setNotice} /> : null}
          {screen === 'settings' ? <Settings session={session} onSession={setSession} /> : null}
          {screen === 'more' ? <More /> : null}
        </Suspense>
      </main>
      {notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      <CommandPalette open={commandOpen} onClose={closeCommand} />
    </div>
  )
}

/* Matches the page frame (header rule, then content) so the swap does not jump. */
function PageSkeleton() {
  return (
    <div className="app-skeleton ui-page" aria-busy="true" aria-label="Loading page">
      <div className="app-skeleton__header"><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
      <div className="app-skeleton__body"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
    </div>
  )
}

function App() {
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  )
}

export default App
