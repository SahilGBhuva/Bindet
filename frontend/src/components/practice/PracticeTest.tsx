import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ApiError, isAbortError, parseServerTime, RequestTimeoutError } from '../../lib/api'
import type { PracticeTest as PracticeTestData, PracticeTestOptions, PracticeTestSummary } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { clearPracticeDraft, formatClock, loadPracticeDraft, savePracticeDraft, suggestedMinutes } from '../../lib/practice'
import { INSTRUCTIONS_MAX } from '../../lib/studyPrefs'
import { MathText } from '../math/Math'
import './PracticeTest.css'

/*
 * A timed practice test from a unit's (or a whole course's) notes: a setup sheet, one
 * question per page with a navigator, and a score report with a per-topic breakdown and
 * every question reviewed. Answers in progress are kept in this tab's sessionStorage
 * (never in the demo). Every request goes through useData(), so the landing demo runs
 * the same component on an in-memory sandbox.
 */

type Stage = 'setup' | 'loading' | 'starting' | 'test' | 'submitting' | 'results'

const COUNTS = [5, 10, 15]
const WARNINGS = [300, 60]

type Props = {
  course: string
  // null: the whole course.
  unit: string | null
  accessToken?: string
  // An existing test to open (resume one in progress, or review a submitted one).
  openId?: string
  focusOn: boolean
  focusStyle: CSSProperties
  focusControls: ReactNode
  onClose: () => void
  // The list of tests changed (one started or submitted), so the Quiz panel can refresh.
  onChanged?: () => void
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function failure(error: unknown, fallback: string) {
  if (error instanceof RequestTimeoutError) return error.message
  if (error instanceof ApiError && error.message) return error.message
  if (error instanceof Error && error.message && !(error instanceof TypeError)) return error.message
  return fallback
}

const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function when(value: string | null) {
  const time = parseServerTime(value)
  return Number.isNaN(time) ? '' : dayTime.format(time)
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
}

function CrossIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
}

function FlagIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4M6 4h11l-2 4 2 4H6" /></svg>
}

function ClockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9.5 3h5" /></svg>
}

export function PracticeTest({ course, unit, accessToken, openId, focusOn, focusStyle, focusControls, onClose, onChanged }: Props) {
  const data = useData()
  const scopeLabel = unit ?? `all of ${course}`
  const [stage, setStage] = useState<Stage>(openId ? 'loading' : 'setup')
  const [count, setCount] = useState(10)
  const [timed, setTimed] = useState(!data.sandboxed)
  const [minutes, setMinutes] = useState(String(suggestedMinutes(10)))
  const [minutesEdited, setMinutesEdited] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [instructionsError, setInstructionsError] = useState('')
  const [error, setError] = useState('')
  const [test, setTest] = useState<PracticeTestData | null>(null)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [flags, setFlags] = useState<number[]>([])
  const [current, setCurrent] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [now, setNow] = useState(() => data.now())
  const [announcement, setAnnouncement] = useState('')
  const [history, setHistory] = useState<PracticeTestSummary[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  // The settings the current test was started with, for Retake and Practice my weak spots.
  const lastOptions = useRef<PracticeTestOptions | null>(null)
  // Server time minus this device's time, so the countdown follows the server's deadline.
  const [clockOffset, setClockOffset] = useState(0)
  const warned = useRef(new Set<number>())
  const autoSubmitted = useRef(false)
  const submitting = useRef(false)
  const mounted = useRef(true)
  const questionHeading = useRef<HTMLHeadingElement>(null)
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const timeLimit = timed ? Math.min(60, Math.max(5, Math.round(Number(minutes)) || suggestedMinutes(count))) : null
  const minutesValid = !timed || (/^\d{1,2}$/.test(minutes.trim()) && Number(minutes) >= 5 && Number(minutes) <= 60)
  const deadline = test?.deadline ? parseServerTime(test.deadline) : NaN
  const remaining = Number.isNaN(deadline) ? null : Math.max(0, (deadline - (now + clockOffset)) / 1000)
  const items = test?.items ?? []
  const item = items[current] ?? null
  const answered = (position: number) => Boolean(answers[position]?.trim())
  const unanswered = items.filter((entry) => !answered(entry.position)).map((entry) => entry.position)
  const sameScope = (entry: PracticeTestSummary) => (unit === null ? entry.unit === null : entry.unit === unit)
  const scopeHistory = (history ?? []).filter(sameScope)

  async function loadHistory(signal?: AbortSignal) {
    try {
      const tests = await data.listPracticeTests(course, unit, accessToken, signal)
      if (!mounted.current || signal?.aborted) return
      setHistory(tests)
      setHistoryError(false)
    } catch (caught) {
      if (isAbortError(caught) || !mounted.current) return
      setHistoryError(true)
    }
  }

  const loadHistoryOnce = useEffectEvent((signal: AbortSignal) => {
    data.listPracticeTests(course, unit, accessToken, signal)
      .then((tests) => {
        if (!mounted.current || signal.aborted) return
        setHistory(tests)
        setHistoryError(false)
      })
      .catch((caught) => { if (!isAbortError(caught) && mounted.current) setHistoryError(true) })
  })
  useEffect(() => {
    const controller = new AbortController()
    loadHistoryOnce(controller.signal)
    return () => controller.abort()
  }, [course, unit])

  function begin(next: PracticeTestData) {
    setClockOffset((parseServerTime(next.server_now) || data.now()) - data.now())
    warned.current = new Set()
    autoSubmitted.current = false
    setTest(next)
    setNow(data.now())
    setConfirmOpen(false)
    setSubmitError('')
    if (next.status === 'submitted') {
      setStage('results')
      return
    }
    const draft = data.sandboxed ? null : loadPracticeDraft(next.id)
    setAnswers(draft?.answers ?? {})
    setFlags(draft?.flags ?? [])
    setCurrent(Math.min(Math.max(0, draft?.current ?? 0), Math.max(0, next.items.length - 1)))
    setStage('test')
  }

  async function open(testId: string) {
    setStage('loading')
    setError('')
    try {
      const loaded = await data.getPracticeTest(testId, accessToken)
      if (!mounted.current) return
      begin(loaded)
    } catch (caught) {
      if (!mounted.current) return
      setError(failure(caught, 'Couldn’t open that practice test. Try again in a moment.'))
      setStage('setup')
    }
  }

  // Opening an existing test (the first stage is already "loading").
  const openOnce = useEffectEvent((testId: string) => {
    data.getPracticeTest(testId, accessToken)
      .then((loaded) => { if (mounted.current) begin(loaded) })
      .catch((caught) => {
        if (!mounted.current) return
        setError(failure(caught, 'Couldn’t open that practice test. Try again in a moment.'))
        setStage('setup')
      })
  })
  useEffect(() => {
    if (openId) openOnce(openId)
  }, [openId])

  async function start(options: PracticeTestOptions) {
    setStage('starting')
    setError('')
    setInstructionsError('')
    lastOptions.current = options
    try {
      const created = await data.createPracticeTest(options, accessToken)
      if (!mounted.current) return
      begin(created)
      onChanged?.()
      void loadHistory()
    } catch (caught) {
      if (!mounted.current) return
      if (caught instanceof ApiError && caught.code === 'instructions_rejected') setInstructionsError(caught.message)
      else setError(failure(caught, 'Couldn’t write a practice test right now. Try again in a moment.'))
      setStage('setup')
    }
  }

  function startFromSetup() {
    if (!minutesValid) return
    // A test from these notes was taken before: write new questions rather than repeat it.
    void start({ course, unit, count, timeLimitMin: timeLimit, instructions, newQuestions: scopeHistory.length > 0 })
  }

  async function submit() {
    if (!test || submitting.current) return
    submitting.current = true
    setConfirmOpen(false)
    setSubmitError('')
    setStage('submitting')
    const sent = Object.entries(answers)
      .filter(([, answer]) => answer.trim())
      .map(([position, answer]) => ({ position: Number(position), answer: answer.trim().slice(0, 500) }))
    try {
      let graded: PracticeTestData
      try {
        graded = await data.submitPracticeTest(test.id, sent, accessToken)
      } catch (caught) {
        // Submitted already (another tab, or a retry after a lost reply): show that result.
        if (caught instanceof ApiError && caught.status === 409 && caught.code === 'already_submitted') {
          graded = await data.getPracticeTest(test.id, accessToken)
        } else {
          throw caught
        }
      }
      if (!mounted.current) return
      if (!data.sandboxed) clearPracticeDraft(test.id)
      setTest(graded)
      setStage('results')
      onChanged?.()
      void loadHistory()
    } catch (caught) {
      if (!mounted.current) return
      setSubmitError(failure(caught, 'Couldn’t submit your test. Your answers are still here — try again.'))
      setStage('test')
    } finally {
      submitting.current = false
    }
  }

  // Answers in progress survive a refresh (this tab only, never in the demo).
  useEffect(() => {
    if (stage !== 'test' || !test || data.sandboxed) return
    savePracticeDraft(test.id, { answers, flags, current })
  }, [stage, test, answers, flags, current, data.sandboxed])

  // The countdown. No pause: it follows the server's deadline.
  const timedTest = stage === 'test' && test?.deadline
  useEffect(() => {
    if (!timedTest) return
    const timer = window.setInterval(() => setNow(data.now()), 1000)
    return () => window.clearInterval(timer)
  }, [timedTest, data])

  const onTick = useEffectEvent(() => {
    if (remaining === null || stage !== 'test') return
    for (const mark of WARNINGS) {
      if (remaining <= mark && remaining > 0 && !warned.current.has(mark)) {
        WARNINGS.filter((other) => other >= mark).forEach((other) => warned.current.add(other))
        setAnnouncement(mark >= 120 ? `${mark / 60} minutes left.` : '1 minute left.')
      }
    }
    if (remaining <= 0 && !autoSubmitted.current) {
      autoSubmitted.current = true
      setAnnouncement('Time’s up. Submitting your answers.')
      void submit()
    }
  })
  useEffect(() => { onTick() }, [now])

  // Each new question (and the results) moves keyboard and screen-reader focus to its heading.
  useEffect(() => {
    if (stage === 'test') questionHeading.current?.focus({ preventScroll: true })
  }, [stage, current])
  useEffect(() => {
    if (stage === 'results') resultsHeading.current?.focus({ preventScroll: false })
  }, [stage])
  useEffect(() => {
    if (confirmOpen) confirmButton.current?.focus()
  }, [confirmOpen])
  useEffect(() => {
    if (!confirmOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setConfirmOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [confirmOpen])

  function chooseCount(next: number) {
    setCount(next)
    if (!minutesEdited) setMinutes(String(suggestedMinutes(next)))
  }

  function setAnswer(position: number, value: string) {
    setAnswers((existing) => ({ ...existing, [position]: value.slice(0, 500) }))
  }

  function toggleFlag(position: number) {
    setFlags((existing) => (existing.includes(position) ? existing.filter((value) => value !== position) : [...existing, position]))
  }

  function retake(newQuestions: boolean, overrides?: Partial<PracticeTestOptions>) {
    const base: PracticeTestOptions = lastOptions.current ?? {
      course, unit, count: test?.question_count ?? count, timeLimitMin: test?.time_limit_s ? Math.round(test.time_limit_s / 60) : null,
    }
    void start({ ...base, ...overrides, newQuestions })
  }

  const header = (title: string, subtitle?: string, actions?: ReactNode) => (
    <div className="practice__head">
      <div className="practice__head-text">
        <span className="ui-eyebrow">Practice test · {unit ?? 'Whole course'}</span>
        <h2 className="practice__title">{title}</h2>
        {subtitle ? <p className="practice__subtitle">{subtitle}</p> : null}
      </div>
      <div className="practice__head-actions">{actions}</div>
    </div>
  )

  const historyList = (
    <section className="practice__history" aria-labelledby="practice-history-title">
      <h3 className="practice__label" id="practice-history-title">Past tests</h3>
      {historyError ? (
        <div className="ui-alert">
          <span>Couldn’t load your past tests.</span>
          <button className="ui-button ui-button--sm practice__retry" type="button" onClick={() => void loadHistory()}>Retry</button>
        </div>
      ) : history === null ? (
        <p className="practice__hint" role="status"><span className="ui-spinner" />Loading…</p>
      ) : scopeHistory.length === 0 ? (
        <p className="practice__hint">No tests yet for {scopeLabel}. Your scores will show here.</p>
      ) : (
        <ul className="ui-list practice__history-list">
          {scopeHistory.map((entry) => {
            const done = entry.status === 'submitted'
            const percent = done && entry.question_count ? Math.round(((entry.score ?? 0) / entry.question_count) * 100) : 0
            return (
              <li key={entry.id} className="ui-row practice__history-row">
                <div className="ui-row__main">
                  <span className="ui-row__title">
                    {done ? `${entry.score ?? 0} of ${entry.question_count} correct` : 'In progress'}
                    {done ? <span className={`ui-badge ${percent >= 70 ? 'ui-badge--positive' : 'ui-badge--warning'}`}>{percent}%</span> : null}
                    {entry.over_time ? <span className="ui-badge">Over time</span> : null}
                  </span>
                  <span className="ui-row__meta">{when(entry.created_at)} · {plural(entry.question_count, 'question')}{entry.time_limit_s ? ` · ${Math.round(entry.time_limit_s / 60)} min` : ' · untimed'}</span>
                </div>
                <button className="ui-button ui-button--sm practice__history-open" type="button" onClick={() => void open(entry.id)}>
                  {done ? 'Review' : 'Resume'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )

  if (stage === 'setup' || stage === 'starting' || stage === 'loading') {
    const busy = stage !== 'setup'
    return (
      <div className="practice practice--setup" role="region" aria-label="Practice test">
        {header(`Practice test: ${scopeLabel}`, 'A timed test written from your notes. Answers and explanations appear after you submit.',
          <button className="ui-button ui-button--ghost practice__close" type="button" onClick={onClose}>Back</button>)}
        {stage === 'loading' ? (
          <p className="practice__status" role="status"><span className="ui-spinner" />Opening your test…</p>
        ) : (
          <div className="practice__setup" aria-busy={busy}>
            <fieldset className="practice__field">
              <legend className="practice__label">Questions</legend>
              <div className="ui-segmented practice__segmented">
                {COUNTS.map((value) => (
                  <button key={value} type="button" className="ui-segmented__item practice__count" aria-pressed={count === value} disabled={busy} onClick={() => chooseCount(value)}>
                    {value}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="practice__field">
              <legend className="practice__label">Time limit</legend>
              {data.sandboxed ? (
                <p className="practice__hint">Untimed in this demo. In bindit, a test is timed (about 1.5 minutes a question) unless you choose untimed.</p>
              ) : (
                <div className="practice__time">
                  <div className="ui-segmented practice__segmented">
                    <button type="button" className="ui-segmented__item practice__timed" aria-pressed={timed} disabled={busy} onClick={() => setTimed(true)}>Timed</button>
                    <button type="button" className="ui-segmented__item practice__timed" aria-pressed={!timed} disabled={busy} onClick={() => setTimed(false)}>Untimed</button>
                  </div>
                  {timed ? (
                    <label className="practice__minutes">
                      <input
                        className="ui-input practice__minutes-input"
                        type="number"
                        inputMode="numeric"
                        min={5}
                        max={60}
                        value={minutes}
                        disabled={busy}
                        aria-invalid={minutesValid ? undefined : true}
                        aria-describedby="practice-minutes-hint"
                        onChange={(event) => { setMinutes(event.target.value); setMinutesEdited(true) }}
                      />
                      <span>minutes</span>
                    </label>
                  ) : null}
                </div>
              )}
              {!data.sandboxed && timed ? (
                <p className={`practice__hint${minutesValid ? '' : ' is-error'}`} id="practice-minutes-hint">
                  {minutesValid ? `Suggested: ${suggestedMinutes(count)} minutes for ${count} questions. The timer can’t be paused.` : 'Choose between 5 and 60 minutes.'}
                </p>
              ) : null}
            </fieldset>
            <div className="tools__instructions practice__instructions">
              <label className="tools__label" htmlFor="practice-instructions">Instructions <span className="tools__optional">optional</span></label>
              <input
                id="practice-instructions"
                className="ui-input"
                type="text"
                value={instructions}
                maxLength={INSTRUCTIONS_MAX}
                disabled={busy}
                onChange={(event) => { setInstructions(event.target.value.slice(0, INSTRUCTIONS_MAX)); setInstructionsError('') }}
                placeholder="e.g. focus on the Calvin cycle, make it harder"
                autoComplete="off"
                aria-invalid={instructionsError ? true : undefined}
                aria-describedby={`practice-instructions-meta${instructionsError ? ' practice-instructions-error' : ''}`}
              />
              <p className="tools__instructions-meta" id="practice-instructions-meta">
                <span>Steers which parts of your notes the test covers and how hard it is.</span>
                <span className={instructions.length >= INSTRUCTIONS_MAX ? 'is-full' : ''}>{instructions.length}/{INSTRUCTIONS_MAX}</span>
              </p>
              {instructionsError ? <p className="tools__field-error" id="practice-instructions-error" role="alert">{instructionsError}</p> : null}
            </div>
            {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}
            <div className="practice__actions">
              <button className={`ui-button ui-button--primary practice__start${stage === 'starting' ? ' is-busy' : ''}`} type="button" disabled={busy || !minutesValid} onClick={startFromSetup}>
                {stage === 'starting' ? 'Writing your test…' : 'Start test'}
              </button>
              {stage === 'starting' ? <span className="practice__hint" role="status">This takes about 10–20 seconds.</span> : null}
            </div>
          </div>
        )}
        {historyList}
      </div>
    )
  }

  if (!test) return null

  if (stage === 'results') {
    const score = test.score ?? 0
    const total = test.question_count || test.items.length
    const percent = total ? Math.round((score / total) * 100) : 0
    const topics = [...(test.topics ?? [])].sort((a, b) => a.correct / a.total - b.correct / b.total)
    const weak = topics.filter((topic) => topic.weak).map((topic) => topic.topic)
    return (
      <div className={`practice practice--results${focusOn ? ' is-focus' : ''}`} style={focusStyle} role="region" aria-label="Practice test results">
        <div className="practice__head">
          <div className="practice__head-text">
            <span className="ui-eyebrow">Practice test · {test.unit ?? 'Whole course'}</span>
            <h2 className="practice__title" ref={resultsHeading} tabIndex={-1}>Your results</h2>
          </div>
          <div className="practice__head-actions">
            <button className="ui-button ui-button--ghost practice__close" type="button" onClick={onClose}>Done</button>
          </div>
        </div>
        <section className="practice__score" aria-label="Score">
          <div className={`practice__score-main ${percent >= 70 ? 'is-strong' : 'is-weak'}`}>
            <span className="practice__score-value">{score}<span className="practice__score-total">/{total}</span></span>
            <span className="practice__score-percent">{percent}% correct</span>
          </div>
          <dl className="practice__score-facts">
            <div>
              <dt>Time used</dt>
              <dd>{typeof test.time_used_s === 'number' ? formatClock(test.time_used_s) : '—'}{test.time_limit_s ? ` of ${formatClock(test.time_limit_s)}` : ''}</dd>
            </div>
            <div>
              <dt>XP earned</dt>
              <dd>+{test.xp_earned}</dd>
            </div>
            <div>
              <dt>Taken</dt>
              <dd>{when(test.created_at)}</dd>
            </div>
          </dl>
          {test.over_time ? <p className="practice__note">Submitted after the time limit, so this one counts as over time.</p> : null}
        </section>

        {topics.length ? (
          <section className="practice__topics" aria-labelledby="practice-topics-title">
            <h3 className="practice__label" id="practice-topics-title">By topic</h3>
            <ul className="practice__topic-list">
              {topics.map((topic) => {
                const share = topic.total ? topic.correct / topic.total : 0
                return (
                  <li key={topic.topic} className={`practice__topic ${topic.weak ? 'is-weak' : 'is-strong'}`}>
                    <span className="practice__topic-name">{topic.topic}</span>
                    <span className="practice__topic-score">{topic.correct}/{topic.total}<span className="practice__topic-tag">{topic.weak ? 'Weak spot' : 'Strong'}</span></span>
                    <span
                      className="practice__bar"
                      role="meter"
                      aria-label={`${topic.topic}: ${topic.correct} of ${topic.total} correct`}
                      aria-valuemin={0}
                      aria-valuemax={topic.total}
                      aria-valuenow={topic.correct}
                    >
                      <span style={{ transform: `scaleX(${share})` }} />
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <div className="practice__actions practice__results-actions">
          {weak.length ? (
            <button
              className="ui-button ui-button--primary practice__weak"
              type="button"
              onClick={() => retake(true, { instructions: `Focus on: ${weak.join(', ')}`.slice(0, INSTRUCTIONS_MAX) })}
            >
              Practice my weak spots
            </button>
          ) : null}
          <button className={`ui-button${weak.length ? '' : ' ui-button--primary'} practice__retake`} type="button" onClick={() => retake(false)}>Retake this test</button>
          <button className="ui-button practice__new" type="button" onClick={() => retake(true)}>New questions</button>
        </div>
        {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}

        <section className="practice__review" aria-labelledby="practice-review-title">
          <h3 className="practice__label" id="practice-review-title">Every question</h3>
          <ol className="practice__review-list">
            {test.items.map((entry) => (
              <li key={entry.position} className={`practice__review-item ${entry.correct ? 'is-correct' : 'is-incorrect'}`}>
                <p className="practice__review-head">
                  <span className="practice__verdict" aria-hidden="true">{entry.correct ? <CheckIcon /> : <CrossIcon />}</span>
                  <span className="practice__review-number">Question {entry.position + 1}</span>
                  <span className="sr-only">{entry.correct ? 'Correct' : 'Incorrect'}.</span>
                  {entry.topic ? <span className="practice__review-topic">{entry.topic}</span> : null}
                </p>
                <p className="practice__review-prompt"><MathText text={entry.prompt} /></p>
                <dl className="practice__review-answers">
                  <div>
                    <dt>Your answer</dt>
                    <dd className={entry.correct ? 'is-correct' : 'is-incorrect'}>{entry.student_answer ? <MathText text={entry.student_answer} /> : <em>No answer</em>}</dd>
                  </div>
                  {entry.correct ? null : (
                    <div>
                      <dt>Correct answer</dt>
                      <dd className="is-correct"><MathText text={entry.answer ?? ''} /></dd>
                    </div>
                  )}
                </dl>
                {entry.feedback ? <p className="practice__review-text"><MathText text={entry.feedback} /></p> : null}
                {entry.explanation ? <p className="practice__review-text practice__review-why"><strong>Why:</strong> <MathText text={entry.explanation} /></p> : null}
              </li>
            ))}
          </ol>
        </section>
      </div>
    )
  }

  // Taking the test.
  const position = item?.position ?? 0
  const flagged = flags.includes(position)
  const lowTime = remaining !== null && remaining <= 60
  const submittingNow = stage === 'submitting'
  return (
    <div className={`practice practice--test${focusOn ? ' is-focus' : ''}`} style={focusStyle} role="region" aria-label="Practice test">
      <div className="practice__bar-top">
        <div className="practice__progress-text">
          <span className="ui-eyebrow">Practice test · {test.unit ?? 'Whole course'}</span>
          <span className="practice__counter">{items.length - unanswered.length} of {items.length} answered</span>
        </div>
        <div className="practice__bar-actions">
          {remaining !== null ? (
            <span className={`practice__timer${lowTime ? ' is-low' : ''}`} role="timer" aria-label={`Time left: ${formatClock(remaining)}`}>
              <ClockIcon />{formatClock(remaining)}
            </span>
          ) : <span className="practice__timer is-untimed">Untimed</span>}
          {focusControls}
          <button className="ui-button ui-button--primary practice__submit" type="button" disabled={submittingNow} onClick={() => setConfirmOpen(true)}>
            {submittingNow ? 'Grading…' : 'Submit test'}
          </button>
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <nav className="practice__nav" aria-label="Questions">
        <ol className="practice__nav-list">
          {items.map((entry) => {
            const isAnswered = answered(entry.position)
            const isFlagged = flags.includes(entry.position)
            return (
              <li key={entry.position}>
                <button
                  type="button"
                  className={`practice__nav-item${isAnswered ? ' is-answered' : ''}${isFlagged ? ' is-flagged' : ''}`}
                  aria-current={entry.position === position ? 'step' : undefined}
                  aria-label={`Question ${entry.position + 1}${isAnswered ? ', answered' : ', not answered'}${isFlagged ? ', flagged for review' : ''}`}
                  onClick={() => setCurrent(items.indexOf(entry))}
                >
                  {entry.position + 1}
                  {isFlagged ? <span className="practice__nav-flag" aria-hidden="true" /> : null}
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      {item ? (
        <section className="practice__question" aria-labelledby="practice-question-title">
          <div className="practice__question-head">
            <h3 className="practice__question-number" id="practice-question-title" ref={questionHeading} tabIndex={-1}>
              Question {position + 1} <span className="practice__of">of {items.length}</span>
            </h3>
            <button className={`ui-button ui-button--sm practice__flag${flagged ? ' is-on' : ''}`} type="button" aria-pressed={flagged} onClick={() => toggleFlag(position)}>
              <FlagIcon />{flagged ? 'Flagged' : 'Flag for review'}
            </button>
          </div>
          {item.type === 'multiple_choice' ? (
            <fieldset className="practice__choices" disabled={submittingNow}>
              <legend className="practice__prompt"><MathText text={item.prompt} /></legend>
              {item.choices.map((choice, index) => {
                const id = `practice-${test.id}-${position}-${index}`
                const picked = answers[position] === choice
                return (
                  <label key={choice} className={`practice__choice${picked ? ' is-picked' : ''}`} htmlFor={id}>
                    <input id={id} type="radio" name={`practice-${position}`} value={choice} checked={picked} onChange={() => setAnswer(position, choice)} />
                    <span className="practice__choice-key" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                    <span className="practice__choice-text"><MathText text={choice} /></span>
                  </label>
                )
              })}
            </fieldset>
          ) : (
            <div className="practice__short">
              <p className="practice__prompt" id={`practice-prompt-${position}`}><MathText text={item.prompt} /></p>
              <label className="practice__label" htmlFor={`practice-answer-${position}`}>Your answer</label>
              <input
                id={`practice-answer-${position}`}
                key={position}
                className="ui-input practice__answer-input"
                type="text"
                value={answers[position] ?? ''}
                maxLength={500}
                disabled={submittingNow}
                autoComplete="off"
                autoCapitalize="off"
                enterKeyHint={current < items.length - 1 ? 'next' : 'done'}
                aria-describedby={`practice-prompt-${position}`}
                onChange={(event) => setAnswer(position, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (current < items.length - 1) setCurrent(current + 1)
                    else setConfirmOpen(true)
                  }
                }}
              />
              <p className="practice__hint">A word, number or short phrase is enough.</p>
            </div>
          )}
          <div className="practice__steps">
            <button className="ui-button practice__step" type="button" disabled={current === 0} onClick={() => setCurrent(current - 1)}>Previous</button>
            {current < items.length - 1 ? (
              <button className="ui-button practice__step" type="button" onClick={() => setCurrent(current + 1)}>Next</button>
            ) : (
              <button className="ui-button practice__step" type="button" disabled={submittingNow} onClick={() => setConfirmOpen(true)}>Review and submit</button>
            )}
          </div>
        </section>
      ) : null}

      {submitError ? <div className="ui-alert" role="alert"><span>{submitError}</span></div> : null}
      {submittingNow ? <p className="practice__status" role="status"><span className="ui-spinner" />Grading your answers…</p> : null}
      <p className="practice__hint practice__leave">
        Your answers are saved on this device as you go.{' '}
        <button className="practice__link practice__close" type="button" onClick={onClose}>Leave the test</button>
        {remaining !== null ? ' (the timer keeps running)' : ''}.
      </p>

      {confirmOpen ? (
        <div className="ui-dialog-backdrop practice__confirm" role="presentation" onClick={() => setConfirmOpen(false)}>
          <div className="ui-dialog practice__dialog" role="dialog" aria-modal="true" aria-labelledby="practice-confirm-title" aria-describedby="practice-confirm-body" onClick={(event) => event.stopPropagation()}>
            <div className="ui-dialog__header">
              <h2 className="ui-dialog__title" id="practice-confirm-title">Submit your test?</h2>
            </div>
            <div className="practice__dialog-body" id="practice-confirm-body">
              {unanswered.length ? (
                <>
                  <p>{unanswered.length === 1 ? '1 question is' : `${unanswered.length} questions are`} not answered yet:</p>
                  <ul className="practice__missing">
                    {unanswered.map((missing) => (
                      <li key={missing}>
                        <button className="practice__link practice__goto" type="button" onClick={() => { setCurrent(items.findIndex((entry) => entry.position === missing)); setConfirmOpen(false) }}>
                          Question {missing + 1}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : <p>Every question has an answer.</p>}
              {flags.length ? <p>{plural(flags.length, 'question')} flagged for review: {[...flags].sort((a, b) => a - b).map((flag) => flag + 1).join(', ')}.</p> : null}
              <p className="practice__hint">You can’t change your answers after you submit.</p>
            </div>
            <div className="ui-dialog__footer">
              <button className="ui-button practice__keep" type="button" onClick={() => setConfirmOpen(false)}>Keep working</button>
              <button className="ui-button ui-button--primary practice__confirm-submit" type="button" ref={confirmButton} onClick={() => void submit()}>Submit test</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
