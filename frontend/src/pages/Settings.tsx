import { useEffect, useState, type FormEvent } from 'react'
import { getAccountProfile, saveAccountProfile, type Profile } from '../lib/api'
import { requestPasswordReset, signIn, signOut, signUp, type AuthSession } from '../lib/auth'
import { getStudentId } from '../lib/session'
import './Settings.css'

const GOALS = [
  { id: 10, label: 'Casual · 10 XP' },
  { id: 20, label: 'Regular · 20 XP' },
  { id: 30, label: 'Serious · 30 XP' },
  { id: 50, label: 'Intense · 50 XP' },
]

type SettingsProps = {
  session: AuthSession | null
  onSession: (session: AuthSession | null) => void
}

export function Settings({ session, onSession }: SettingsProps) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [dailyGoal, setDailyGoal] = useState(20)

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }
    void getAccountProfile(session.access_token)
      .then((saved) => {
        setProfile(saved)
        if (saved) {
          setDisplayName(saved.display_name)
          setUsername(saved.username)
          setDailyGoal(saved.daily_goal)
        } else {
          const metadataName = session.user.user_metadata?.username
          setUsername(typeof metadataName === 'string' ? metadataName : '')
          setDisplayName(typeof metadataName === 'string' ? metadataName : '')
        }
      })
      .catch(() => setMessage('Could not load your profile.'))
  }, [session])

  async function submitAuth(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'reset') {
        await requestPasswordReset(email.trim())
        setMessage('Check your email for a reset link.')
        return
      }
      if (mode === 'login') {
        const next = await signIn(email.trim(), password)
        onSession(next)
        setMessage('You are signed in.')
      } else {
        const result = await signUp(email.trim(), password)
        if (!result.session) {
          setMessage('Check your inbox and press “Confirm your email.” We’ll bring you straight back to bindit and sign you in.')
        } else {
          onSession(result.session)
          setMessage('Your account is ready.')
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not continue.')
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (!session) return
    setBusy(true)
    setMessage('')
    try {
      const saved = await saveAccountProfile(session.access_token, {
        username: username.toLowerCase(),
        display_name: displayName,
        guest_id: getStudentId(),
        daily_goal: dailyGoal,
      })
      setProfile(saved)
      setMessage('Profile saved. Guest progress is claimed at most once.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save your profile.')
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    signOut()
    onSession(null)
    setMessage('Signed out. You can keep using bindit as a guest.')
  }

  const authTitle = mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create an account' : 'Reset your password'

  return (
    <div className="ui-page settings">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Settings</h1>
          <p className="ui-page-subtitle">
            {session
              ? `Signed in as ${session.user.email ?? 'your bindit account'}.`
              : 'Create an account to keep XP, streaks, and notes across devices.'}
          </p>
        </div>
      </header>

      {!session ? (
        <section className="ui-section" aria-labelledby="settings-auth">
          <div className="ui-section-head"><h2 className="ui-section-title" id="settings-auth">{authTitle}</h2></div>
          <form className="ui-panel settings__auth" onSubmit={submitAuth}>
            <div className="settings__stack">
              <label className="settings__label" htmlFor="settings-email">Email</label>
              <input id="settings-email" className="ui-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
            </div>
            {mode !== 'reset' ? (
              <div className="settings__stack">
                <label className="settings__label" htmlFor="settings-password">Password</label>
                <input
                  id="settings-password"
                  className="ui-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>
            ) : null}
            {message ? <p className="settings__status" role="status">{message}</p> : null}
            <button className="ui-button ui-button--primary settings__submit" type="submit" disabled={busy}>
              {busy ? 'One moment…' : mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create account' : 'Send reset email'}
            </button>
            <div className="settings__links">
              <button className="ui-link" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage('') }}>
                {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
              </button>
              <button className="ui-link" type="button" onClick={() => { setMode('reset'); setMessage('') }}>Forgot password</button>
            </div>
          </form>
        </section>
      ) : (
        <>
          <section className="ui-section" aria-labelledby="settings-profile">
            <div className="ui-section-head"><h2 className="ui-section-title" id="settings-profile">Profile</h2></div>
            <form className="ui-panel" onSubmit={saveProfile}>
              <div className="settings__field">
                <div className="settings__field-text">
                  <label className="settings__label" htmlFor="settings-display-name">Display name</label>
                  <span className="settings__hint">Shown to friends.</span>
                </div>
                <input id="settings-display-name" className="ui-input settings__control" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={40} />
              </div>
              <div className="settings__field">
                <div className="settings__field-text">
                  <label className="settings__label" htmlFor="settings-username">Username</label>
                  <span className="settings__hint">3 to 24 letters, numbers, or underscores.</span>
                </div>
                <input
                  id="settings-username"
                  className="ui-input settings__control"
                  value={username}
                  onChange={(event) => setUsername(event.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  required
                  minLength={3}
                  maxLength={24}
                />
              </div>
              <div className="settings__field">
                <div className="settings__field-text">
                  <label className="settings__label" htmlFor="settings-daily-goal">Daily goal</label>
                  <span className="settings__hint">How much XP to aim for each day.</span>
                </div>
                <select id="settings-daily-goal" className="ui-select settings__control" value={dailyGoal} onChange={(event) => setDailyGoal(Number(event.target.value))}>
                  {GOALS.map((goal) => <option key={goal.id} value={goal.id}>{goal.label}</option>)}
                </select>
              </div>
              <div className="settings__footer">
                {message ? <p className="settings__status" role="status">{message}</p> : null}
                <button className="ui-button ui-button--primary" type="submit" disabled={busy}>
                  {busy ? 'Saving…' : profile ? 'Update profile' : 'Save profile and claim guest progress'}
                </button>
              </div>
            </form>
          </section>

          <section className="ui-section" aria-labelledby="settings-account">
            <div className="ui-section-head"><h2 className="ui-section-title" id="settings-account">Account</h2></div>
            <div className="ui-panel">
              <div className="settings__field">
                <div className="settings__field-text">
                  <span className="settings__label">Email</span>
                </div>
                <span className="settings__value">{session.user.email ?? '—'}</span>
              </div>
              {profile ? (
                <div className="settings__field">
                  <div className="settings__field-text">
                    <span className="settings__label">Friend code</span>
                    <span className="settings__hint">Share it so friends can add you.</span>
                  </div>
                  <span className="settings__value settings__code">{profile.friend_code}</span>
                </div>
              ) : null}
              <div className="settings__field">
                <div className="settings__field-text">
                  <span className="settings__label">Sign out</span>
                  <span className="settings__hint">You can keep using bindit as a guest on this device.</span>
                </div>
                <button className="ui-button" type="button" onClick={logout}>Sign out</button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
