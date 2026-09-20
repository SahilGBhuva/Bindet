import { lazy, startTransition, Suspense, useCallback, useEffect, useState } from 'react'
import { AuthGate } from './components/AuthGate'
import { CommandPalette } from './components/CommandPalette'
import { useAuth } from './lib/AuthContext'
import { SCREENS, SiteSidebar, type Screen } from './lib/SiteSidebar'
import { recordDailyLogin } from './lib/api'
import { getStudentId } from './lib/session'
import { Home } from './pages/Home'
import './App.css'

const Tools = lazy(() => import('./pages/Tools').then((module) => ({ default: module.Tools })))
const Progress = lazy(() => import('./pages/Progress').then((module) => ({ default: module.Progress })))
const Games = lazy(() => import('./pages/Games').then((module) => ({ default: module.Games })))
const Goals = lazy(() => import('./pages/Goals').then((module) => ({ default: module.Goals })))
const Chat = lazy(() => import('./pages/Chat').then((module) => ({ default: module.Chat })))
const Profile = lazy(() => import('./pages/Profile').then((module) => ({ default: module.Profile })))
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })))
const More = lazy(() => import('./pages/More').then((module) => ({ default: module.More })))

function currentScreen(): Screen {
  const raw = window.location.hash.replace('#', '')
  const hash = (raw === 'quests' ? 'goals' : raw) as Screen
  return SCREENS.includes(hash) ? hash : 'home'
}

function AppShell() {
  const [screen, setScreen] = useState(currentScreen)
  const [notice, setNotice] = useState('')
  const [commandOpen, setCommandOpen] = useState(false)
  const { session, setSession } = useAuth()
  const closeCommand = useCallback(() => setCommandOpen(false), [])
  const openCommand = useCallback(() => setCommandOpen(true), [])

  useEffect(() => {
    const sync = () => startTransition(() => setScreen(currentScreen()))
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    const openCommand = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', openCommand)
    return () => window.removeEventListener('keydown', openCommand)
  }, [])

  useEffect(() => {
    const studentId = session?.user.id ?? getStudentId()
    void recordDailyLogin(studentId, session?.access_token).catch(() => undefined)
  }, [session?.user.id, session?.access_token])

  return (
    <div className="app-shell">
      <SiteSidebar active={screen} session={session} onOpenCommand={openCommand} />
      <main className={`sheet is-${screen}`}>
        <Suspense fallback={<PageSkeleton />}>
          {screen === 'home' ? <Home session={session} /> : null}
          {screen === 'tools' ? <Tools accessToken={session?.access_token} /> : null}
          {screen === 'progress' ? <Progress session={session} /> : null}
          {screen === 'games' ? <Games /> : null}
          {screen === 'goals' ? <Goals /> : null}
          {screen === 'chat' ? <Chat session={session} /> : null}
          {screen === 'profile' ? <Profile session={session} onError={setNotice} /> : null}
          {screen === 'settings' ? <Settings session={session} onSession={setSession} /> : null}
          {screen === 'more' ? <More /> : null}
          {notice ? <p className="notice" role="status">{notice}</p> : null}
        </Suspense>
      </main>
      <CommandPalette open={commandOpen} onClose={closeCommand} />
    </div>
  )
}

function PageSkeleton() {
  return <div className="app-skeleton" aria-label="Loading page"><span /><div><i /><i /><i /></div><section><i /><i /><i /><i /></section></div>
}

function App() {
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  )
}

export default App
