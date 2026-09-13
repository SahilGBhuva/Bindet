import { useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
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
import './AuthGate.css'
import './GuestAuth.css'

type Mode = 'login' | 'signup'
type GateView = 'landing' | 'auth' | 'confirm'
const GUEST_KEY = 'bindit-guest-mode'
const RESEND_SECS = 60

function BrandMark() {
  return (
    <div className="lp-mark" aria-hidden="true">
      <img src="/bindet-binder.png" alt="" />
    </div>
  )
}

function trackSpotlight(event: MouseEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty('--mx', `${event.clientX - box.left}px`)
  event.currentTarget.style.setProperty('--my', `${event.clientY - box.top}px`)
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

  function openAuth(nextMode: Mode = 'signup') {
    setMode(nextMode)
    setView('auth')
    setError('')
    setMessage('')
  }

  function switchMode(nextMode: Mode) {
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
      <main className="lp lp-loading">
        <div className="lp-orb" aria-hidden="true" />
        <p>Opening Bindet…</p>
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
        <main className="lp lp-auth-only">
          <div className="lp-glow lp-glow--a" aria-hidden="true" />
          <section className="lp-auth-card lp-spotlight" onMouseMove={trackSpotlight}>
            <BrandMark />
            <p className="lp-kicker">Confirm email</p>
            <h2>Check your inbox</h2>
            <p className="lp-lead">We sent a code to {pendingEmail}. Paste it below. You can resend after 1 minute if it never shows up.</p>
            <form className="lp-form" onSubmit={submitCode}>
              <label>
                <span>Confirmation code</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  required
                  disabled={busy}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              {error ? <div className="lp-feedback is-error" role="alert">{error}</div> : null}
              {message ? <div className="lp-feedback is-ok" role="status">{message}</div> : null}
              <button className="lp-btn lp-btn--primary" type="submit" disabled={busy}>
                {busy ? 'Checking…' : 'Confirm and enter'}
              </button>
            </form>
            <button className="lp-resend" type="button" disabled={busy || resendIn > 0} onClick={() => void sendCodeAgain()}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <button className="lp-text-btn" type="button" disabled={busy} onClick={() => setView('auth')}>
              Back to sign in
            </button>
          </section>
        </main>
      )
    }

    if (view === 'auth') {
      return (
        <main className="lp lp-auth-only">
          <div className="lp-glow lp-glow--a" aria-hidden="true" />
          <section className="lp-auth-card lp-spotlight" onMouseMove={trackSpotlight}>
            <button className="lp-text-btn lp-back" type="button" onClick={() => setView('landing')}>
              ← Back to Bindet
            </button>
            <div className="lp-auth-brand">
              <BrandMark />
              <span>bindet</span>
            </div>
            <p className="lp-kicker">{mode === 'login' ? 'Welcome back' : 'Start building'}</p>
            <h2>{mode === 'login' ? 'Log in' : 'Create your account'}</h2>
            <div className="lp-tabs" role="tablist" aria-label="Authentication mode">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'is-on' : ''} disabled={busy} onClick={() => switchMode('login')}>
                Log in
              </button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-on' : ''} disabled={busy} onClick={() => switchMode('signup')}>
                Sign up
              </button>
            </div>
            <form className="lp-form" onSubmit={submit}>
              <label>
                <span>Email</span>
                <input type="email" autoComplete="email" placeholder="you@school.edu" required disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label>
                <span>Password</span>
                <div className="lp-pass">
                  <input
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
                <div className="lp-strength">
                  <div>{[0, 1, 2, 3].map((index) => <span key={index} className={index < passwordScore ? 'is-on' : ''} />)}</div>
                  <small>{passwordScore <= 1 ? 'Make it stronger' : passwordScore === 2 ? 'Good password' : 'Strong password'}</small>
                </div>
              ) : null}
              {error ? <div className="lp-feedback is-error" role="alert">{error}</div> : null}
              {message ? <div className="lp-feedback is-ok" role="status">{message}</div> : null}
              <button className="lp-btn lp-btn--primary" type="submit" disabled={busy}>
                {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Get started'}
              </button>
            </form>
            <div className="auth-guest-separator"><span>or</span></div>
            <button className="lp-btn lp-btn--ghost" type="button" disabled={busy} onClick={continueAsGuest}>
              Continue as guest
            </button>
          </section>
        </main>
      )
    }

    return (
      <div className="lp">
        <div className="lp-glow lp-glow--a" aria-hidden="true" />
        <div className="lp-glow lp-glow--b" aria-hidden="true" />
        <header className="lp-nav">
          <a className="lp-nav__brand" href="#top" onClick={(event) => { event.preventDefault(); setView('landing') }}>
            <BrandMark />
            bindet
          </a>
          <nav className="lp-nav__links">
            <a href="#product">Product</a>
            <a href="#features">Features</a>
            <button type="button" onClick={() => openAuth('login')}>Sign in</button>
          </nav>
          <button className="lp-btn lp-btn--nav" type="button" onClick={() => openAuth('signup')}>
            Get started
          </button>
        </header>

        <main>
          <section className="lp-hero" id="top">
            <p className="lp-kicker">The binder for how you actually study</p>
            <h1>
              Keep your learning
              <span> together.</span>
            </h1>
            <p className="lp-lead">
              Notes, flashcards, quizzes, and quests snap into one cinematic workspace — then cinch shut when you need the desk.
            </p>
            <div className="lp-hero__cta">
              <button className="lp-btn lp-btn--primary" type="button" onClick={() => openAuth('signup')}>
                Start building
              </button>
              <button className="lp-btn lp-btn--ghost" type="button" onClick={continueAsGuest}>
                Browse as guest
              </button>
            </div>
            <div className="lp-hero__frame" id="product">
              <div className="lp-mock">
                <div className="lp-mock__bar">
                  <span />
                  <span />
                  <span />
                  <em>Bindet · Tools</em>
                </div>
                <div className="lp-mock__body">
                  <aside>
                    <b>bindet</b>
                    <i>Home</i>
                    <i className="is-on">Tools</i>
                    <i>Quests</i>
                    <i>Profile</i>
                  </aside>
                  <div>
                    <p>Now navigating</p>
                    <strong>Math · Algebra</strong>
                    <div className="lp-mock__pills">
                      <span>Note taker</span>
                      <span className="is-on">Flashcards</span>
                      <span>Quiz</span>
                    </div>
                    <div className="lp-mock__cards">
                      <article>Derivative of x²</article>
                      <article>Chain rule</article>
                      <article>Limit as h → 0</article>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="lp-bento" id="features">
            <article className="lp-card lp-card--wide lp-spotlight" onMouseMove={trackSpotlight}>
              <span>Workflow</span>
              <h3>Courses snap. The workbench stays.</h3>
              <p>Scroll courses on the left. Notes, cards, and quizzes live on the right — one binder, not twelve tabs.</p>
            </article>
            <article className="lp-card lp-spotlight" onMouseMove={trackSpotlight}>
              <span>Speed</span>
              <h3>Pull a lecture</h3>
              <p>The lectern fans your deposits into Goal, Break it down, Use your notes, Check yourself.</p>
            </article>
            <article className="lp-card lp-spotlight" onMouseMove={trackSpotlight}>
              <span>Automation</span>
              <h3>Pages become practice</h3>
              <p>Scan a page, drop extra notes, then drill flashcards and quizzes without leaving the unit.</p>
            </article>
            <article className="lp-card lp-card--mid lp-spotlight" onMouseMove={trackSpotlight}>
              <span>Together</span>
              <h3>Friend quests</h3>
              <p>Share a code, start a goal, keep a private league with the people you actually study with.</p>
            </article>
          </section>
        </main>
      </div>
    )
  }

  return <AuthContext.Provider value={{ session, setSession }}>{children}</AuthContext.Provider>
}
