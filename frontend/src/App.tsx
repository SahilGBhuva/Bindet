import { lazy, Suspense } from 'react'
// AppPrompts first: its stylesheet comes before the sidebar's, as it always has.
import { UpdatePrompt } from './components/AppPrompts'
import { AuthGate } from './components/AuthGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LiveAnnouncer } from './components/LiveAnnouncer'
import { loadAuthSession } from './lib/auth'
import { BrandMark } from './lib/BrandMark'
// The signed-in app's stylesheets stay in the entry stylesheet, in their original order,
// so moving its code into a lazy chunk changes nothing about the cascade.
import './components/CommandPalette.css'
import './components/onboarding/GetStarted.css'
import './components/HelpBot.css'
import './pages/Home.css'
import './App.css'

// The signed-in app (shell, Home, sidebar data) is only downloaded once there is a session.
// With a saved session the download starts as soon as this module runs, while the session
// is still being checked, so returning students don't wait on an extra round trip.
const loadSignedInApp = () => import('./SignedInApp').then((module) => ({ default: module.SignedInApp }))
const signedInRequest = typeof window !== 'undefined' && loadAuthSession() ? loadSignedInApp() : null
const SignedInApp = lazy(() => signedInRequest ?? loadSignedInApp())

function App() {
  return (
    <>
      <ErrorBoundary label="bindet">
        <AuthGate>
          <Suspense fallback={<div className="onb-loading" role="status" aria-label="Opening bindet"><BrandMark size={32} /></div>}>
            <SignedInApp />
          </Suspense>
        </AuthGate>
      </ErrorBoundary>
      <UpdatePrompt />
      <LiveAnnouncer />
    </>
  )
}

export default App
