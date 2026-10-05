import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AUTH_SESSION_KEY,
  discardSession,
  loadAuthSession,
  msUntilRefresh,
  refreshAuthSession,
  refreshSessionIfDue,
  reloadSignedOut,
  requestPasswordReset,
  resendSignupConfirmation,
  saveAuthSession,
  signIn,
  signOutAndReload,
  signUp,
  takeAuthRedirect,
  takeResetRequested,
  updatePassword,
  verifyRedirectTokens,
  verifySignupCode,
  type AuthSession,
} from '../lib/auth'
import { AuthContext } from '../lib/AuthContext'
import { BrandMark } from '../lib/SiteSidebar'
import './GuestAuth.css'

type Mode = 'login' | 'signup' | 'reset'
type GateView = 'landing' | 'auth' | 'confirm'
// An email link that needs the person's attention before the app opens.
type LinkGate =
  | { kind: 'continue'; session: AuthSession }
  // confirmed is false when this browser did not ask for the reset link.
  | { kind: 'recovery'; session: AuthSession; confirmed: boolean }
  | { kind: 'other-account'; linkedEmail: string }
const MAX_REFRESH_RETRY_MS = 60_000
const RESEND_SECS = 60

// The landing page (and its demo and 3D scene) is only downloaded by signed-out visitors.
// Without a saved session the download starts as soon as this module runs, in parallel with the first render.
const loadLanding = () => import('./Landing').then((module) => ({ default: module.Landing }))
const landingRequest = typeof window !== 'undefined' && !loadAuthSession() ? loadLanding() : null
const Landing = lazy(() => landingRequest ?? loadLanding())

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
  const [redirect] = useState(takeAuthRedirect)
  const [session, setSession] = useState<AuthSession | null>(loadAuthSession)
  const [loading, setLoading] = useState(() => Boolean(session) || redirect.kind === 'tokens')
  const [linkGate, setLinkGate] = useState<LinkGate | null>(null)
  const [view, setView] = useState<GateView>(redirect.kind === 'error' ? 'auth' : 'landing')
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordAgain, setPasswordAgain] = useState('')
  const [code, setCode] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(redirect.kind === 'error' ? redirect.message : '')
  const sessionRef = useRef(session)
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
    sessionRef.current = session
  }, [session])

  // On load: refresh a stored session if it is due, then check any sign-in link
  // from the URL fragment with the auth server before it can be used.
  useEffect(() => {
    let cancelled = false
    async function start() {
      const stored = sessionRef.current
      // A rejected refresh has already cleared local data. Reload to the signed-out
      // page, unless an email link is waiting to be checked (reloading would lose it).
      const current = stored ? await refreshAuthSession(stored, { reloadOnReject: redirect.kind !== 'tokens' }) : null
      let gate: LinkGate | null = null
      let next = current
      let linkError = ''
      if (redirect.kind === 'tokens') {
        try {
          const linked = await verifyRedirectTokens(redirect)
          if (current && current.user.id !== linked.user.id) {
            // Never silently swap accounts: keep the signed-in one.
            discardSession(linked)
            gate = { kind: 'other-account', linkedEmail: linked.user.email ?? 'another account' }
          } else if (redirect.type === 'recovery') {
            gate = { kind: 'recovery', session: linked, confirmed: takeResetRequested() }
          } else if (current) {
            saveAuthSession(linked)
            next = linked
          } else {
            gate = { kind: 'continue', session: linked }
          }
        } catch {
          linkError = 'That link is invalid or has expired. Request a new one and try again.'
        }
      }
      if (cancelled) return
      setSession(next)
      setLinkGate(gate)
      if (linkError && !next) {
        setError(linkError)
        setView('auth')
      }
      setLoading(false)
    }
    void start()
    return () => {
      cancelled = true
    }
  }, [redirect])

  // Keep the session fresh: refresh about a minute before the access token
  // expires, retry with backoff when offline, and check again on return to the tab.
  useEffect(() => {
    if (!session || loading) return
    let cancelled = false
    let timer = 0
    let failures = 0
    const schedule = (delay: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), Math.min(delay, 2_147_000_000))
    }
    const run = async () => {
      const result = await refreshSessionIfDue(session)
      if (cancelled) return
      if (result.failed) {
        failures += 1
        schedule(Math.min(MAX_REFRESH_RETRY_MS, 2_000 * 2 ** failures))
        return
      }
      failures = 0
      if (result.rejected) {
        reloadSignedOut()
        return
      }
      if (!result.session || result.session.access_token !== session.access_token) {
        setSession(result.session)
        return
      }
      schedule(msUntilRefresh(session))
    }
    const wake = () => {
      if (document.visibilityState === 'visible') schedule(0)
    }
    schedule(msUntilRefresh(session))
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
    }
  }, [session, loading])

  // Follow sign-in, refresh and sign-out from other tabs.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== AUTH_SESSION_KEY)) return
      const current = sessionRef.current
      const stored = loadAuthSession()
      if (current && (!stored || stored.user.id !== current.user.id)) {
        // Signed out or switched accounts elsewhere: drop everything in memory.
        window.location.reload()
        return
      }
      if (stored && stored.access_token !== current?.access_token) setSession(stored)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
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
    setPasswordAgain('')
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

  if (linkGate?.kind === 'other-account') {
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="auth-title">
          <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
          <AuthBrand />
          <p className="auth-eyebrow">Different account</p>
          <h1 className="auth-title" id="auth-title">You’re already signed in</h1>
          <p className="auth-lead">
            That link was for {linkGate.linkedEmail}, but this browser is signed in as {session?.user.email ?? 'another account'}. We kept you signed in.
            To use {linkGate.linkedEmail}, sign out first and request a new link.
          </p>
          <button className="auth-submit" type="button" onClick={() => setLinkGate(null)}>
            Continue as {session?.user.email ?? 'current account'}
          </button>
          <div className="auth-links">
            <button className="auth-text-btn" type="button" onClick={() => signOutAndReload()}>
              Sign out
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (linkGate?.kind === 'continue') {
    const linked = linkGate.session
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="auth-title">
          <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
          <AuthBrand />
          <p className="auth-eyebrow">Email confirmed</p>
          <h1 className="auth-title" id="auth-title">Continue as {linked.user.email ?? 'this account'}?</h1>
          <p className="auth-lead">You opened a sign-in link for this account. Continue only if it’s yours.</p>
          <button
            className="auth-submit"
            type="button"
            onClick={() => {
              saveAuthSession(linked)
              setLinkGate(null)
              setSession(linked)
            }}
          >
            Continue
          </button>
          <div className="auth-links">
            <button
              className="auth-text-btn"
              type="button"
              onClick={() => {
                discardSession(linked)
                setLinkGate(null)
              }}
            >
              Not me
            </button>
          </div>
        </section>
      </main>
    )
  }

  if (linkGate?.kind === 'recovery') {
    const recovering = linkGate.session
    const recoveringEmail = recovering.user.email ?? 'this account'
    // Revokes only the link's own session; a signed-in session is untouched.
    const declineRecovery = () => {
      discardSession(recovering)
      setLinkGate(null)
      setPassword('')
      setPasswordAgain('')
      setError('')
    }
    if (!linkGate.confirmed) {
      return (
        <main className="auth">
          <section className="auth-card" aria-labelledby="auth-title">
            <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <AuthBrand />
            <p className="auth-eyebrow">Reset password</p>
            <h1 className="auth-title" id="auth-title">Reset the password for {recoveringEmail}?</h1>
            <p className="auth-lead">You opened a password reset link for this account. Continue only if it’s yours and you asked for it.</p>
            <button className="auth-submit" type="button" onClick={() => setLinkGate({ ...linkGate, confirmed: true })}>
              Continue
            </button>
            <div className="auth-links">
              <button className="auth-text-btn" type="button" onClick={declineRecovery}>
                Not me
              </button>
            </div>
          </section>
        </main>
      )
    }
    async function submitNewPassword(event: FormEvent) {
      event.preventDefault()
      setError('')
      if (password.length < 8) {
        setError('Use at least 8 characters for your password.')
        return
      }
      if (password !== passwordAgain) {
        setError('Those passwords don’t match.')
        return
      }
      setBusy(true)
      try {
        const next = await updatePassword(recovering, password)
        saveAuthSession(next)
        setPassword('')
        setPasswordAgain('')
        setLinkGate(null)
        setSession(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update your password.')
      } finally {
        setBusy(false)
      }
    }
    return (
      <main className="auth">
        <section className="auth-card" aria-labelledby="auth-title">
          <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
          <AuthBrand />
          <p className="auth-eyebrow">Reset password</p>
          <h1 className="auth-title" id="auth-title">Set a new password</h1>
          <p className="auth-reason" role="status">
            <strong>This link is for {recoveringEmail}.</strong> Not you?{' '}
            <button className="auth-text-btn" type="button" disabled={busy} onClick={declineRecovery}>
              Not me
            </button>
          </p>
          <p className="auth-lead">Use at least 8 characters.</p>
          <form className="auth-form" onSubmit={submitNewPassword}>
            <label className="auth-field">
              <span>New password</span>
              <div className="auth-pass">
                <input
                  className="auth-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  minLength={8}
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
            <label className="auth-field">
              <span>Confirm new password</span>
              <input
                className="auth-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                minLength={8}
                required
                disabled={busy}
                value={passwordAgain}
                onChange={(event) => setPasswordAgain(event.target.value)}
              />
            </label>
            {error ? <div className="auth-feedback is-error" role="alert">{error}</div> : null}
            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save password and enter'}
            </button>
          </form>
          <div className="auth-links">
            <button
              className="auth-text-btn"
              type="button"
              disabled={busy}
              onClick={declineRecovery}
            >
              Cancel
            </button>
          </div>
        </section>
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
        if (mode === 'reset') {
          await requestPasswordReset(trimmed)
          setMessage(`If ${trimmed} has a bindit account, we sent it a link to set a new password.`)
        } else if (mode === 'login') {
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
            <p className="auth-eyebrow">{mode === 'login' ? 'Welcome back' : mode === 'reset' ? 'Forgot password' : 'Start studying'}</p>
            <h1 className="auth-title" id="auth-title">{mode === 'login' ? 'Log in' : mode === 'reset' ? 'Reset your password' : 'Create your account'}</h1>
            {mode === 'reset' ? <p className="auth-lead">Enter your email and we’ll send you a link to set a new password.</p> : null}
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
              {mode !== 'reset' ? <label className="auth-field">
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
              </label> : null}
              {mode === 'signup' && password ? (
                <div className={`auth-strength is-${Math.max(1, passwordScore)}`}>
                  <div>{[0, 1, 2, 3].map((index) => <span key={index} className={index < passwordScore ? 'is-on' : ''} />)}</div>
                  <small>{passwordScore <= 1 ? 'Make it stronger' : passwordScore === 2 ? 'Good password' : 'Strong password'}</small>
                </div>
              ) : null}
              {error ? <div className="auth-feedback is-error" role="alert">{error}</div> : null}
              {message ? <div className="auth-feedback is-ok" role="status">{message}</div> : null}
              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? (mode === 'login' ? 'Logging in…' : mode === 'reset' ? 'Sending…' : 'Creating account…') : mode === 'login' ? 'Log in' : mode === 'reset' ? 'Send reset link' : 'Create account'}
              </button>
            </form>
            {mode === 'login' ? (
              <div className="auth-links">
                <button className="auth-text-btn" type="button" disabled={busy} onClick={() => switchMode('reset')}>
                  Forgot password?
                </button>
              </div>
            ) : null}
            {mode === 'reset' ? (
              <p className="auth-switch">
                Remembered it?{' '}
                <button className="auth-text-btn" type="button" disabled={busy} onClick={() => switchMode('login')}>Back to log in</button>
              </p>
            ) : (
              <p className="auth-switch">
                {mode === 'login' ? 'New to bindit?' : 'Already have an account?'}{' '}
                <button className="auth-text-btn" type="button" disabled={busy} onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in'}</button>
              </p>
            )}
          </section>
          <AuthAside mode={mode === 'reset' ? 'login' : mode} />
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
