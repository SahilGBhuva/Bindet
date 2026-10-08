import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ApiError, saveAccountProfile } from '../../lib/api'
import { accountDisplayName, suggestedUsername } from '../../lib/accountName'
import type { AuthSession } from '../../lib/auth'
import { addClassesToBinder, binderHasUnits, COURSE_NAME_MAX, finishSetup, FIRST_UNIT, savedStep, saveStep, SUGGESTED_CLASSES } from '../../lib/onboarding'
import { BrandMark } from '../../lib/SiteSidebar'
import { OnboardingOttoStep } from './OnboardingOttoStep'
import { OnboardingActions, type OnboardingStepProps } from './OnboardingParts'
import './Onboarding.css'

/*
 * The welcome setup after a first sign-in: up to three quick steps, each skippable,
 * with progress dots, then a short "you're set" screen whose one action is adding
 * notes. Steps already covered are left out (a profile that exists skips the name;
 * a binder with units skips the classes). Finishing or skipping is saved on the
 * server, so it never shows again; a reload resumes at the same step.
 */

type StepId = 'name' | 'classes' | 'otto'
const STEP_LABELS: Record<StepId, string> = { name: 'Your name', classes: 'Your classes', otto: 'Meet Otto' }
const USERNAME_RULE = /^[a-z0-9_]{3,24}$/
const MAX_CLASSES = 12

function usernameFrom(name: string) {
  return suggestedUsername({ id: '', user_metadata: { full_name: name } })
}

function randomDigits(count: number) {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return String(values[0] % 10 ** count).padStart(count, '0')
}

/* The page to open after setup: where the student was going, if it was a deep link. */
function deepLink(hash: string) {
  const screen = hash.replace('#', '').split('?')[0]
  return screen && screen !== 'home' ? hash : ''
}

function listNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/* ---------- Step 1: name ---------- */

function NameStep({ session, headingRef, onNext, onSkip, onSaved }: OnboardingStepProps & { session: AuthSession; onSaved: (name: string) => void }) {
  const [name, setName] = useState(() => accountDisplayName(session.user))
  const [username, setUsername] = useState('')
  const [editingUsername, setEditingUsername] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'username' | 'form'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const usernameInput = useRef<HTMLInputElement>(null)
  // Until the student edits it, the username follows the name (a name with no Latin
  // letters gets a neutral one). The email address is never used for it.
  const [fallback] = useState(() => `student_${randomDigits(4)}`)
  const shownUsername = editingUsername ? username : (usernameFrom(name) || fallback)

  function openUsername(focus = true) {
    setUsername(shownUsername)
    setEditingUsername(true)
    if (focus) window.setTimeout(() => usernameInput.current?.focus(), 0)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const displayName = name.trim()
    if (!displayName) {
      setError({ field: 'name', text: 'Add the name friends know you by, or choose Skip.' })
      nameInput.current?.focus()
      return
    }
    let candidate = (editingUsername ? username : shownUsername).trim().toLowerCase()
    if (!USERNAME_RULE.test(candidate)) {
      if (editingUsername) {
        setError({ field: 'username', text: 'Use 3 to 24 lowercase letters, numbers or underscores.' })
        usernameInput.current?.focus()
        return
      }
      candidate = `student_${randomDigits(4)}`
    }
    setBusy(true)
    setError(null)
    // A suggested username that is taken gets a few digits added; a chosen one is left to the student.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await saveAccountProfile(session.access_token, { username: candidate, display_name: displayName })
        onSaved(displayName)
        onNext()
        return
      } catch (error) {
        const taken = error instanceof ApiError && error.status === 409
        if (taken && !editingUsername && attempt < 3) {
          candidate = `${candidate.slice(0, 19).replace(/_+$/, '')}_${randomDigits(4)}`
          continue
        }
        setBusy(false)
        if (taken) {
          setError({ field: 'username', text: `@${candidate} is taken. Try another username.` })
          if (!editingUsername) openUsername()
          else usernameInput.current?.select()
          return
        }
        setError({ field: 'form', text: error instanceof Error && error.message ? `${error.message} You can skip this and set it later in Settings.` : 'We couldn’t save that. Try again, or skip and set it later in Settings.' })
        return
      }
    }
  }

  return (
    <form className="onb-step" aria-labelledby="onb-name-title" onSubmit={submit} noValidate>
      <p className="onb-eyebrow">Welcome to bindet</p>
      <h1 className="onb-title" id="onb-name-title" ref={headingRef} tabIndex={-1}>What should we call you?</h1>
      <p className="onb-lead">Your name shows on your profile and to friends you add. You can change it any time.</p>
      <label className="onb-field">
        <span>Your name</span>
        <input
          ref={nameInput}
          className="ui-input onb-input"
          value={name}
          maxLength={40}
          autoComplete="name"
          autoCapitalize="words"
          enterKeyHint="next"
          placeholder="e.g. Jordan Lee"
          aria-invalid={error?.field === 'name' || undefined}
          aria-describedby={error?.field === 'name' ? 'onb-name-error' : 'onb-username-line'}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value)
            if (error?.field === 'name') setError(null)
          }}
        />
      </label>
      {error?.field === 'name' ? <p className="onb-error" id="onb-name-error" role="alert">{error.text}</p> : null}
      {editingUsername ? (
        <label className="onb-field">
          <span>Username</span>
          <span className="onb-username">
            <span aria-hidden="true">@</span>
            <input
              ref={usernameInput}
              className="ui-input onb-input"
              value={username}
              maxLength={24}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              aria-invalid={error?.field === 'username' || undefined}
              aria-describedby="onb-username-help"
              disabled={busy}
              onChange={(event) => {
                setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))
                if (error?.field === 'username') setError(null)
              }}
            />
          </span>
          <small className="onb-help" id="onb-username-help">3 to 24 lowercase letters, numbers or underscores. Friends can search for it.</small>
        </label>
      ) : name.trim() ? (
        <p className="onb-help" id="onb-username-line">
          Friends can find you as <b>@{shownUsername}</b>.{' '}
          <button className="ui-link onb-inline-link" type="button" onClick={() => openUsername()} disabled={busy}>Change</button>
        </p>
      ) : null}
      {error && error.field !== 'name' ? <p className="onb-error" role="alert">{error.text}</p> : null}
      <OnboardingActions primary={busy ? 'Saving…' : 'Continue'} onSkip={onSkip} busy={busy} />
    </form>
  )
}

/* ---------- Step 2: classes ---------- */

function ClassesStep({ headingRef, onNext, onSkip, onPicked }: OnboardingStepProps & { onPicked: (names: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [hint, setHint] = useState('')
  const options = [...SUGGESTED_CLASSES, ...picked.filter((name) => !SUGGESTED_CLASSES.includes(name))]

  function toggle(name: string) {
    setHint('')
    if (picked.includes(name)) {
      const next = picked.filter((item) => item !== name)
      setPicked(next)
      setAnnouncement(`${name} removed. ${next.length} picked.`)
      return
    }
    if (picked.length >= MAX_CLASSES) {
      setHint(`You can pick up to ${MAX_CLASSES} now and add more in Study later.`)
      return
    }
    const next = [...picked, name]
    setPicked(next)
    setAnnouncement(`${name} added. ${next.length} picked.`)
  }

  function addCustom() {
    const name = custom.trim().replace(/\s+/g, ' ').slice(0, COURSE_NAME_MAX)
    if (!name) return
    const existing = options.find((option) => option.toLowerCase() === name.toLowerCase())
    setCustom('')
    if (existing && picked.includes(existing)) {
      setAnnouncement(`${existing} is already picked.`)
      return
    }
    toggle(existing ?? name)
  }

  function onCustomKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    // Enter adds the typed class instead of submitting the step.
    event.preventDefault()
    addCustom()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    // A typed class that wasn't added yet still counts.
    const typed = custom.trim().replace(/\s+/g, ' ').slice(0, COURSE_NAME_MAX)
    const names = typed && !picked.some((item) => item.toLowerCase() === typed.toLowerCase()) && picked.length < MAX_CLASSES ? [...picked, typed] : picked
    if (!names.length) {
      onSkip()
      return
    }
    try {
      addClassesToBinder(names)
    } catch {
      // Storage can be unavailable; classes can still be added in Study.
    }
    onPicked(names)
    onNext()
  }

  const count = picked.length
  return (
    <form className="onb-step" aria-labelledby="onb-classes-title" onSubmit={submit}>
      <p className="onb-eyebrow">Your binder</p>
      <h1 className="onb-title" id="onb-classes-title" ref={headingRef} tabIndex={-1}>What are you studying?</h1>
      <p className="onb-lead">Pick your classes. Each one gets a spot in your binder with a first unit, ready for notes.</p>
      <fieldset className="onb-chips">
        <legend className="sr-only">Classes</legend>
        {options.map((name) => (
          <button key={name} className="onb-chip" type="button" aria-pressed={picked.includes(name)} onClick={() => toggle(name)}>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{picked.includes(name) ? <path d="m3.5 8.5 3 3 6-7" /> : <path d="M8 3.5v9M3.5 8h9" />}</svg>
            {name}
          </button>
        ))}
      </fieldset>
      <div className="onb-custom">
        <label className="sr-only" htmlFor="onb-custom-class">Another class</label>
        <input
          id="onb-custom-class"
          className="ui-input onb-input"
          value={custom}
          maxLength={COURSE_NAME_MAX}
          placeholder="Another class, e.g. AP Art History"
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="enter"
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={onCustomKey}
        />
        <button className="ui-button onb-custom__add" type="button" onClick={addCustom} disabled={!custom.trim()}>Add</button>
      </div>
      {hint ? <p className="onb-help" role="status">{hint}</p> : null}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <OnboardingActions primary={count ? `Add ${count} ${count === 1 ? 'class' : 'classes'}` : 'Continue'} onSkip={onSkip} />
    </form>
  )
}

/* ---------- Done ---------- */

function CameraIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="13" r="3.5" /></svg>
}
function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
}
function PasteIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="6" y="5" width="12" height="15" rx="1.5" /><path d="M9 5V3.5h6V5M9 10h6M9 13.5h6M9 17h3.5" /></svg>
}

function DoneStep({ headingRef, firstName, classes, returnTo, onOpen }: { headingRef: OnboardingStepProps['headingRef']; firstName: string; classes: string[]; returnTo: string; onOpen: (hash: string) => void }) {
  const where = classes.length ? `${classes[0]} › ${FIRST_UNIT}` : ''
  return (
    <section className="onb-step onb-done" aria-labelledby="onb-done-title">
      <p className="onb-eyebrow">Setup complete</p>
      <h1 className="onb-title" id="onb-done-title" ref={headingRef} tabIndex={-1}>You’re all set{firstName ? `, ${firstName}` : ''}</h1>
      <p className="onb-lead">
        {classes.length
          ? <>Your binder has {listNames(classes)}. Add notes and bindet turns them into flashcards and quizzes.</>
          : <>Next, add some notes. bindet turns them into flashcards and quizzes for you.</>}
      </p>
      <ul className="onb-ways" aria-label="Ways to add notes">
        <li className="ui-tone--blue"><span className="ui-icon"><CameraIcon /></span><span><b>Snap a photo</b><small>Handwritten or printed pages</small></span></li>
        <li className="ui-tone--violet"><span className="ui-icon"><UploadIcon /></span><span><b>Upload a file</b><small>PDF, DOCX, text or an image</small></span></li>
        <li className="ui-tone--green"><span className="ui-icon"><PasteIcon /></span><span><b>Paste text</b><small>From a doc, slides or a website</small></span></li>
      </ul>
      <div className="onb-actions onb-actions--done">
        <button className="ui-button ui-button--ghost onb-actions__skip" type="button" onClick={() => onOpen(returnTo || '#home')}>
          {returnTo ? 'Continue where I was' : 'Go to Home'}
        </button>
        <button className="ui-button ui-button--primary onb-actions__next" type="button" onClick={() => onOpen('#tools')}>
          Add your first notes
        </button>
      </div>
      {where ? <p className="onb-help onb-done__where">Opens Study at <b>{where}</b>.</p> : null}
    </section>
  )
}

/* ---------- Shell ---------- */

export function Onboarding({ session, hasProfile, onDone }: { session: AuthSession; hasProfile: boolean; onDone: (hash: string) => void }) {
  const userId = session.user.id
  const [returnTo] = useState(() => deepLink(window.location.hash))
  const steps = useMemo<StepId[]>(() => [
    ...(hasProfile ? [] : ['name' as const]),
    ...(binderHasUnits() ? [] : ['classes' as const]),
    'otto',
  ], [hasProfile])
  const [index, setIndex] = useState(() => Math.max(0, steps.indexOf(savedStep(userId) as StepId)))
  const [done, setDone] = useState(false)
  const [firstName, setFirstName] = useState(() => accountDisplayName(session.user).split(/\s+/)[0] ?? '')
  const [classes, setClasses] = useState<string[]>([])
  const heading = useRef<HTMLHeadingElement>(null)
  const step = steps[index]

  // Each step (and the last screen) moves focus to its heading, so screen readers hear the new step.
  useEffect(() => {
    if (!done) saveStep(userId, step)
    heading.current?.focus()
    window.scrollTo({ top: 0 })
  }, [done, step, userId])

  function finish() {
    void finishSetup(session.access_token, userId)
    setDone(true)
  }

  function next() {
    if (index < steps.length - 1) setIndex(index + 1)
    else finish()
  }

  function skipAll() {
    void finishSetup(session.access_token, userId)
    onDone(returnTo || '#home')
  }

  const stepProps = { headingRef: heading, onNext: next, onSkip: next }

  return (
    <div className="onb">
      <header className="onb-bar">
        <span className="onb-brand"><BrandMark size={24} />bindet</span>
        {!done ? (
          <>
            <ol className="onb-dots" aria-label={`Setup, step ${index + 1} of ${steps.length}`}>
              {steps.map((id, at) => (
                <li key={id} className={at < index ? 'is-done' : at === index ? 'is-current' : ''} aria-current={at === index ? 'step' : undefined}>
                  <span className="sr-only">{STEP_LABELS[id]}{at < index ? ', done' : ''}</span>
                </li>
              ))}
            </ol>
            <button className="ui-link onb-skip-all" type="button" onClick={skipAll}>Skip setup</button>
          </>
        ) : null}
      </header>
      <main className="onb-main" id="main-content">
        {!done ? <p className="onb-count" aria-hidden="true">Step {index + 1} of {steps.length}</p> : null}
        <div className="onb-sheet" key={done ? 'done' : step}>
          {done ? (
            <DoneStep headingRef={heading} firstName={firstName} classes={classes} returnTo={returnTo} onOpen={onDone} />
          ) : step === 'name' ? (
            <NameStep session={session} {...stepProps} onSaved={(name) => setFirstName(name.split(/\s+/)[0] ?? '')} />
          ) : step === 'classes' ? (
            <ClassesStep {...stepProps} onPicked={setClasses} />
          ) : (
            <OnboardingOttoStep {...stepProps} />
          )}
        </div>
      </main>
    </div>
  )
}
