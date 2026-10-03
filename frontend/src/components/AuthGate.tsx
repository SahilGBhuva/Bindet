import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  consumeAuthRedirectSession,
  loadAuthSession,
  refreshAuthSession,
  resendSignupConfirmation,
  signIn,
  signUp,
  verifySignupCode,
  type AuthSession,
} from '../lib/auth'
import { AuthContext } from '../lib/AuthContext'
import { BrandMark } from '../lib/SiteSidebar'
import './GuestAuth.css'

type Mode = 'login' | 'signup'
type GateView = 'landing' | 'auth' | 'confirm'
const RESEND_SECS = 60

// The landing page (and its demo and 3D scene) is only downloaded by signed-out visitors.
const Landing = lazy(() => import('./Landing').then((module) => ({ default: module.Landing })))

/* The quiet editorial panel beside the form: loose notes drawn together on one spine. */
function AuthAside({ mode }: { mode: 'login' | 'signup' | 'confirm' }) {
  return (
    <aside className="auth-aside" aria-hidden="true">
      <div className="auth-aside__art">
        <svg viewBox="0 0 360 300" className="auth-aside__svg">
          <path className="auth-thread" d="M180 40 C120 70 70 90 60 150 M180 40 C230 80 300 90 300 150 M180 40 L180 260 M60 150 C90 200 140 230 180 260 M300 150 C270 200 220 230 180 260" />
          <rect className="auth-sheet" x="30" y="122" width="62" height="78" rx="4" transform="rotate(-6 61 161)" />
          <rect className="auth-sheet" x="268" y="118" width="62" height="78" rx="4" transform="rotate(5 299 157)" />
          <rect className="auth-sheet is-card" x="146" y="226" width="68" height="46" rx="4" />
          <rect className="auth-sheet is-spine" x="158" y="18" width="44" height="46" rx="5" />
          <circle className="auth-node" cx="60" cy="150" r="4" /><circle className="auth-node" cx="300" cy="150" r="4" /><circle className="auth-node" cx="180" cy="260" r="4" /><circle className="auth-node is-brand" cx="180" cy="40" r="5" />
        </svg>
      </div>
      <p className="auth-aside__quote">{mode === 'login' ? 'Pick up exactly where you left off.' : mode === 'confirm' ? 'One step left. Your workspace is ready.' : 'Notes, assignments, and practice, bound into one place.'}</p>
      <ol className="auth-aside__steps">
        <li><b>01</b>Add notes and materials</li>
        <li><b>02</b>Bind them into courses and units</li>
        <li><b>03</b>Generate grounded study sets</li>
        <li><b>04</b>Practice and track mastery</li>
      </ol>
    </aside>
  )
}

function AuthBrand() {
  return (
    <span className="auth-brand">
      <BrandMark size={24} />
      bindit
    </span>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [initialSession] = useState<AuthSession | null>(() => consumeAuthRedirectSession() ?? loadAuthSession())
  const [session, setSession] = useState<AuthSession | null>(initialSession)
  const [loading, setLoading] = useState(Boolean(initialSession))
  const [view, setView] = useState<GateView>('landing')
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingEmail, setPendingEmail] = useState('')
  const [resendIn, setResendIn] = useState(0)
  // Why sign-up opened, when it came from a locked action in the landing page demo.
  const [signupReason, setSignupReason] = useState('')

  useEffect(() => {
    localStorage.removeItem('bindit-guest-mode')
  }, [])

  const passwordScore = useMemo(() => {
    let score = 0
    if (password.length >= 8) score += 1
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1
    if (/\d/.test(password)) score += 1
    if (/[^A-Za-z0-9]/.test(password)) score += 1
    return score
  }, [password])

  useEffect(() => {
    if (!initialSession) return
    void refreshAuthSession(initialSession).then((next) => {
      setSession(next)
      setLoading(false)
    })
  }, [initialSession])

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [resendIn])

  function openAuth(nextMode: Mode = 'signup', reason = '') {
    setSignupReason(reason)
    setMode(nextMode)
    setView('auth')
    setError('')
    setMessage('')
  }

  function switchMode(nextMode: Mode) {
    setSignupReason('')
    setMode(nextMode)
    setError('')
    setMessage('')
    setPassword('')
    setShowPassword(false)
  }

  function startConfirm(nextEmail: string, note: string) {
    setPendingEmail(nextEmail)
    setCode('')
    setMessage(note)
    setError('')
    setResendIn(RESEND_SECS)
    setView('confirm')
  }

  async function sendCodeAgain() {
    if (resendIn > 0 || busy || !pendingEmail) return
    setBusy(true)
    setError('')
    try {
      await resendSignupConfirmation(pendingEmail)
      setResendIn(RESEND_SECS)
      setMessage('A new code is on the way. Check your inbox in about a minute if it is not here yet.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <main className="auth auth--loading">
        <div className="auth-loading" role="status">
          <BrandMark size={32} />
          <p>Opening your workspace…</p>
        </div>
      </main>
    )
  }

  if (!session) {
    async function submit(event: FormEvent) {
      event.preventDefault()
      setBusy(true)
      setError('')
      setMessage('')
      const trimmed = email.trim()
      try {
        if (mode === 'login') {
          try {
            setSession(await signIn(trimmed, password))
          } catch (err) {
            const text = err instanceof Error ? err.message : ''
            if (/confirm|not confirmed|verify/i.test(text)) {
              startConfirm(trimmed, 'Confirm your email with the code we sent, then you can get in.')
              return
            }
            throw err
          }
        } else {
          if (password.length < 8) {
            setError('Use at least 8 characters for your password.')
            return
          }
          const result = await signUp(trimmed, password)
          if (result.session) setSession(result.session)
          else startConfirm(trimmed, 'Enter the code from your email. If it does not arrive, you can resend after 1 minute.')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'We couldn’t complete that request. Try again.')
      } finally {
        setBusy(false)
      }
    }

    async function submitCode(event: FormEvent) {
      event.preventDefault()
      setBusy(true)
      setError('')
      try {
        setSession(await verifySignupCode(pendingEmail, code.trim()))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That code did not work.')
      } finally {
        setBusy(false)
      }
    }

    if (view === 'confirm') {
      return (
        <main className="auth">
          <section className="auth-card" aria-labelledby="auth-title">
            <AuthBrand />
            <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <p className="auth-eyebrow">Confirm email</p>
            <h1 className="auth-title" id="auth-title">Check your inbox</h1>
            <p className="auth-lead">We sent a code to {pendingEmail}. Paste it below. You can resend after 1 minute if it never shows up.</p>
            <form className="auth-form" onSubmit={submitCode}>
              <label className="auth-field">
                <span>Confirmation code</span>
                <input
                  className="auth-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  required
                  disabled={busy}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              {error ? <div className="auth-feedback is-error" role="alert">{error}</div> : null}
              {message ? <div className="auth-feedback is-ok" role="status">{message}</div> : null}
              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Confirm and enter'}
              </button>
            </form>
            <div className="auth-links">
              <button className="auth-text-btn" type="button" disabled={busy || resendIn > 0} onClick={() => void sendCodeAgain()}>
                {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
              </button>
              <button className="auth-text-btn" type="button" disabled={busy} onClick={() => setView('auth')}>
                Back to sign in
              </button>
            </div>
          </section>
          <AuthAside mode="confirm" />
        </main>
      )
    }

    if (view === 'auth') {
      return (
        <main className="auth">
          <section className="auth-card" aria-labelledby="auth-title">
            <div className="auth-card__top">
              <AuthBrand />
              <button className="auth-text-btn auth-back" type="button" onClick={() => setView('landing')}>
                ← Back
              </button>
            </div>
            <p className="auth-eyebrow">{mode === 'login' ? 'Welcome back' : 'Start studying'}</p>
            <h1 className="auth-title" id="auth-title">{mode === 'login' ? 'Log in' : 'Create your account'}</h1>
            {mode === 'signup' && signupReason ? (
              <p className="auth-reason" role="status">
                <strong>“{signupReason.replace(/^\+\s*/, '')}”</strong> works in the full app. Create an account to use it with your own courses and notes.
              </p>
            ) : null}
            <form className="auth-form" onSubmit={submit}>
              <label className="auth-field">
                <span>Email</span>
                <input className="auth-input" type="email" autoComplete="email" placeholder="you@school.edu" required disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="auth-field">
                <span>Password</span>
                <div className="auth-pass">
                  <input
                    className="auth-input"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={mode === 'signup' ? 8 : 6}
                    required
                    disabled={busy}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button type="button" disabled={busy} onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              {mode === 'signup' && password ? (
                <div className={`auth-strength is-${Math.max(1, passwordScore)}`}>
                  <div>{[0, 1, 2, 3].map((index) => <span key={index} className={index < passwordScore ? 'is-on' : ''} />)}</div>
                  <small>{passwordScore <= 1 ? 'Make it stronger' : passwordScore === 2 ? 'Good password' : 'Strong password'}</small>
                </div>
              ) : null}
              {error ? <div className="auth-feedback is-error" role="alert">{error}</div> : null}
              {message ? <div className="auth-feedback is-ok" role="status">{message}</div> : null}
              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? (mode === 'login' ? 'Logging in…' : 'Creating account…') : mode === 'login' ? 'Log in' : 'Create account'}
              </button>
            </form>
            <p className="auth-switch">
              {mode === 'login' ? 'New to bindit?' : 'Already have an account?'}{' '}
              <button className="auth-text-btn" type="button" disabled={busy} onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in'}</button>
            </p>
          </section>
          <AuthAside mode={mode} />
        </main>
      )
    }

    return (
      <Suspense fallback={<div className="auth-backdrop" aria-hidden="true" />}>
        <Landing onSignUp={(reason) => openAuth('signup', reason)} onLogIn={() => openAuth('login')} />
      </Suspense>
    )
  }

  return <AuthContext.Provider value={{ session, setSession }}>{children}</AuthContext.Provider>
}
