import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { AuthSession } from '../lib/auth'
import {
  askHelpBot, getHelpUsage, helpEntry, HELP_DAILY_LIMIT, HELP_QUESTION_MAX, isSmallTalk, matchHelp, parseAnswer,
  SUGGESTED_HELP, type HelpUsage,
} from '../lib/helpBot'

type Source = 'faq' | 'ai' | 'local'
type Turn = { id: number; question: string; answer: string; source: Source }

const GREETING = 'Hi! Ask me how to do something in bindet, like adding notes or joining a study group.'
const OUT_OF_QUESTIONS = 'You’ve used today’s AI help questions. The suggested questions still work, and the guides in Settings → Help & feedback (#settings?help) cover every part of bindet.'
const NOT_SURE = 'I’m not sure about that one. The guides in Settings → Help & feedback (#settings?help) cover every part of bindet.'
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
const MAX_TURNS = 6

/* Turns kept for this visit only (never stored), so reopening the panel shows them again. */
let savedTurns: Turn[] = []
let nextId = 1

function Answer({ text, onNavigate }: { text: string; onNavigate: () => void }) {
  const { pieces, links } = parseAnswer(text)
  return (
    <>
      <p className="helpbot__answer-text">
        {pieces.map((piece, index) => 'email' in piece
          ? <a key={index} className="ui-link" href={`mailto:${piece.email}`}>{piece.email}</a>
          : <span key={index}>{piece.text}</span>)}
      </p>
      {links.length ? (
        <p className="helpbot__links">
          {links.map((link) => (
            <a key={link.href} className="helpbot__link" href={link.href} onClick={onNavigate}>
              Open {link.label}
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
            </a>
          ))}
        </p>
      ) : null}
    </>
  )
}

function usageLine(usage: HelpUsage | null) {
  if (!usage) return 'Suggested questions are always free.'
  if (usage.remaining_today === null) return 'Suggested questions are free. No daily AI limit on this account.'
  const left = usage.remaining_today
  return `Suggested questions are free. ${left} of ${usage.daily_limit || HELP_DAILY_LIMIT} AI questions left today.`
}

export function HelpBotPanel({ session, onClose }: { session: AuthSession; onClose: (restoreFocus?: boolean) => void }) {
  const [turns, setTurns] = useState<Turn[]>(savedTurns)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<HelpUsage | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const log = useRef<HTMLOListElement>(null)
  const titleId = useId()
  const introId = useId()
  const token = session.access_token

  useEffect(() => { savedTurns = turns }, [turns])

  useEffect(() => {
    const controller = new AbortController()
    void getHelpUsage(token, controller.signal).then(setUsage).catch(() => undefined)
    return () => controller.abort()
  }, [token])

  // Focus moves into the panel: the question box with a mouse or keyboard, the panel itself
  // on touch screens (so the on-screen keyboard doesn't open over the suggestions).
  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    if (fine) input.current?.focus()
    else panel.current?.focus()
  }, [])

  useEffect(() => {
    const list = log.current
    if (list) list.scrollTop = list.scrollHeight
  }, [turns, busy])

  // A click outside the panel (except on its own corner button) closes it.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target || panel.current?.contains(target)) return
      if (target instanceof Element && target.closest('.helpbot__fab')) return
      onClose(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !panel.current) return
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function add(questionText: string, answer: string, source: Source) {
    setTurns((current) => [...current, { id: nextId++, question: questionText, answer, source }].slice(-MAX_TURNS))
  }

  function askSuggested(id: string) {
    const entry = helpEntry(id)
    if (!entry || busy) return
    setError('')
    add(entry.question, entry.answer, 'faq')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = question.trim().slice(0, HELP_QUESTION_MAX)
    if (!text || busy) return
    setError('')
    setQuestion('')
    if (isSmallTalk(text)) {
      add(text, GREETING, 'local')
      return
    }
    const match = matchHelp(text)
    if (match) {
      add(text, match.entry.answer, 'faq')
      return
    }
    if (usage && usage.remaining_today === 0) {
      add(text, OUT_OF_QUESTIONS, 'local')
      return
    }
    setBusy(true)
    try {
      const reply = await askHelpBot(text, token)
      setUsage({ daily_limit: reply.daily_limit, hourly_limit: reply.hourly_limit, remaining_today: reply.remaining_today, remaining_this_hour: reply.remaining_this_hour })
      add(text, reply.answer || NOT_SURE, reply.source === 'ai' || reply.source === 'cache' ? 'ai' : 'local')
    } catch (caught) {
      setQuestion(text)
      setError(caught instanceof Error && caught.message ? caught.message : 'The help bot couldn’t answer. Try again in a moment.')
      void getHelpUsage(token).then(setUsage).catch(() => undefined)
    }
    setBusy(false)
  }

  const navigate = () => onClose(false)
  const asked = new Set(turns.map((turn) => turn.question))
  const suggestions = SUGGESTED_HELP.map(helpEntry).filter((entry) => entry && !asked.has(entry.question))

  return (
    <div
      ref={panel}
      className="helpbot__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={introId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="helpbot__head">
        <div>
          <h2 className="helpbot__title" id={titleId}>Need help using bindet?</h2>
          <p className="helpbot__intro" id={introId}>Pick a question or ask your own. For schoolwork, ask Otto.</p>
        </div>
        <button type="button" className="helpbot__close" aria-label="Close help" onClick={() => onClose()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

      <div className="helpbot__body">
        {turns.length ? (
          <ol className="helpbot__log" ref={log} aria-label="Answers">
            {turns.map((turn) => (
              <li key={turn.id} className="helpbot__turn">
                <p className="helpbot__question"><span className="sr-only">You asked: </span>{turn.question}</p>
                <div className="helpbot__answer">
                  <Answer text={turn.answer} onNavigate={navigate} />
                  {turn.source === 'ai' ? <span className="helpbot__badge">AI answer · may be wrong</span> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {busy ? 'Looking for an answer…' : turns.length ? `Answer: ${parseAnswer(turns[turns.length - 1].answer).pieces.map((piece) => 'email' in piece ? piece.email : piece.text).join('')}` : ''}
        </p>
        {busy ? <p className="helpbot__thinking" aria-hidden="true"><span className="ui-spinner" />Looking for an answer…</p> : null}

        {suggestions.length ? (
          <div className="helpbot__suggest">
            <h3 className="helpbot__label">{turns.length ? 'More questions' : 'Common questions'}</h3>
            <ul className="helpbot__chips">
              {suggestions.map((entry) => entry ? (
                <li key={entry.id}>
                  <button type="button" className="helpbot__chip" onClick={() => askSuggested(entry.id)} disabled={busy}>{entry.question}</button>
                </li>
              ) : null)}
            </ul>
          </div>
        ) : null}
      </div>

      <form className="helpbot__form" onSubmit={(event) => void submit(event)}>
        {error ? <p className="helpbot__error" role="alert">{error}</p> : null}
        <div className="helpbot__row">
          <label className="sr-only" htmlFor={`${titleId}-question`}>Your question about bindet</label>
          <input
            ref={input}
            id={`${titleId}-question`}
            className="ui-input helpbot__input"
            value={question}
            maxLength={HELP_QUESTION_MAX}
            placeholder="How do I…"
            autoComplete="off"
            enterKeyHint="send"
            aria-describedby={`${titleId}-usage`}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button type="submit" className={`ui-button ui-button--primary helpbot__send${busy ? ' is-busy' : ''}`} disabled={!question.trim() || busy}>Ask</button>
        </div>
        <p className="helpbot__usage" id={`${titleId}-usage`}>
          <span>{usageLine(usage)}</span>
          {question.length > HELP_QUESTION_MAX - 40 ? <span className="helpbot__count">{question.length}/{HELP_QUESTION_MAX}</span> : null}
        </p>
      </form>
    </div>
  )
}
