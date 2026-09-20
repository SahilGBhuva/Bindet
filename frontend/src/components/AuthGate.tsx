import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
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
import { ColorBackdrop, Landing } from './Landing'
import './GuestAuth.css'

type Mode = 'login' | 'signup'
type GateView = 'landing' | 'auth' | 'confirm'
const GUEST_KEY = 'bindit-guest-mode'
const RESEND_SECS = 60

function AuthBrand() {
  return (
    <span className="auth-brand">
      <img src="/bindit-mascot-cutout.webp" alt="" width="28" height="34" />
      bindit
    </span>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => consumeAuthRedirectSession() ?? loadAuthSession())
  const [loading, setLoading] = useState(Boolean(session))
  const [guestMode, setGuestMode] = useState(() => localStorage.getItem(GUEST_KEY) === '1')
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

  const passwordScore = useMemo(() => {
    let score = 0
    if (password.length >= 8) score += 1
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1
    if (/\d/.test(password)) score += 1
    if (/[^A-Za-z0-9]/.test(password)) score += 1
    return score
  }, [password])

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    void refreshAuthSession(session).then((next) => {
      setSession(next)
      setLoading(false)
    })
  }, [])

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

  function continueAsGuest() {
    localStorage.setItem(GUEST_KEY, '1')
    setGuestMode(true)
    setError('')
    setMessage('')
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
        <ColorBackdrop />
        <div className="auth-loading" role="status">
          <img className="auth-loading__mascot" src="/bindit-mascot-cutout.webp" alt="" width="120" height="144" />
          <p>Opening bindit…</p>
        </div>
      </main>
    )
  }

  if (!session && !guestMode) {
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
          <ColorBackdrop />
          <section className="auth-card" aria-labelledby="auth-title">
            <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <AuthBrand />
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
              <button className="lp-btn lp-btn--primary lp-btn--lg auth-submit" type="submit" disabled={busy}>
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
        </main>
      )
    }

    if (view === 'auth') {
      return (
        <main className="auth">
          <ColorBackdrop />
          <section className="auth-card" aria-labelledby="auth-title">
            <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <button className="auth-text-btn auth-back" type="button" onClick={() => setView('landing')}>
              ← Back to bindit
            </button>
            <AuthBrand />
            <p className="auth-eyebrow">{mode === 'login' ? 'Welcome back' : 'Start studying'}</p>
            <h1 className="auth-title" id="auth-title">{mode === 'login' ? 'Log in' : 'Create your account'}</h1>
            {mode === 'signup' && signupReason ? (
              <p className="auth-reason" role="status">
                <strong>“{signupReason.replace(/^\+\s*/, '')}”</strong> works in the full app. Create an account to use it with your own courses and notes.
              </p>
            ) : null}
            <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-on' : ''} disabled={busy} onClick={() => switchMode('login')}>
                Log in
              </button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-on' : ''} disabled={busy} onClick={() => switchMode('signup')}>
                Sign up
              </button>
            </div>
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
              <button className="lp-btn lp-btn--primary lp-btn--lg auth-submit" type="submit" disabled={busy}>
                {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Get started'}
              </button>
            </form>
            <div className="auth-guest-separator"><span>or</span></div>
            <button className="lp-btn lp-btn--quiet lp-btn--lg auth-guest" type="button" disabled={busy} onClick={continueAsGuest}>
              Continue as guest
            </button>
          </section>
        </main>
      )
    }

    return <Landing onSignUp={(reason) => openAuth('signup', reason)} onLogIn={() => openAuth('login')} onGuest={continueAsGuest} />
  }

  return <AuthContext.Provider value={{ session, setSession }}>{children}</AuthContext.Provider>
}
