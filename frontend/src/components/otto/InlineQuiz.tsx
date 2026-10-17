import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError, checkPracticeAnswer, getPracticeTest, isAbortError, RequestTimeoutError, submitPracticeTest } from '../../lib/api'
import type { PracticeCheck, PracticeItem, PracticeTest } from '../../lib/api'
import { useAnnounce } from '../../lib/announce'
import { choiceForKey, practiceTestHash } from '../../lib/ottoMake'
import { MathText } from '../math/Math'
import './OttoMake.css'

/*
 * A practice test played right where it was made, one question at a time: pick an answer and see
 * at once whether it was right, with the answer and why (POST /check grades and locks it on the
 * server, so reopening the chat resumes or shows the result). After the last question the test is
 * submitted through the normal path, which awards practice-test XP within its daily cap.
 *
 * Takes only a test id (and the student's token), so it can be reused anywhere a test is shared.
 * Keyboard: 1–4 or A–D pick an answer, Enter goes on.
 */

type Props = {
  testId: string
  accessToken: string
  title?: string
  // "New quiz on this": writes another quiz (this many questions) from the same material with new questions.
  onNewQuiz?: (count: number) => Promise<void> | void
  // Offer "Open as full practice test" (the test in Study).
  fullTest?: boolean
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

function failure(error: unknown, fallback: string) {
  if (error instanceof RequestTimeoutError) return error.message
  if (error instanceof ApiError && error.message) return error.message
  return fallback
}

function checkedOf(item: PracticeItem): PracticeCheck | null {
  if (!item.checked) return null
  return {
    position: item.position, checked: true, student_answer: item.student_answer ?? '', correct: Boolean(item.correct),
    answer: item.answer ?? '', explanation: item.explanation ?? '', feedback: item.feedback ?? '', topic: item.topic ?? '',
  }
}

function CheckIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
}

function CrossIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
}

export function InlineQuiz({ testId, accessToken, title, onNewQuiz, fullTest = false }: Props) {
  const [test, setTest] = useState<PracticeTest | null>(null)
  const [error, setError] = useState('')
  const [checks, setChecks] = useState<Record<number, PracticeCheck>>({})
  const [current, setCurrent] = useState(0)
  const [pending, setPending] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [hintOpen, setHintOpen] = useState(false)
  const [stepError, setStepError] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [making, setMaking] = useState(false)
  const [reload, setReload] = useState(0)
  const root = useRef<HTMLElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  const finishingRef = useRef(false)

  const items = test?.items ?? []
  const item = items[current] ?? null
  const result = item ? checks[item.position] : undefined
  const submitted = test?.status === 'submitted'
  const answeredCount = Object.keys(checks).length

  useAnnounce(stepError, { error: true })
  useAnnounce(result ? (result.correct ? 'Correct.' : `Not quite. The answer is ${result.answer}.`) : '')

  const finish = useCallback(async (loaded: PracticeTest) => {
    if (finishingRef.current) return
    finishingRef.current = true
    setFinishing(true)
    setStepError('')
    try {
      const graded = await submitPracticeTest(loaded.id, [], accessToken)
      setTest(graded)
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'already_submitted') {
        try { setTest(await getPracticeTest(loaded.id, accessToken)) } catch { /* the retry button stays */ }
      } else setStepError(failure(caught, 'Your score couldn’t be saved. Try again.'))
    } finally {
      finishingRef.current = false
      setFinishing(false)
    }
  }, [accessToken])

  useEffect(() => {
    const controller = new AbortController()
    getPracticeTest(testId, accessToken, controller.signal).then((loaded) => {
      setTest(loaded)
      setError('')
      const found: Record<number, PracticeCheck> = {}
      for (const entry of loaded.items) {
        const done = checkedOf(entry)
        if (done) found[entry.position] = done
      }
      setChecks(found)
      // Resume at the first question not answered yet (or the last one when all are).
      const next = loaded.items.findIndex((entry) => !found[entry.position])
      setCurrent(next === -1 ? Math.max(0, loaded.items.length - 1) : next)
      if (loaded.status === 'in_progress' && loaded.items.length && next === -1) void finish(loaded)
    }).catch((caught) => {
      if (isAbortError(caught)) return
      setError(caught instanceof ApiError && caught.status === 404 ? 'This quiz was deleted.' : failure(caught, 'This quiz couldn’t be loaded.'))
    })
    return () => controller.abort()
  }, [testId, accessToken, reload, finish])

  async function answer(value: string) {
    if (!test || !item || result || pending !== null || submitted) return
    const clean = value.trim()
    if (!clean) return
    setPending(clean)
    setStepError('')
    try {
      const checked = await checkPracticeAnswer(test.id, item.position, clean, accessToken)
      setChecks((current) => ({ ...current, [checked.position]: checked }))
      window.setTimeout(() => nextButton.current?.focus(), 0)
    } catch (caught) {
      setStepError(failure(caught, 'That answer couldn’t be checked. Try again.'))
    } finally {
      setPending(null)
    }
  }

  function next() {
    if (!test || !result) return
    setHintOpen(false)
    setTyped('')
    if (current + 1 < items.length) {
      setCurrent(current + 1)
      window.setTimeout(() => root.current?.querySelector<HTMLElement>('.inline-quiz__question')?.focus(), 0)
    } else void finish(test)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!item || submitted || event.altKey || event.ctrlKey || event.metaKey) return
    const typing = (event.target as HTMLElement).tagName === 'INPUT'
    if (event.key === 'Enter' && result && !typing) { event.preventDefault(); next(); return }
    if (typing || item.type !== 'multiple_choice' || result) return
    const index = choiceForKey(event.key, item.choices.length)
    if (index !== null) { event.preventDefault(); void answer(item.choices[index]) }
  }

  async function newQuiz() {
    if (!onNewQuiz || making) return
    setMaking(true)
    try { await onNewQuiz(test?.question_count ?? 8) } finally { setMaking(false) }
  }

  const heading = title || 'Practice quiz'

  if (error) {
    return (
      <section className="inline-quiz is-error" aria-label={heading}>
        <p className="inline-quiz__error">{error}</p>
        {!error.includes('deleted') ? <button type="button" className="otto-pill" onClick={() => { setError(''); setReload((value) => value + 1) }}>Try again</button> : null}
      </section>
    )
  }

  if (!test) {
    return (
      <section className="inline-quiz is-loading" aria-label={heading} aria-busy="true">
        <span className="ui-skeleton inline-quiz__skeleton" />
        <span className="ui-skeleton inline-quiz__skeleton is-short" />
      </section>
    )
  }

  if (submitted) {
    const score = test.score ?? 0
    const total = test.question_count
    const mistakes = test.items.filter((entry) => !entry.correct)
    const great = total > 0 && score / total >= 0.7
    return (
      <section className="inline-quiz is-done" aria-label={`${heading}: results`}>
        <div className={`inline-quiz__score${great ? ' is-great' : ''}`}>
          <span className="inline-quiz__score-label">{great ? 'Nice work!' : 'Quiz done'}</span>
          <strong className="inline-quiz__score-value">{score} / {total}</strong>
          <span className="inline-quiz__xp">+{test.xp_earned} XP</span>
        </div>
        {mistakes.length ? (
          <button type="button" className="inline-quiz__review-toggle" aria-expanded={reviewOpen} onClick={() => setReviewOpen((open) => !open)}>
            {reviewOpen ? 'Hide mistakes' : `Review mistakes (${mistakes.length})`}
          </button>
        ) : <p className="inline-quiz__perfect">Every answer right.</p>}
        {reviewOpen ? (
          <ol className="inline-quiz__mistakes">
            {mistakes.map((entry) => (
              <li key={entry.position}>
                <p className="inline-quiz__mistake-q"><MathText text={entry.prompt} /></p>
                {entry.student_answer ? <p className="inline-quiz__mistake-yours">You said: <MathText text={entry.student_answer} /></p> : null}
                <p className="inline-quiz__mistake-answer">Answer: <MathText text={entry.answer ?? ''} /></p>
                {entry.explanation ? <p className="inline-quiz__mistake-why"><MathText text={entry.explanation} /></p> : null}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="inline-quiz__actions">
          {onNewQuiz ? <button type="button" className={`otto-pill${making ? ' is-busy' : ''}`} onClick={() => void newQuiz()} disabled={making}>{making ? 'Writing a new quiz…' : 'New quiz on this'}</button> : null}
          {fullTest ? <a className="otto-pill otto-pill--quiet" href={practiceTestHash(test.id, test.course, test.unit)}>Open as full practice test</a> : null}
        </div>
      </section>
    )
  }

  if (!item) return null
  const multiple = item.type === 'multiple_choice'
  return (
    <section className="inline-quiz" aria-label={heading} ref={root} onKeyDown={onKeyDown}>
      <header className="inline-quiz__head">
        <span className="inline-quiz__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M9 4h6M8 4h8v3H8zM6 6H5v14h14V6h-1" /><path d="m8.5 13 2 2 4-4.5" /></svg>
        </span>
        <span className="inline-quiz__titles">
          <span className="inline-quiz__kicker">Quiz</span>
          <span className="inline-quiz__title">{heading}</span>
        </span>
        <span className="inline-quiz__count">{current + 1} / {items.length}</span>
      </header>
      <ol className="inline-quiz__steps" aria-label={`Question ${current + 1} of ${items.length}, ${answeredCount} answered`}>
        {items.map((entry, index) => {
          const done = checks[entry.position]
          return <li key={entry.position} className={`${done ? (done.correct ? 'is-right' : 'is-wrong') : ''}${index === current ? ' is-current' : ''}`} />
        })}
      </ol>
      <p className="inline-quiz__question" tabIndex={-1}><MathText text={item.prompt} /></p>
      {item.hint && !result ? (
        <div className="inline-quiz__hint">
          <button type="button" className="inline-quiz__hint-toggle" aria-expanded={hintOpen} onClick={() => setHintOpen((open) => !open)}>
            {hintOpen ? 'Hide hint' : 'Show hint'}
          </button>
          {hintOpen ? <p><MathText text={item.hint} /></p> : null}
        </div>
      ) : null}
      {multiple ? (
        <div className="inline-quiz__choices" role="group" aria-label="Answers">
          {item.choices.map((choice, index) => {
            const chosen = result ? result.student_answer === choice : pending === choice
            const right = result && choice === result.answer
            const wrong = result && chosen && !result.correct
            const state = right ? ' is-right' : wrong ? ' is-wrong' : chosen ? ' is-chosen' : ''
            return (
              <button key={choice} type="button" className={`inline-quiz__choice${state}`} disabled={Boolean(result) || pending !== null}
                aria-pressed={chosen} onClick={() => void answer(choice)}>
                <span className="inline-quiz__letter" aria-hidden="true">{right ? <CheckIcon /> : wrong ? <CrossIcon /> : LETTERS[index]}</span>
                <span className="inline-quiz__choice-text"><MathText text={choice} /></span>
                {right ? <span className="sr-only"> (correct answer)</span> : wrong ? <span className="sr-only"> (your answer, wrong)</span> : null}
              </button>
            )
          })}
        </div>
      ) : (
        <form className="inline-quiz__short" onSubmit={(event) => { event.preventDefault(); void answer(typed) }}>
          <input className="ui-input" value={result ? result.student_answer : typed} onChange={(event) => setTyped(event.target.value)}
            disabled={Boolean(result) || pending !== null} maxLength={500} placeholder="Type your answer" aria-label="Your answer" enterKeyHint="done" />
          {!result ? <button type="submit" className={`otto-pill${pending !== null ? ' is-busy' : ''}`} disabled={!typed.trim() || pending !== null}>{pending !== null ? 'Checking…' : 'Check'}</button> : null}
        </form>
      )}
      {result ? (
        <div className={`inline-quiz__verdict${result.correct ? ' is-right' : ' is-wrong'}`}>
          <strong>{result.correct ? 'Correct!' : 'Not quite.'}</strong>
          {!result.correct && !multiple ? <span> The answer is <MathText text={result.answer} />.</span> : null}
          {result.explanation ? <span> <MathText text={result.explanation} /></span> : null}
          {result.feedback && result.feedback !== result.explanation ? <span className="inline-quiz__feedback"> <MathText text={result.feedback} /></span> : null}
        </div>
      ) : null}
      {stepError ? <p className="inline-quiz__error">{stepError}</p> : null}
      <div className="inline-quiz__foot">
        <span className="inline-quiz__keys" aria-hidden="true">{multiple ? 'Keys 1–4 or A–D · Enter for next' : 'Enter to check'}</span>
        <button ref={nextButton} type="button" className={`otto-pill${finishing ? ' is-busy' : ''}`} disabled={!result || finishing} onClick={next}>
          {finishing ? 'Scoring…' : current + 1 < items.length ? 'Next' : 'See my score'}
        </button>
      </div>
    </section>
  )
}
