import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, DELETE_ACCOUNT_PHRASE, getAccountProfile, getCachedProfile, saveAccountProfile, saveSocialPrivacy, type Profile } from '../lib/api'
import { accountDisplayName, suggestedUsername } from '../lib/accountName'
import { accountDeletionEnabled, requestPasswordReset, signIn, signOutAndReload, signOutWithNotice, signUp, type AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { useDrawer } from '../lib/useDrawer'
import { InstallBindit } from '../components/AppPrompts'
import { OttoMemoryPanel } from '../components/otto/OttoMemoryPanel'
import { OttoPreferences } from '../components/otto/OttoPreferences'
import { useInstallOffer } from '../lib/pwa'
import { saveThemePreference, useThemePreference, type ThemePreference } from '../lib/theme'
import { FeedbackForm, HelpGuides } from './More'
import './Settings.css'

const GOALS = [
  { id: 10, label: 'Casual' },
  { id: 20, label: 'Regular' },
  { id: 30, label: 'Serious' },
  { id: 50, label: 'Intense' },
]

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

type SettingsProps = {
  session: AuthSession | null
  onSession: (session: AuthSession | null) => void
}

type Loaded = { userId: string; profile: Profile | null; ready: boolean }

/* One ruled section: what it is on the left, the settings on the right. */
function Section({ id, title, copy, children }: { id: string; title: string; copy: string; children: ReactNode }) {
  return (
    <section className="settings__section" aria-labelledby={id}>
      <div className="settings__intro">
        <h2 id={id}>{title}</h2>
        <p>{copy}</p>
      </div>
      <div className="settings__body">{children}</div>
    </section>
  )
}

function initialLoaded(session: AuthSession | null): Loaded | null {
  if (!session) return null
  const cached = getCachedProfile(session.access_token)
  return cached ? { userId: session.user.id, profile: cached, ready: true } : null
}

// Before a profile is saved: the Google name (or chosen username) and a username built from it.
function defaultDisplayName(session: AuthSession | null) {
  return accountDisplayName(session?.user)
}

function defaultUsername(session: AuthSession | null) {
  return suggestedUsername(session?.user)
}

export function Settings({ session, onSession }: SettingsProps) {
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(() => initialLoaded(session))
  const installOffer = useInstallOffer()
  const [displayName, setDisplayName] = useState(() => loaded?.profile?.display_name ?? defaultDisplayName(session))
  const [username, setUsername] = useState(() => loaded?.profile?.username ?? defaultUsername(session))
  const [profileStatus, setProfileStatus] = useState('')
  const [goalStatus, setGoalStatus] = useState('')
  const [privacyStatus, setPrivacyStatus] = useState('')
  const [copied, setCopied] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [canDelete, setCanDelete] = useState<boolean | null>(null)

  // "#settings?help" (old Help links, the command palette) opens on Help & feedback.
  useEffect(() => {
    let timer = 0
    const openHelp = () => {
      if (!/[?&]help\b/.test(window.location.hash)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        document.getElementById('settings-help')?.scrollIntoView({ block: 'start' })
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#settings`)
      }, 50)
    }
    openHelp()
    window.addEventListener('hashchange', openHelp)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('hashchange', openHelp)
    }
  }, [])

  useEffect(() => {
    let live = true
    void accountDeletionEnabled().then((enabled) => { if (live) setCanDelete(enabled) })
    return () => { live = false }
  }, [])
  const theme = useThemePreference()

  // The saved profile belongs to whoever is signed in now; anything else is ignored.
  const current = loaded && session && loaded.userId === session.user.id ? loaded : null
  const profile = current?.profile ?? null
  const profileReady = Boolean(current?.ready)

  // Cached profile renders first; the saved one replaces it in the background.
  useEffect(() => {
    if (!session) return
    let live = true
    const userId = session.user.id
    void getAccountProfile(session.access_token)
      .then((saved) => {
        if (!live) return
        setLoaded({ userId, profile: saved, ready: true })
        if (saved) {
          setDisplayName(saved.display_name)
          setUsername(saved.username)
        } else {
          setUsername(defaultUsername(session))
          setDisplayName(defaultDisplayName(session))
        }
      })
      .catch(() => {
        if (!live) return
        setLoaded((value) => value?.userId === userId ? value : { userId, profile: null, ready: true })
        setProfileStatus('Could not load your profile. Your changes will still save.')
      })
    return () => { live = false }
  }, [session])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  function chooseTheme(next: ThemePreference) {
    saveThemePreference(next)
  }

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
          setMessage('Check your inbox and press “Confirm your email.” We’ll bring you straight back to bindet and sign you in.')
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
    setProfileStatus('')
    try {
      const saved = await saveAccountProfile(session.access_token, {
        username: username.toLowerCase(),
        display_name: displayName,
        daily_goal: profile?.daily_goal ?? 20,
      })
      setLoaded({ userId: session.user.id, profile: saved, ready: true })
      setProfileStatus('Profile saved.')
    } catch (error) {
      setProfileStatus(error instanceof Error ? error.message : 'Could not save your profile.')
    } finally {
      setBusy(false)
    }
  }

  // Saves at once; on failure the previous goal comes back and we say so.
  async function chooseGoal(goal: number) {
    if (!session || !profile || goal === profile.daily_goal) return
    const previous = profile
    const userId = session.user.id
    setLoaded({ userId, profile: { ...profile, daily_goal: goal }, ready: true })
    setGoalStatus('')
    try {
      const saved = await saveAccountProfile(session.access_token, { username: previous.username, display_name: previous.display_name, daily_goal: goal })
      setLoaded((value) => value?.userId === userId ? { ...value, profile: saved } : value)
      setGoalStatus(`Daily goal set to ${goal} XP.`)
    } catch {
      setLoaded((value) => value?.userId === userId ? { ...value, profile: previous } : value)
      setGoalStatus('Could not change your daily goal. It is back to what it was.')
    }
  }

  async function togglePrivacy(field: 'discoverable' | 'allow_friend_requests') {
    if (!session || !profile) return
    const previous = profile
    const userId = session.user.id
    const next = { ...profile, [field]: !profile[field] }
    setLoaded({ userId, profile: next, ready: true })
    setPrivacyStatus('')
    try {
      await saveSocialPrivacy(next.discoverable, next.allow_friend_requests, session.access_token)
    } catch {
      setLoaded((value) => value?.userId === userId ? { ...value, profile: previous } : value)
      setPrivacyStatus('Could not save that change. Try again.')
    }
  }

  async function copyFriendCode(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  function logout() {
    setBusy(true)
    setMessage('Signing out…')
    // Clears this browser's account data, then reloads so nothing stays in memory.
    signOutAndReload()
  }

  const authTitle = mode === 'login' ? 'Log in' : mode === 'signup' ? 'Create an account' : 'Reset your password'

  const appearance = (
    <>
    <Section id="settings-appearance" title="Appearance" copy="Choose how bindet looks on this device. System follows your device setting.">
      <div className="ui-panel">
        <div className="settings__row">
          <div className="settings__row-text">
            <span className="settings__label" id="settings-theme-label">Theme</span>
            <span className="settings__hint">Saved on this device only.</span>
          </div>
          <div className="ui-segmented settings__segmented" role="group" aria-labelledby="settings-theme-label">
            {THEMES.map((item) => (
              <button key={item.id} type="button" className="ui-segmented__item" aria-pressed={theme === item.id} onClick={() => chooseTheme(item.id)}>{item.label}</button>
            ))}
          </div>
        </div>
      </div>
    </Section>
    {installOffer ? (
      <Section id="settings-app" title="App" copy="Use bindet as an app on this device. Flashcards you have opened stay available offline.">
        <div className="ui-panel">
          <InstallBindit place="settings" />
        </div>
      </Section>
    ) : null}
    </>
  )

  return (
    <div className="ui-page settings">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Account</span>
          <h1 className="ui-page-title">Settings</h1>
          <p className="ui-page-subtitle">
            {session
              ? `Signed in as ${session.user.email ?? 'your bindet account'}.`
              : 'Create an account to keep XP, streaks, and notes across devices.'}
          </p>
        </div>
      </header>

      {!session ? (
        <>
          <Section id="settings-auth" title={authTitle} copy="Sign in to keep your XP, streaks, and notes across devices.">
            <form className="ui-panel settings__auth" onSubmit={submitAuth}>
              <label className="ui-field" htmlFor="settings-email">
                <span>Email</span>
                <input id="settings-email" className="ui-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
              </label>
              {mode !== 'reset' ? (
                <label className="ui-field" htmlFor="settings-password">
                  <span>Password</span>
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
                </label>
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
              <p className="settings__hint">By continuing you agree to the <a className="ui-link" href="/terms">Terms of Service</a> and <a className="ui-link" href="/privacy">Privacy Policy</a>.</p>
            </form>
          </Section>
          {appearance}
        </>
      ) : (
        <>
          <Section id="settings-profile" title="Profile" copy="How friends and study groups see you.">
            <form className="ui-panel" onSubmit={saveProfile} aria-busy={!profileReady}>
              <div className="settings__row">
                <div className="settings__row-text">
                  <label className="settings__label" htmlFor="settings-display-name">Display name</label>
                  <span className="settings__hint">Shown to friends and in group chats.</span>
                </div>
                <input id="settings-display-name" className="ui-input settings__control" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={40} autoComplete="nickname" autoCapitalize="words" enterKeyHint="done" disabled={!profileReady} />
              </div>
              <div className="settings__row">
                <div className="settings__row-text">
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
                  autoCapitalize="none"
                  autoComplete="username"
                  enterKeyHint="done"
                  spellCheck={false}
                  disabled={!profileReady}
                />
              </div>
              <div className="settings__footer">
                {profileStatus ? <p className="settings__status" role="status">{profileStatus}</p> : null}
                <button className={`ui-button ui-button--primary${busy ? ' is-busy' : ''}`} type="submit" disabled={busy || !profileReady}>
                  {profile ? 'Update profile' : 'Save profile'}
                </button>
              </div>
            </form>
          </Section>

          <Section id="settings-goal" title="Daily goal" copy="How much XP to aim for each day. Changes save right away.">
            <div className="ui-panel">
              <div className="settings__row settings__row--stack">
                <div className="settings__goals" role="group" aria-label="Daily XP goal">
                  {GOALS.map((goal) => (
                    <button
                      key={goal.id}
                      type="button"
                      className="settings__goal"
                      aria-pressed={profile?.daily_goal === goal.id}
                      onClick={() => void chooseGoal(goal.id)}
                      disabled={!profile}
                    >
                      <b>{goal.label}</b>
                      <small>{goal.id} XP</small>
                    </button>
                  ))}
                </div>
                {!profile && profileReady ? <p className="settings__hint">Save your profile first to set a goal.</p> : null}
                {goalStatus ? <p className="settings__status" role="status">{goalStatus}</p> : null}
              </div>
            </div>
          </Section>

          <Section id="settings-otto" title="Otto" copy="How Otto, your tutor, talks to you, and the short notes Otto keeps about you. Changes apply from your next message.">
            <div className="settings__otto">
              <div className="ui-panel settings__otto-panel">
                <OttoPreferences token={session.access_token} defaultName={profile?.display_name || displayName} />
              </div>
              <div className="ui-panel settings__otto-panel">
                <OttoMemoryPanel token={session.access_token} />
              </div>
            </div>
          </Section>

          {appearance}

          <Section id="settings-privacy" title="Privacy" copy="Control who can find you. Study group messages and images are only visible to that group's members.">
            <div className="ui-panel">
              {profile ? (
                <>
                  <label className="settings__row settings__toggle">
                    <span className="settings__row-text">
                      <span className="settings__label">Appear in search</span>
                      <span className="settings__hint">Let other learners find your profile.</span>
                    </span>
                    <input className="ui-checkbox" type="checkbox" checked={profile.discoverable} onChange={() => void togglePrivacy('discoverable')} />
                  </label>
                  <label className="settings__row settings__toggle">
                    <span className="settings__row-text">
                      <span className="settings__label">Friend requests</span>
                      <span className="settings__hint">Allow new people to add you.</span>
                    </span>
                    <input className="ui-checkbox" type="checkbox" checked={profile.allow_friend_requests} onChange={() => void togglePrivacy('allow_friend_requests')} />
                  </label>
                </>
              ) : (
                <div className="settings__row">
                  <span className="settings__hint">{profileReady ? 'Save your profile to choose who can find you.' : 'Loading your privacy settings…'}</span>
                </div>
              )}
              {privacyStatus ? <div className="settings__row"><p className="settings__status settings__status--error" role="alert">{privacyStatus}</p></div> : null}
            </div>
          </Section>

          <Section id="settings-account" title="Account" copy="Your sign-in and the code friends use to add you.">
            <div className="ui-panel">
              <div className="settings__row">
                <div className="settings__row-text">
                  <span className="settings__label">Email</span>
                </div>
                <span className="settings__value">{session.user.email ?? '—'}</span>
              </div>
              {profile ? (
                <div className="settings__row">
                  <div className="settings__row-text">
                    <span className="settings__label">Friend code</span>
                    <span className="settings__hint">Share it so friends can add you.</span>
                  </div>
                  <div className="settings__code-wrap">
                    <span className="settings__value settings__code">{profile.friend_code}</span>
                    <button type="button" className="ui-button ui-button--sm" onClick={() => void copyFriendCode(profile.friend_code)}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
              ) : null}
              <div className="settings__row">
                <div className="settings__row-text">
                  <span className="settings__label">Sign out</span>
                  <span className="settings__hint">You’ll need to log in again to use bindet on this device.</span>
                </div>
                <button className="ui-button" type="button" onClick={logout}>Sign out</button>
              </div>
              <div className="settings__row">
                <div className="settings__row-text">
                  <span className="settings__label">Privacy and terms</span>
                  <span className="settings__hint">What bindet stores, who processes it, and the rules for using bindet.</span>
                </div>
                <div className="settings__legal-links">
                  <a className="ui-link" href="/privacy">Privacy Policy</a>
                  <a className="ui-link" href="/terms">Terms of Service</a>
                </div>
              </div>
            </div>
          </Section>

          <Section id="settings-delete" title="Delete account" copy="Permanently delete your bindet account and everything in it.">
            <div className="ui-panel settings__danger">
              <div className="settings__row settings__row--stack">
                <p className="settings__danger-lead">Deleting your account removes, right away:</p>
                <ul className="settings__danger-list">
                  <li>Your profile, XP, streaks, progress and friend code</li>
                  <li>Your notes, flashcards, quiz questions, tutor conversations and what Otto remembers about you</li>
                  <li>Your personal tasks, plus your comments, attachments and assignments on group tasks</li>
                  <li>Your friends, friend quests and notifications, and the messages and images you sent in group chats</li>
                </ul>
                <p className="settings__hint settings__danger-groups">
                  Study groups you own pass to the member who joined earliest, together with the group tasks you created.
                  A group where you’re the only member is deleted. This can’t be undone.
                </p>
                {canDelete === false ? (
                  <p className="settings__hint">
                    To delete your account and all your data, email{' '}
                    <a className="ui-link" href="mailto:officialbindet@gmail.com?subject=Delete%20my%20bindet%20account">officialbindet@gmail.com</a>{' '}
                    from your account’s email address and we’ll do it within 30 days.
                  </p>
                ) : (
                  <button type="button" className="ui-button ui-button--danger settings__danger-button" disabled={canDelete === null} onClick={() => setDeleteOpen(true)}>Delete account…</button>
                )}
              </div>
            </div>
          </Section>
          {deleteOpen ? <DeleteAccountDialog session={session} onCancel={() => setDeleteOpen(false)} /> : null}
        </>
      )}

      <Section id="settings-help" title="Help & feedback" copy="Short guides for every part of bindet, and a way to tell us what to fix or build next.">
        <HelpGuides />
        <div className="settings__feedback">
          <h3 className="settings__subhead">Send feedback</h3>
          <FeedbackForm session={session} />
        </div>
      </Section>
    </div>
  )
}

/*
 * Confirms account deletion: type DELETE MY ACCOUNT (exactly) to enable the button.
 * A sign-in older than 10 minutes is refused by the server (reauth_required); then
 * "Sign in again" signs out and the sign-in card says why. On success this browser's
 * account data is cleared and the landing page shows a one-time notice.
 */
function DeleteAccountDialog({ session, onCancel }: { session: AuthSession; onCancel: () => void }) {
  const data = useData()
  const panel = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reauth, setReauth] = useState(false)
  const cancel = () => { if (!busy) onCancel() }
  useDrawer({ open: true, onClose: cancel, panel })
  const ready = typed === DELETE_ACCOUNT_PHRASE

  async function confirm(event: FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      await data.deleteAccount(typed, session.access_token)
      await signOutWithNotice('deleted')
    } catch (caught) {
      setBusy(false)
      if (caught instanceof ApiError && caught.code === 'reauth_required') {
        setReauth(true)
        setError(caught.message)
        return
      }
      setError(caught instanceof Error ? caught.message : 'Could not delete your account. Try again.')
    }
  }

  function signInAgain() {
    setBusy(true)
    void signOutWithNotice('reauth-delete')
  }

  return (
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel() }}>
      <div ref={panel} className="ui-dialog settings__dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-copy">
        <form onSubmit={(event) => void confirm(event)}>
          <header className="ui-dialog__header">
            <h2 className="ui-dialog__title" id="delete-account-title">Delete your account?</h2>
          </header>
          <div className="settings__dialog-body">
            <p id="delete-account-copy">
              Everything in your bindet account is deleted at once and can’t be recovered. Groups you own pass to the member who joined earliest;
              a group where you’re the only member is deleted.
            </p>
            <label className="ui-field">
              <span>Type <strong>{DELETE_ACCOUNT_PHRASE}</strong> to confirm</span>
              <input className="ui-input" value={typed} disabled={busy || reauth} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="done" onChange={(event) => setTyped(event.target.value)} />
            </label>
            {error ? (
              <div className="ui-alert" role="alert">
                <span>{error}</span>
                {reauth ? <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={signInAgain}>Sign in again</button> : null}
              </div>
            ) : null}
          </div>
          <footer className="ui-dialog__footer">
            <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={cancel}>Cancel</button>
            <button type="submit" className={`ui-button ui-button--danger${busy && !reauth ? ' is-busy' : ''}`} disabled={!ready || busy || reauth}>Delete account</button>
          </footer>
        </form>
      </div>
    </div>
  )
}
