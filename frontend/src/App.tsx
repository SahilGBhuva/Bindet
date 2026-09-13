import { useEffect, useState } from 'react'
import { AuthGate } from './components/AuthGate'
import { useAuth } from './lib/AuthContext'
import { SCREENS, SiteSidebar, type Screen } from './lib/SiteSidebar'
import { recordDailyLogin } from './lib/api'
import { getStudentId } from './lib/session'
import { Home } from './pages/Home'
import { Tools } from './pages/Tools'
import { Progress } from './pages/Progress'
import { Games } from './pages/Games'
import { Goals } from './pages/Goals'
import { Profile } from './pages/Profile'
import { Settings } from './pages/Settings'
import { More } from './pages/More'
// Home.css still styles Tools plus the avatar and file input used on Profile, so it stays global
// until those pages are redesigned.
import './pages/Home.css'
import './styles/ui.css'
import './App.css'

function currentScreen(): Screen {
  const raw = window.location.hash.replace('#', '')
  const hash = (raw === 'quests' ? 'goals' : raw) as Screen
  return SCREENS.includes(hash) ? hash : 'home'
}

function AppShell() {
  const [screen, setScreen] = useState(currentScreen)
  const [notice, setNotice] = useState('')
  const { session, setSession } = useAuth()

  useEffect(() => {
    const sync = () => setScreen(currentScreen())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    const studentId = session?.user.id ?? getStudentId()
    void recordDailyLogin(studentId, session?.access_token).catch(() => undefined)
  }, [session?.user.id, session?.access_token])

  return (
    <div className="app-shell">
      <SiteSidebar active={screen} />
      <main className={`sheet is-${screen}`}>
        {screen === 'home' ? <Home session={session} /> : null}
        {screen === 'tools' ? <Tools accessToken={session?.access_token} /> : null}
        {screen === 'progress' ? <Progress session={session} /> : null}
        {screen === 'games' ? <Games /> : null}
        {screen === 'goals' ? <Goals /> : null}
        {screen === 'profile' ? <Profile session={session} onError={setNotice} /> : null}
        {screen === 'settings' ? <Settings session={session} onSession={setSession} /> : null}
        {screen === 'more' ? <More /> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
      </main>
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
