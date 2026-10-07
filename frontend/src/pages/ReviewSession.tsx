import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ReviewCard, ReviewGrade, ReviewSummary } from '../lib/api'
import { useData } from '../lib/dataSource'
import { announceReviewChange, formatInterval, GRADE_LABELS, GRADES, gradePreview, relativeDue, spokenInterval } from '../lib/review'
import { MathText } from '../components/math/Math'

/*
 * Review mode: the saved flashcards that are due (and today's new ones), one at a time.
 * Front → Show answer (Space/Enter) → Again / Hard / Good / Easy (1–4), each labelled with
 * the interval it would give, computed from the card's schedule (lib/reviewSchedule.ts).
 *
 * Grading is optimistic: the next card shows at once and the grade is saved behind it.
 * If saving fails, the card goes back to the end of the queue and a small notice says so.
 * Every saved grade announces REVIEW_CHANGED_EVENT, so due counts elsewhere refresh.
 *
 * scope: one unit, or every unit when course and unit are left out (cards then show
 * their course › unit). All data goes through useData(), so the landing demo reviews its
 * in-memory cards and nothing leaves the page.
 */

type Scope = { course?: string; unit?: string }

type Props = {
  scope: Scope
  accessToken?: string
  summary: ReviewSummary | null
  /* The Focus toggle and text size controls (Focus mode styles come from the panel). */
  focusControls: ReactNode
  /* Course color for a card (cross-unit review marks each card with its course). */
  toneFor?: (course: string) => string | undefined
}

const QUEUE_SIZE = 20

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function ReviewSession({ scope, accessToken, summary, focusControls, toneFor }: Props) {
  const data = useData()
  const crossUnit = !scope.course && !scope.unit
  const [queue, setQueue] = useState<ReviewCard[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [request, setRequest] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [done, setDone] = useState(0)
  const [failed, setFailed] = useState(0)
  // When each card graded in this session is next due, for "next review …" in a unit.
  const [nextDue, setNextDue] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)
  const showButton = useRef<HTMLButtonElement>(null)
  const goodButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The queue for this scope; "Review more" asks again.
  useEffect(() => {
    const controller = new AbortController()
    data.getReviewQueue({ course: scope.course, unit: scope.unit, limit: QUEUE_SIZE }, accessToken, controller.signal)
      .then((result) => {
        setQueue(result.cards)
        setRevealed(false)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
        setStatus('error')
      })
    return () => controller.abort()
  }, [data, accessToken, scope.course, scope.unit, request])

  const card = queue[0] ?? null
  const total = done + queue.length
  const dueLeft = queue.filter((item) => item.review.state !== 'new').length
  const newLeft = queue.length - dueLeft
  const preview = card ? gradePreview(card) : null

  // Keyboard focus follows the step: Show answer, then Good once the answer is showing.
  const cardId = card?.id
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body && !root.current?.contains(active)) return
    if (revealed) goodButton.current?.focus({ preventScroll: true })
    else showButton.current?.focus({ preventScroll: true })
  }, [revealed, cardId])

  function again() {
    setStatus('loading')
    setDone(0)
    setNextDue([])
    setRequest((value) => value + 1)
  }

  function grade(choice: ReviewGrade) {
    const graded = queue[0]
    if (!graded || !revealed) return
    setQueue((current) => current.slice(1))
    setDone((value) => value + 1)
    setRevealed(false)
    data.gradeReviewCard(graded.id, choice, accessToken)
      .then((result) => {
        if (mounted.current) setNextDue((current) => [...current, result.next_due_at])
        announceReviewChange()
      })
      .catch(() => {
        if (!mounted.current) return
        // Not saved: the card comes back at the end of the queue to grade again.
        setQueue((current) => [...current.filter((item) => item.id !== graded.id), graded])
        setDone((value) => Math.max(0, value - 1))
        setFailed((value) => value + 1)
      })
  }

  // Space/Enter shows the answer; 1–4 grade it. Typing in a field, or a key meant for
  // another focused control, is left alone.
  useEffect(() => {
    if (!card) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable], dialog, [role="dialog"]')) return
      if (event.key === ' ' || event.key === 'Enter') {
        const control = target?.closest('button, a, summary')
        if (revealed || (control && !control.hasAttribute('data-review-key'))) return
        event.preventDefault()
        if (!event.repeat) setRevealed(true)
        return
      }
      const index = ['1', '2', '3', '4'].indexOf(event.key)
      if (index < 0 || !revealed || event.repeat) return
      event.preventDefault()
      grade(GRADES[index])
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const notice = failed ? (
    <div className="ui-alert tools__review-notice" role="alert">
      <span>{failed === 1 ? 'A grade didn’t save.' : `${failed} grades didn’t save.`} {queue.length ? 'The card is back at the end of the queue.' : 'Try again.'}</span>
      <button className="ui-button ui-button--ghost ui-button--sm tools__review-dismiss" type="button" onClick={() => setFailed(0)}>Dismiss</button>
    </div>
  ) : null

  if (status === 'loading') {
    return (
      <div className="tools__card-loading" aria-busy="true">
        <div className="tools__card tools__card--skeleton" aria-hidden="true">
          <span className="ui-skeleton" />
          <span className="ui-skeleton" />
          <span className="ui-skeleton" />
        </div>
        <p className="tools__status" role="status"><span className="ui-spinner" />Loading cards to review…</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="tools__cards-error">
        <div className="ui-alert" role="alert">
          <span>Your review cards didn’t load. Check your connection and try again.</span>
          <button className="ui-button ui-button--sm tools__review-more" type="button" onClick={again}>Retry</button>
        </div>
      </div>
    )
  }

  if (!card) {
    // Units have no "next due" of their own in the summary; this session's grades say it.
    const upcoming = crossUnit
      ? summary?.next_due_at ?? null
      : nextDue.toSorted()[0] ?? null
    const unitCounts = crossUnit ? null : summary?.by_unit.find((entry) => entry.course === scope.course && entry.unit === scope.unit)
    const moreDue = crossUnit ? summary?.due ?? 0 : unitCounts?.due ?? 0
    const moreNew = crossUnit ? summary?.new_available ?? 0 : unitCounts?.new ?? 0
    const when = relativeDue(upcoming, data.now())
    return (
      <div className="tools__review-done" role="status">
        {notice}
        <h3 className="tools__review-done-title">{done ? 'All caught up' : 'Nothing to review right now'}</h3>
        <p className="tools__review-done-copy">
          {done ? `You reviewed ${plural(done, 'card')}. ` : ''}
          {when ? `Next review ${when === 'now' ? 'is ready now' : when}.` : moreNew || moreDue ? '' : 'New cards show up here as you add notes.'}
        </p>
        {moreDue ? (
          <button className="ui-button ui-button--primary tools__review-more" type="button" onClick={again}>Review {plural(moreDue, 'more due card')}</button>
        ) : moreNew ? (
          <button className={`ui-button${done ? '' : ' ui-button--primary'} tools__review-more`} type="button" onClick={again}>Review {moreNew} more new {moreNew === 1 ? 'card' : 'cards'}</button>
        ) : null}
      </div>
    )
  }

  const tone = crossUnit ? toneFor?.(card.course) : undefined
  return (
    <div className="tools__review" ref={root}>
      <div className="tools__review-head">
        <p className="tools__review-counts">
          <span><strong>{dueLeft}</strong> due</span>
          <span aria-hidden="true">·</span>
          <span><strong>{newLeft}</strong> new</span>
        </p>
        <div className="tools__focus-bar tools__review-focus">{focusControls}</div>
      </div>
      <div className="tools__card-progress tools__review-progress" role="progressbar" aria-label="Review progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <span style={{ transform: `scaleX(${total ? done / total : 0})` }} />
      </div>
      <p className="sr-only" aria-live="polite">Card {done + 1} of {total}</p>
      {notice}

      <div className={`tools__card tools__review-card${revealed ? ' is-flipped' : ''}`} style={tone ? { ['--course' as string]: tone } : undefined}>
        {crossUnit ? (
          <span className="tools__review-place">
            <span className="tools__review-dot" aria-hidden="true" />
            {card.course} <span aria-hidden="true">›</span><span className="sr-only">,</span> {card.unit}
          </span>
        ) : null}
        <span className="tools__card-face" key={card.id}>
          <span className="tools__card-label">{card.review.state === 'new' ? 'New card' : 'Question'}</span>
          <span className="tools__card-text"><MathText text={card.front} /></span>
        </span>
        {revealed ? (
          <span className="tools__card-face tools__review-answer">
            <span className="tools__card-label">Answer</span>
            <span className="tools__card-text"><MathText text={card.back} /></span>
          </span>
        ) : null}
      </div>

      {revealed && preview ? (
        <div className="tools__review-grades" role="group" aria-label="How well did you know it?">
          {GRADES.map((choice, index) => (
            <button
              key={choice}
              ref={choice === 'good' ? goodButton : undefined}
              className={`ui-button tools__review-grade tools__review-grade--${choice}`}
              type="button"
              onClick={() => grade(choice)}
              aria-label={`${GRADE_LABELS[choice]}, next review in ${spokenInterval(preview[choice])}`}
              aria-keyshortcuts={String(index + 1)}
            >
              <span className="tools__review-grade-label">{GRADE_LABELS[choice]}</span>
              <span className="tools__review-grade-when">{formatInterval(preview[choice])}</span>
            </button>
          ))}
        </div>
      ) : (
        <button ref={showButton} className="ui-button ui-button--primary tools__review-show" type="button" data-review-key="" onClick={() => setRevealed(true)}>
          Show answer
        </button>
      )}
      <p className="tools__keys">
        {revealed ? <><kbd>1</kbd> Again · <kbd>2</kbd> Hard · <kbd>3</kbd> Good · <kbd>4</kbd> Easy</> : <><kbd>Space</kbd> or <kbd>Enter</kbd> shows the answer</>}
      </p>
    </div>
  )
}
