import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ReviewCard, ReviewGrade, ReviewSummary } from '../lib/api'
import { useAnnounce } from '../lib/announce'
import { useData } from '../lib/dataSource'
import { announceReviewChange, formatInterval, GRADE_LABELS, GRADES, gradePreview, pendingGrades, relativeDue, spokenInterval, withFailedGrade, withoutCard, type FailedGrade } from '../lib/review'
import { MathText } from '../components/math/Math'

/*
 * Review mode: the saved flashcards that are due (and today's new ones), one at a time.
 * Front → Show answer (Space/Enter) → Again / Hard / Good / Easy (1–4), each labelled with
 * the interval it would give, computed from the card's schedule (lib/reviewSchedule.ts).
 *
 * Grading is optimistic: the next card shows at once and the grade is saved behind it.
 * If saving fails, a notice says so and offers Retry, which sends the same grade again
 * (the card is not shown again, so it can't come straight back). "Review more" waits for
 * grades still saving (and retries failed ones) before it asks for the next cards.
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
  /* What to do once nothing is left to review (e.g. quiz the unit), so the session isn't a dead end. */
  next?: { label: string; onClick: () => void }
}

const QUEUE_SIZE = 20

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function ReviewSession({ scope, accessToken, summary, focusControls, toneFor, next }: Props) {
  const data = useData()
  const crossUnit = !scope.course && !scope.unit
  const [queue, setQueue] = useState<ReviewCard[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [request, setRequest] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [done, setDone] = useState(0)
  // Grades that didn't save, to retry.
  const [unsaved, setUnsaved] = useState<FailedGrade<ReviewCard>[]>([])
  const [retrying, setRetrying] = useState(false)
  const pending = useRef(pendingGrades())
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
    // Only from the page itself or from inside Review; in the landing demo, only from inside.
    const active = document.activeElement
    const inside = Boolean(active && root.current?.contains(active))
    if (!inside && (data.sandboxed || (active && active !== document.body))) return
    if (revealed) goodButton.current?.focus({ preventScroll: true })
    else showButton.current?.focus({ preventScroll: true })
  }, [revealed, cardId, data])

  function save(graded: ReviewCard, choice: ReviewGrade) {
    return pending.current.track(data.gradeReviewCard(graded.id, choice, accessToken)
      .then((result) => {
        if (mounted.current) {
          setNextDue((current) => [...current, result.next_due_at])
          setUnsaved((current) => withoutCard(current, graded.id))
        }
        announceReviewChange()
      })
      .catch(() => {
        // Not saved: kept for Retry rather than shown again straight away.
        if (mounted.current) setUnsaved((current) => withFailedGrade(current, graded, choice))
      }))
  }

  function retry() {
    const failed = unsaved
    if (!failed.length || retrying) return Promise.resolve()
    setRetrying(true)
    setUnsaved([])
    return Promise.all(failed.map((item) => save(item.card, item.grade))).finally(() => {
      if (mounted.current) setRetrying(false)
    })
  }

  async function again() {
    setStatus('loading')
    setDone(0)
    setNextDue([])
    // Ask for more only once every grade is saved (or has failed), so none comes back.
    void retry()
    await pending.current.settled()
    if (mounted.current) setRequest((value) => value + 1)
  }

  function grade(choice: ReviewGrade) {
    const graded = queue[0]
    if (!graded || !revealed) return
    setQueue((current) => current.slice(1))
    setDone((value) => value + 1)
    setRevealed(false)
    setUnsaved((current) => withoutCard(current, graded.id))
    void save(graded, choice)
  }

  // Space/Enter shows the answer; 1–4 grade it. Typing in a field, or a key meant for
  // another focused control, is left alone.
  useEffect(() => {
    if (!card) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      // Keys typed elsewhere on the landing page never reach the demo.
      const panel = root.current?.closest('.tools__cards') ?? root.current
      const inside = Boolean(target && panel?.contains(target))
      if (!inside && (data.sandboxed || (target && target !== document.body))) return
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

  // The finished-session summary and the done message. Computed here so the same words
  // can be announced through the shared live regions (lib/announce.ts).
  // Units have no "next due" of their own in the summary; this session's grades say it.
  const upcoming = crossUnit
    ? summary?.next_due_at ?? null
    : nextDue.toSorted()[0] ?? null
  const unitCounts = crossUnit ? null : summary?.by_unit.find((entry) => entry.course === scope.course && entry.unit === scope.unit)
  const moreDue = crossUnit ? summary?.due ?? 0 : unitCounts?.due ?? 0
  const moreNew = crossUnit ? summary?.new_available ?? 0 : unitCounts?.new ?? 0
  const when = relativeDue(upcoming, data.now())
  const doneTitle = done ? 'All caught up' : 'Nothing to review right now'
  const doneCopy = `${done ? `You reviewed ${plural(done, 'card')}. ` : ''}${when ? `Next review ${when === 'now' ? 'is ready now' : when}.` : moreNew || moreDue ? '' : 'Cards you’ve studied come back here when they’re due.'}`

  // Status and alerts keep no live role of their own, so nothing is read twice.
  const unsavedText = unsaved.length === 1 ? 'A grade didn’t save. Check your connection and retry.' : `${unsaved.length} grades didn’t save. Check your connection and retry.`
  useAnnounce(unsaved.length ? unsavedText : '', { error: true })
  useAnnounce(status === 'loading' ? 'Loading cards to review…' : '')
  useAnnounce(status === 'error' ? 'Your review cards didn’t load. Check your connection and try again.' : '', { error: true })
  useAnnounce(status === 'ready' && !card ? `${doneTitle}. ${doneCopy}`.trim() : '')

  const notice = unsaved.length ? (
    <div className="ui-alert tools__review-notice">
      <span>{unsavedText}</span>
      <button className="ui-button ui-button--sm" type="button" onClick={() => { void retry() }} disabled={retrying}>Retry</button>
      <button className="ui-button ui-button--ghost ui-button--sm tools__review-dismiss" type="button" onClick={() => setUnsaved([])}>Dismiss</button>
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
        <p className="tools__status"><span className="ui-spinner" />Loading cards to review…</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="tools__cards-error">
        <div className="ui-alert">
          <span>Your review cards didn’t load. Check your connection and try again.</span>
          <button className="ui-button ui-button--sm tools__review-more" type="button" onClick={again}>Retry</button>
        </div>
      </div>
    )
  }

  if (!card) {
    return (
      <div className="tools__review-done">
        {notice}
        <h3 className="tools__review-done-title">{doneTitle}</h3>
        <p className="tools__review-done-copy">{doneCopy}</p>
        {moreDue ? (
          <button className="ui-button ui-button--primary tools__review-more" type="button" onClick={again}>Review {plural(moreDue, 'more due card')}</button>
        ) : moreNew ? (
          <button className={`ui-button${done ? '' : ' ui-button--primary'} tools__review-more`} type="button" onClick={again}>Review {moreNew} more new {moreNew === 1 ? 'card' : 'cards'}</button>
        ) : next ? (
          <button className="ui-button ui-button--primary tools__review-next" type="button" onClick={next.onClick}>{next.label}</button>
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
