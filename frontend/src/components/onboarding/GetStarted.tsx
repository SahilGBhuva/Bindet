import { useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../../lib/auth'
import { getOnboarding, ONBOARDING_CHANGED_EVENT, saveOnboarding, type OnboardingState, type OnboardingSteps } from '../../lib/onboarding'
import './GetStarted.css'

/*
 * "Get started" on Home for accounts that just went through the welcome setup: four
 * first steps that tick off by themselves from the account's real data (the server
 * counts notes, flashcards, quiz or practice answers and Otto conversations). It can
 * be hidden at any time; that choice is saved on the server. Rendered by the signed-in
 * app only, never by the landing page demo.
 */

const ITEMS: { key: keyof OnboardingSteps; title: string; copy: string; href: string; action: string }[] = [
  { key: 'notes', title: 'Add your first notes', copy: 'Snap a photo, upload a file or paste text in Study.', href: '#tools', action: 'Add notes' },
  { key: 'flashcards', title: 'Get flashcards', copy: 'bindet writes them from your notes. Open Flashcards in the unit.', href: '#tools', action: 'Open Study' },
  { key: 'quiz', title: 'Try a quiz', copy: 'Answer a few questions on a unit, or play a quick round.', href: '#tools', action: 'Quiz me' },
  { key: 'tutor', title: 'Ask Otto a question', copy: 'Otto explains anything you’re stuck on, step by step.', href: '#tutor', action: 'Ask Otto' },
]

function CheckIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.5 8.5 3 3 6-7" /></svg>
}

export function GetStarted({ session }: { session: AuthSession }) {
  const token = session.access_token
  const [state, setState] = useState<OnboardingState | null>(null)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    const controller = new AbortController()
    const load = () => {
      void getOnboarding(token, controller.signal).then((value) => { if (live.current) setState(value) }, () => undefined)
    }
    load()
    // Ticks follow the student's work: check again on return to the tab.
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener(ONBOARDING_CHANGED_EVENT, load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live.current = false
      controller.abort()
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [token])

  if (!state || hidden || !state.tracked || !state.setup_done || state.checklist_dismissed) {
    return error ? <p className="get-started__error ui-alert" role="alert">{error}</p> : null
  }

  const doneCount = ITEMS.filter((item) => state.steps[item.key]).length
  const allDone = doneCount === ITEMS.length
  const nextKey = ITEMS.find((item) => !state.steps[item.key])?.key

  function dismiss() {
    setHidden(true)
    setError('')
    void saveOnboarding(token, { checklist_dismissed: true }).catch(() => {
      if (!live.current) return
      setHidden(false)
      setError('Couldn’t hide the Get started list. Try again.')
    })
  }

  return (
    <section className={`get-started${allDone ? ' is-complete' : ''}`} aria-labelledby="get-started-title">
      <header className="get-started__head">
        <div>
          <h2 className="get-started__title" id="get-started-title">{allDone ? 'You’ve got the basics' : 'Get started'}</h2>
          <p className="get-started__count">
            {allDone ? 'Every first step is done. Nice work.' : <>{doneCount} of {ITEMS.length} done</>}
          </p>
        </div>
        {allDone ? <img className="ui-mascot-cheer get-started__cheer" src="/bindit-mascot-cutout.webp" alt="" width="36" height="43" /> : null}
        <button className="ui-button ui-button--ghost ui-button--sm get-started__hide" type="button" onClick={dismiss}>
          {allDone ? 'Done' : 'Hide'}<span className="sr-only"> the Get started list</span>
        </button>
      </header>
      <div className="ui-meter get-started__meter" role="progressbar" aria-label="Get started progress" aria-valuemin={0} aria-valuemax={ITEMS.length} aria-valuenow={doneCount}>
        <span style={{ width: `${(doneCount / ITEMS.length) * 100}%` }} />
      </div>
      {error ? <p className="get-started__error" role="alert">{error}</p> : null}
      {allDone ? null : (
        <ol className="get-started__list">
          {ITEMS.map((item, index) => {
            const done = state.steps[item.key]
            return (
              <li key={item.key} className={`get-started__item${done ? ' is-done' : ''}${item.key === nextKey ? ' is-next' : ''}`}>
                <span className="get-started__mark" aria-hidden="true">{done ? <CheckIcon /> : index + 1}</span>
                <span className="get-started__text">
                  <strong>{item.title}{done ? <span className="sr-only">, done</span> : null}</strong>
                  {done ? null : <span>{item.copy}</span>}
                </span>
                {done ? null : (
                  <a className={`ui-button ui-button--sm get-started__go${item.key === nextKey ? ' ui-button--primary' : ''}`} href={item.href}>
                    {item.action}
                  </a>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
