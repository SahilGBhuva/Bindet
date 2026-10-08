import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AUTH_SESSION_KEY,
  AuthRequestError,
  EMAIL_TAKEN,
  discardSession,
  friendlyAuthError,
  exchangeOAuthCode,
  googleSignInEnabled,
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
  startGoogleSignIn,
  takeAccountNotice,
  takeAuthRedirect,
  resetRequestedFor,
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
  // via says whether the other account came from an email link or a Google sign-in.
  | { kind: 'other-account'; linkedEmail: string; via: 'link' | 'google' }
const MAX_REFRESH_RETRY_MS = 60_000
const RESEND_SECS = 60
// The email confirmation code is 6 digits (the auth server's OTP length); a full code submits itself.
const CODE_LENGTH = 6
const PASSWORD_MIN = 8

function emailTaken(error: unknown) {
  return error instanceof AuthRequestError && (error.code === EMAIL_TAKEN || error.code === 'user_already_exists')
}

function needsConfirmation(error: unknown) {
  if (error instanceof AuthRequestError && error.code === 'email_not_confirmed') return true
  return /confirm|not confirmed|verify/i.test(error instanceof Error ? error.message : '')
}

// The landing page (and its demo and 3D scene) is only downloaded by signed-out visitors.
// Without a saved session the download starts as soon as this module runs, in parallel with the first render.
const loadLanding = () => import('./Landing').then((module) => ({ default: module.Landing }))
const landingRequest = typeof window !== 'undefined' && !loadAuthSession() ? loadLanding() : null
const Landing = lazy(() => landingRequest ?? loadLanding())
// A one-time notice left by Settings before it signed out (account deleted, or sign in again to delete).
// Read once per page load, outside React, so a double render can't lose it.
const initialNotice = typeof window !== 'undefined' ? takeAccountNotice() : null

/* Google's own "G" mark in its brand colors, as its sign-in guidelines require. */
function GoogleMark() {
  return (
    <svg className="auth-google__mark" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

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
      bindet
    </span>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [redirect] = useState(takeAuthRedirect)
  const [session, setSession] = useState<AuthSession | null>(loadAuthSession)
  const [loading, setLoading] = useState(() => Boolean(session) || redirect.kind === 'tokens' || redirect.kind === 'oauth')
  const [linkGate, setLinkGate] = useState<LinkGate | null>(null)
  const [notice, setNotice] = useState(initialNotice)
  const [view, setView] = useState<GateView>(redirect.kind === 'error' || initialNotice === 'reauth-delete' ? 'auth' : 'landing')
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
  // Google sign-in shows only once the server says the provider is configured.
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [googleBusy, setGoogleBusy] = useState(false)
  // Sign-up hit an email that already has an account: offer Log in and Reset password.
  const [taken, setTaken] = useState(false)
  const codeInput = useRef<HTMLInputElement>(null)
  const emailInput = useRef<HTMLInputElement>(null)

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

  const signedOut = !session
  useEffect(() => {
    if (!signedOut) return
    let live = true
    void googleSignInEnabled().then((enabled) => {
      if (live) setGoogleEnabled(enabled)
    })
    return () => {
      live = false
    }
  }, [signedOut])

  // Coming back from Google with the Back button restores this page from the
  // back/forward cache with the button still busy; let it be pressed again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setGoogleBusy(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  // On load: refresh a stored session if it is due, then check any sign-in link
  // from the URL fragment with the auth server before it can be used.
  useEffect(() => {
    let cancelled = false
    async function start() {
      const stored = sessionRef.current
      // A rejected refresh has already cleared the session. Reload to the signed-out
      // page, unless an email link is waiting to be checked (reloading would lose it).
      const current = stored ? await refreshAuthSession(stored, { reloadOnReject: redirect.kind !== 'tokens' && redirect.kind !== 'oauth' }) : null
      let gate: LinkGate | null = null
      let next = current
      let linkError = ''
      if (redirect.kind === 'tokens') {
        try {
          const linked = await verifyRedirectTokens(redirect)
          if (current && current.user.id !== linked.user.id) {
            // Never silently swap accounts: keep the signed-in one.
            discardSession(linked)
            gate = { kind: 'other-account', linkedEmail: linked.user.email ?? 'another account', via: 'link' }
          } else if (redirect.type === 'recovery') {
            gate = { kind: 'recovery', session: linked, confirmed: resetRequestedFor(redirect) }
          } else if (current) {
            saveAuthSession(linked)
            next = linked
          } else {
            gate = { kind: 'continue', session: linked }
          }
        } catch {
          linkError = 'That link is invalid or has expired. Request a new one and try again.'
        }
      } else if (redirect.kind === 'oauth') {
        // The code was exchanged with this browser's own PKCE verifier, so this
        // browser started the sign-in: no extra confirmation is needed.
        try {
          const signedIn = await exchangeOAuthCode(redirect)
          if (current && current.user.id !== signedIn.user.id) {
            // Never silently swap accounts: keep the signed-in one.
            discardSession(signedIn)
            gate = { kind: 'other-account', linkedEmail: signedIn.user.email ?? 'another account', via: 'google' }
          } else {
            // saveAuthSession wipes another account's local data before storing this one.
            saveAuthSession(signedIn)
            next = signedIn
          }
        } catch (err) {
          linkError = err instanceof Error ? err.message : 'Google sign-in didn’t finish. Try again.'
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

  // The code field takes focus when the confirm step opens, so the code can be typed or pasted at once.
  useEffect(() => {
    if (view === 'confirm' && !session) codeInput.current?.focus()
  }, [view, session])

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
    setTaken(false)
    setError('')
    setMessage('')
    setPassword('')
    setPasswordAgain('')
    setShowPassword(false)
  }

  // resendNow: the code was sent earlier (a sign-in before confirming), so it may have expired.
  function startConfirm(nextEmail: string, note = '', resendNow = false) {
    setPendingEmail(nextEmail)
    setCode('')
    setMessage(note)
    setError('')
    setResendIn(resendNow ? 0 : RESEND_SECS)
    setView('confirm')
  }

  // Back from the code step to the form, with the email kept and ready to correct.
  function changeEmail() {
    setView('auth')
    setError('')
    setMessage('')
    setCode('')
    window.setTimeout(() => {
      emailInput.current?.focus()
      emailInput.current?.select()
    }, 0)
  }

  async function sendCodeAgain() {
    if (resendIn > 0 || busy || !pendingEmail) return
    setBusy(true)
    setError('')
    try {
      await resendSignupConfirmation(pendingEmail)
      setResendIn(RESEND_SECS)
      setCode('')
      setMessage('New code sent. Use the newest email; older codes stop working.')
    } catch (err) {
      setError(friendlyAuthError(err, 'We couldn’t send a new code. Try again in a minute.'))
    } finally {
      setBusy(false)
      window.setTimeout(() => codeInput.current?.focus(), 0)
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
          {linkGate.via === 'google' ? (
            <p className="auth-lead">
              You chose {linkGate.linkedEmail} with Google, but this browser is signed in as {session?.user.email ?? 'another account'}. We kept you signed in.
              To use {linkGate.linkedEmail}, sign out first and continue with Google again.
            </p>
          ) : (
            <p className="auth-lead">
              That link was for {linkGate.linkedEmail}, but this browser is signed in as {session?.user.email ?? 'another account'}. We kept you signed in.
              To use {linkGate.linkedEmail}, sign out first and request a new link.
            </p>
          )}
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
                  enterKeyHint="next"
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
                enterKeyHint="go"
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
      setTaken(false)
      const trimmed = email.trim()
      try {
        if (mode === 'reset') {
          await requestPasswordReset(trimmed)
          setMessage(`If ${trimmed} has a bindet account, we sent it a link to set a new password.`)
        } else if (mode === 'login') {
          try {
            setSession(await signIn(trimmed, password))
          } catch (err) {
            if (needsConfirmation(err)) {
              startConfirm(trimmed, 'Confirm your email first. Use the code we sent, or send a new one.', true)
              return
            }
            throw err
          }
        } else {
          if (password.length < PASSWORD_MIN) {
            setError(`Use at least ${PASSWORD_MIN} characters for your password.`)
            return
          }
          const result = await signUp(trimmed, password)
          if (result.session) setSession(result.session)
          else startConfirm(trimmed)
        }
      } catch (err) {
        if (mode === 'signup' && emailTaken(err)) setTaken(true)
        setError(friendlyAuthError(err, 'We couldn’t complete that request. Try again.'))
      } finally {
        setBusy(false)
      }
    }

    async function continueWithGoogle() {
      if (googleBusy || busy) return
      setGoogleBusy(true)
      setError('')
      setMessage('')
      try {
        await startGoogleSignIn()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Google sign-in didn’t start. Try again.')
        setGoogleBusy(false)
      }
    }

    async function verifyCode(value: string) {
      if (busy) return
      if (value.length < CODE_LENGTH) {
        setError(`Enter all ${CODE_LENGTH} digits of the code.`)
        codeInput.current?.focus()
        return
      }
      setBusy(true)
      setError('')
      setMessage('')
      let failed = false
      try {
        setSession(await verifySignupCode(pendingEmail, value))
      } catch (err) {
        failed = true
        setError(friendlyAuthError(err, 'That code didn’t work. Check the digits or send a new code.'))
      } finally {
        setBusy(false)
        // Select the code so a retyped one replaces it.
        if (failed) window.setTimeout(() => codeInput.current?.select(), 0)
      }
    }

    function submitCode(event: FormEvent) {
      event.preventDefault()
      void verifyCode(code)
    }

    // Typing or pasting keeps digits only ("123 456" and "123-456" work); a full code submits.
    function onCodeChange(value: string) {
      const digits = value.replace(/\D/g, '').slice(0, CODE_LENGTH)
      setCode(digits)
      if (error) setError('')
      if (digits.length === CODE_LENGTH && digits !== code) void verifyCode(digits)
    }

    if (view === 'confirm') {
      return (
        <main className="auth">
          <section className="auth-card" aria-labelledby="auth-title">
            <AuthBrand />
            <img className="auth-card__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <p className="auth-eyebrow">Last step</p>
            <h1 className="auth-title" id="auth-title">Check your email</h1>
            <p className="auth-lead">
              Enter the {CODE_LENGTH}-digit code we sent to <strong className="auth-email">{pendingEmail}</strong>.
            </p>
            <form className="auth-form" onSubmit={submitCode} noValidate>
              <label className="auth-field">
                <span>{CODE_LENGTH}-digit code</span>
                <input
                  ref={codeInput}
                  className="auth-input auth-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  enterKeyHint="go"
                  maxLength={CODE_LENGTH + 4}
                  placeholder={'•'.repeat(CODE_LENGTH)}
                  aria-describedby="auth-code-help"
                  aria-invalid={error ? true : undefined}
                  required
                  readOnly={busy}
                  value={code}
                  onChange={(event) => onCodeChange(event.target.value)}
                />
              </label>
              <p className="auth-help" id="auth-code-help">Not there after a minute? Check your spam or promotions folder.</p>
              {error ? <div className="auth-feedback is-error" role="alert">{error}</div> : null}
              <div className="sr-only" role="status" aria-live="polite">{busy ? 'Checking the code…' : message}</div>
              {message ? <div className="auth-feedback is-ok" aria-hidden="true">{message}</div> : null}
              <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>
                {busy ? 'Checking…' : 'Confirm and continue'}
              </button>
            </form>
            <div className="auth-links">
              <button className="auth-text-btn" type="button" disabled={busy || resendIn > 0} onClick={() => void sendCodeAgain()}>
                {resendIn > 0 ? <>Send a new code in <span aria-hidden="true">{resendIn}s</span><span className="sr-only">{resendIn > 50 ? 'a minute' : `${resendIn} seconds`}</span></> : 'Send a new code'}
              </button>
              <button className="auth-text-btn" type="button" disabled={busy} onClick={changeEmail}>
                Use a different email
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
            <div className="auth-card__head">
              <div>
                <p className="auth-eyebrow">{mode === 'login' ? 'Welcome back' : mode === 'reset' ? 'Forgot password' : 'Start studying'}</p>
                <h1 className="auth-title" id="auth-title">{mode === 'login' ? 'Log in' : mode === 'reset' ? 'Reset your password' : 'Create your account'}</h1>
              </div>
              <img className="auth-card__mascot auth-card__mascot--corner" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            </div>
            {mode === 'reset' ? <p className="auth-lead">Enter your email and we’ll send you a link to set a new password.</p> : null}
            {mode === 'login' && notice === 'reauth-delete' ? (
              <p className="auth-reason" role="status">
                Sign in again to finish deleting your account. Then open <strong>Settings</strong> and choose <strong>Delete account</strong>.
              </p>
            ) : null}
            {mode === 'signup' && signupReason ? (
              <p className="auth-reason" role="status">
                <strong>“{signupReason.replace(/^\+\s*/, '')}”</strong> works in the full app. Create an account to use it with your own courses and notes.
              </p>
            ) : null}
            {mode !== 'reset' && googleEnabled ? (
              <div className="auth-google">
                <button className="auth-google__btn" type="button" disabled={busy || googleBusy} aria-busy={googleBusy} onClick={() => void continueWithGoogle()}>
                  <GoogleMark />
                  <span>{googleBusy ? 'Opening Google…' : 'Continue with Google'}</span>
                </button>
                <p className="auth-divider"><span>or</span></p>
              </div>
            ) : null}
            <form className="auth-form" onSubmit={submit}>
              <label className="auth-field">
                <span>Email</span>
                <input ref={emailInput} className="auth-input" type="email" inputMode="email" autoComplete={mode === 'signup' ? 'email' : 'username'} autoCapitalize="none" spellCheck={false} placeholder="you@school.edu" required disabled={busy || googleBusy} enterKeyHint={mode === 'reset' ? 'send' : 'next'} value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              {mode !== 'reset' ? <label className="auth-field">
                <span>Password</span>
                <div className="auth-pass">
                  <input
                    className="auth-input"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={mode === 'signup' ? PASSWORD_MIN : 6}
                    required
                    disabled={busy}
                    enterKeyHint="go"
                    aria-describedby={mode === 'signup' ? 'auth-password-rule' : undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button type="button" disabled={busy} onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label> : null}
              {mode === 'signup' ? (
                <div className={`auth-strength is-${password.length >= PASSWORD_MIN ? Math.max(1, passwordScore) : 0}`}>
                  <small id="auth-password-rule" className={password.length >= PASSWORD_MIN ? 'is-met' : ''}>
                    {password.length >= PASSWORD_MIN ? <span aria-hidden="true">✓ </span> : null}
                    At least {PASSWORD_MIN} characters
                    {password && password.length < PASSWORD_MIN ? ` (${PASSWORD_MIN - password.length} more)` : ''}
                  </small>
                  {password.length >= PASSWORD_MIN ? (
                    <>
                      <div aria-hidden="true">{[0, 1, 2, 3].map((index) => <span key={index} className={index < passwordScore ? 'is-on' : ''} />)}</div>
                      <small>{passwordScore <= 1 ? 'Add a number or symbol to make it stronger' : passwordScore === 2 ? 'Good password' : 'Strong password'}</small>
                    </>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <div className="auth-feedback is-error" role="alert">
                  {error}
                  {taken ? (
                    <span className="auth-feedback__actions">
                      <button className="auth-text-btn" type="button" onClick={() => switchMode('login')}>Log in instead</button>
                      <button className="auth-text-btn" type="button" onClick={() => switchMode('reset')}>Reset password</button>
                    </span>
                  ) : null}
                </div>
              ) : null}
              {message ? <div className="auth-feedback is-ok" role="status">{message}</div> : null}
              <button className="auth-submit" type="submit" disabled={busy}>
                {busy ? (mode === 'login' ? 'Logging in…' : mode === 'reset' ? 'Sending…' : 'Creating account…') : mode === 'login' ? 'Log in' : mode === 'reset' ? 'Send reset link' : 'Create account'}
              </button>
            </form>
            {mode !== 'reset' ? (
              <p className="auth-legal">
                By continuing{googleEnabled ? ', including with Google,' : ''} you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.
              </p>
            ) : null}
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
                {mode === 'login' ? 'New to bindet?' : 'Already have an account?'}{' '}
                <button className="auth-text-btn" type="button" disabled={busy} onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'Log in'}</button>
              </p>
            )}
          </section>
          <AuthAside mode={mode === 'reset' ? 'login' : mode} />
        </main>
      )
    }

    return (
      <>
        {notice === 'deleted' ? (
          <div className="auth-notice" role="status">
            <span>Your account and data were deleted.</span>
            <button className="auth-notice__close" type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
          </div>
        ) : null}
        <Suspense fallback={<div className="auth-backdrop" aria-hidden="true" />}>
          <Landing onSignUp={(reason) => openAuth('signup', reason)} onLogIn={() => openAuth('login')} />
        </Suspense>
      </>
    )
  }

  return <AuthContext.Provider value={{ session, setSession }}>{children}</AuthContext.Provider>
}
