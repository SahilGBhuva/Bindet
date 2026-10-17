import { useEffect, useState, type KeyboardEvent } from 'react'
import { ApiError, getOttoDeck, isAbortError, type OttoDeck } from '../../lib/api'
import { QUIZ_COUNTS } from '../../lib/ottoMake'
import { MathText } from '../math/Math'
import './OttoMake.css'

/*
 * What Otto made in the chat: the flashcard deck card (a preview, "Study now" to flip through
 * just these cards right here, "Open in Study"), the picker Otto shows when the chat has no
 * course or unit yet, and the progress line while Otto works.
 */

export function OttoMaking({ label }: { label: string }) {
  return (
    <div className="otto-making" role="status">
      <span className="otto-making__spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

function DeckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M8 4h11a2 2 0 0 1 2 2v9" /></svg>
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function OttoDeckCard({ noteId, accessToken, tone, onOpenStudy }: { noteId: string; accessToken: string; tone?: string; onOpenStudy: (deck: OttoDeck) => void }) {
  const [deck, setDeck] = useState<OttoDeck | null>(null)
  const [error, setError] = useState('')
  const [studying, setStudying] = useState(false)
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getOttoDeck(accessToken, noteId, controller.signal).then(setDeck).catch((caught) => {
      if (isAbortError(caught)) return
      setError(caught instanceof ApiError && caught.status === 404 ? 'This deck was deleted.' : 'This deck couldn’t be loaded.')
    })
    return () => controller.abort()
  }, [noteId, accessToken])

  const style = tone ? { ['--course' as string]: tone } : undefined
  if (error) return <div className="otto-card otto-card--deck is-muted"><p className="otto-card__note">{error}</p></div>
  if (!deck) return <div className="otto-card otto-card--deck is-loading" aria-busy="true"><span className="ui-skeleton otto-card__skeleton" /></div>

  const title = deck.title.replace(/^From Otto: /, '')
  const cards = deck.cards
  const card = cards[index]

  function move(step: number) {
    setFlipped(false)
    setIndex((value) => Math.min(cards.length - 1, Math.max(0, value + step)))
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
  }

  return (
    <section className="otto-card otto-card--deck" style={style} aria-label={`Flashcards: ${title}`}>
      <header className="otto-card__head">
        <span className="otto-card__icon" aria-hidden="true"><DeckIcon /></span>
        <span className="otto-card__titles">
          <span className="otto-card__kicker">Flashcard deck · {plural(cards.length, 'card')}</span>
          <span className="otto-card__title">{title}</span>
          <span className="otto-card__place"><i className="otto-card__dot" aria-hidden="true" />{deck.course} · {deck.unit}</span>
        </span>
      </header>
      {studying && card ? (
        <div className="otto-flip" onKeyDown={onKeyDown}>
          <button type="button" className={`otto-flip__card${flipped ? ' is-flipped' : ''}`} onClick={() => setFlipped((value) => !value)}
            aria-label={`Card ${index + 1} of ${cards.length}. ${flipped ? 'Showing the answer' : 'Showing the question'}. Tap to flip.`}>
            <span className="otto-flip__label">{flipped ? 'Answer' : 'Question'}</span>
            <span className="otto-flip__text"><MathText text={flipped ? card.back : card.front} /></span>
            <span className="otto-flip__tap" aria-hidden="true">{flipped ? 'Tap for the question' : 'Tap to see the answer'}</span>
          </button>
          <div className="otto-flip__nav">
            <button type="button" className="otto-pill otto-pill--quiet" onClick={() => move(-1)} disabled={index === 0}>Back</button>
            <span className="otto-flip__count">{index + 1} / {cards.length}</span>
            {index + 1 < cards.length
              ? <button type="button" className="otto-pill" onClick={() => move(1)}>Next card</button>
              : <button type="button" className="otto-pill" onClick={() => { setStudying(false); setIndex(0); setFlipped(false) }}>Done</button>}
          </div>
        </div>
      ) : (
        <>
          {cards.length ? (
            <ul className="otto-card__preview">
              {cards.slice(0, 2).map((item) => (
                <li key={item.id}>
                  <span className="otto-card__q"><MathText text={item.front} /></span>
                  <span className="otto-card__a"><MathText text={item.back} /></span>
                </li>
              ))}
            </ul>
          ) : <p className="otto-card__note">These cards are still being made, or were removed in Study.</p>}
          <div className="otto-card__actions">
            {cards.length ? <button type="button" className="otto-pill" onClick={() => setStudying(true)}>Study now</button> : null}
            <button type="button" className="otto-pill otto-pill--quiet" onClick={() => onOpenStudy(deck)}>Open in Study</button>
          </div>
        </>
      )}
    </section>
  )
}

type Course = { name: string; units: string[] }

/* Otto asks which course and unit to save a deck or quiz to (the chat has none yet). */
export function OttoPicker({ kind, count, courses, initialCourse, initialUnit, busy, error, onPick }: {
  kind: 'flashcards' | 'quiz'
  count: number
  courses: Course[]
  initialCourse: string
  initialUnit: string
  busy: boolean
  error: string
  onPick: (course: string, unit: string, count: number) => void
}) {
  const [course, setCourse] = useState(initialCourse || courses[0]?.name || '')
  const units = courses.find((item) => item.name === course)?.units ?? []
  const [unit, setUnit] = useState(initialUnit && units.includes(initialUnit) ? initialUnit : units[0] ?? '')
  const [size, setSize] = useState(QUIZ_COUNTS.includes(count as 5 | 8 | 12) ? count : 8)
  if (!courses.length) {
    return <div className="otto-card otto-card--pick"><p className="otto-card__note">Add a course and unit in Study first, then ask me again.</p></div>
  }
  return (
    <form className={`otto-card otto-card--pick${kind === 'quiz' ? ' is-quiz' : ''}`} onSubmit={(event) => { event.preventDefault(); if (course && unit) onPick(course, unit, size) }}>
      <div className="otto-pick__fields">
        <label>
          <span>Course</span>
          <select className="ui-select" value={course} disabled={busy} onChange={(event) => {
            setCourse(event.target.value)
            setUnit(courses.find((item) => item.name === event.target.value)?.units[0] ?? '')
          }}>
            {courses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>Unit</span>
          <select className="ui-select" value={unit} disabled={busy || !units.length} onChange={(event) => setUnit(event.target.value)}>
            {units.length ? units.map((item) => <option key={item} value={item}>{item}</option>) : <option value="">No units yet</option>}
          </select>
        </label>
      </div>
      {kind === 'quiz' ? (
        <div className="otto-pick__count" role="group" aria-label="Questions">
          {QUIZ_COUNTS.map((value) => (
            <button key={value} type="button" className="otto-count" aria-pressed={size === value} disabled={busy} onClick={() => setSize(value)}>{value} questions</button>
          ))}
        </div>
      ) : null}
      {error ? <p className="otto-card__error" role="alert">{error}</p> : null}
      <button type="submit" className={`otto-pill${busy ? ' is-busy' : ''}`} disabled={busy || !course || !unit}>
        {busy ? (kind === 'quiz' ? 'Writing your practice test…' : 'Making flashcards…') : kind === 'quiz' ? 'Save and make the quiz' : 'Save and make flashcards'}
      </button>
    </form>
  )
}
