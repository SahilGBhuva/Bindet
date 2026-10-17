import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { ApiError, isAbortError, localDay, type AnswerResult, type GeneratedQuestion, type NoteQuizContext, type ReviewCard, type ReviewGrade } from '../../lib/api'
import { useAnnounce } from '../../lib/announce'
import { useData } from '../../lib/dataSource'
import { SESSION_CARDS, SESSION_QUESTIONS, instantHint, instantReason, unitKey, type InstantPick } from '../../lib/instantStudy'
import { noteDeposit, uploadFailure, COURSE_NAME_MAX } from '../../lib/noteUpload'
import { GRADE_LABELS, GRADES, announceReviewChange, formatInterval, gradePreview, pendingGrades, spokenInterval } from '../../lib/review'
import { createCombo, emitRewards, rewardsFromResponse, type Combo } from '../../lib/rewards'
import { notebookWithCourse, notebookWithNextUnit } from '../../lib/session'
import { courseInitial } from '../../lib/tones'
import type { Course, Notebook } from '../../lib/types'
import { MathText } from '../math/Math'
import { Icons } from '../Icons'
import './InstantStudy.css'

/* bindet's own Instant Study mark: two study cards with a spark, instead of the stock lightning emoji. */
function InstantMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="instant-mark-svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="3.5" y="7" width="12" height="13" rx="2.4" transform="rotate(-8 9.5 13.5)" fill="currentColor" opacity=".35" />
      <rect x="6.5" y="6" width="12" height="13.5" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.6 12.6h5.8M9.6 15.6h3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M19.4 2.2l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85-1.85-.75 1.85-.75z" fill="currentColor" />
    </svg>
  )
}

/*
 * Instant Study: Home's one-tap session over one unit of the student's own notes.
 *
 *   Key points (4–6 bullets, cached on the server per note text, so a repeat costs no AI)
 *   → Flashcards (due first, then new, graded with the normal review grades so spaced
 *     repetition stays right; a unit with notes but no cards gets them made first)
 *   → Quick quiz (3 questions from the unit quiz, with its no-repeat bank)
 *   → Celebration (XP from the quiz answers, the streak, the daily goal) and Another round.
 *
 * If the key points aren't cached yet, the cards come first and the points follow once
 * they're ready. A step that can't run (a daily AI limit, notes too short) is skipped with
 * one line. XP and the study day come from the existing routes (quiz answers award XP;
 * a graded card counts the study day). Everything goes through useData(); in the landing
 * demo the button is locked and opens sign-up (components/demo/LivePreview.tsx).
 */

type Step = 'points' | 'cards' | 'quiz'
const STEP_LABEL: Record<Step, string> = { points: 'Key points', cards: 'Flashcards', quiz: 'Quick quiz' }
// Each step has its own hue (matching the Friends page's colored icon chips).
const STEP_TONE: Record<Step, string> = { points: 'teal', cards: 'violet', quiz: 'blue' }
const STEP_ICON: Record<Step, ReactNode> = {
  points: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></>,
  cards: <><rect x="3" y="7" width="13" height="13" rx="2" /><path d="M8 4h11a2 2 0 0 1 2 2v11" /></>,
  quiz: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4M12 17h.01" /></>,
}

function StepChip({ step }: { step: Step }) {
  return (
    <span className={`instant-chip ui-tone--${STEP_TONE[step]}`} aria-hidden="true">
      <svg viewBox="0 0 24 24">{STEP_ICON[step]}</svg>
    </span>
  )
}
// How long the key points may take before the cards go first.
const POINTS_HEAD_START_MS = 700
// Making cards for a unit's notes: at most this many notes, then a few checks on one still being made.
const MAKE_NOTES_MAX = 3
const POLL_TRIES = 6
const POLL_MS = 2500

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })

/* ---------- The button on Home ---------- */

export function InstantStudyButton({ pick, onStart, streak }: { pick: InstantPick | null; onStart: () => void; streak: number }) {
  return (
    <div className="instant-entry">
      <button type="button" className="instant-cta" onClick={onStart} aria-describedby="instant-hint">
        <span className="instant-cta__bolt" aria-hidden="true"><InstantMark size={30} /></span>
        <span className="instant-cta__text">
          <span className="instant-cta__title">Instant Study</span>
          <span className="instant-cta__hint" id="instant-hint">{instantHint(pick)}</span>
        </span>
        {pick ? <span className="instant-cta__why">{instantReason(pick)}</span> : null}
        <span className="instant-cta__go" aria-hidden="true">{streak > 0 ? <>🔥 {streak}</> : 'Go'}<span className="instant-cta__arrow">›</span></span>
      </button>
    </div>
  )
}

/* ---------- The session dialog ---------- */

type SessionProps = {
  start: InstantPick | null
  accessToken?: string
  studentId: string
  notebook: Notebook
  goal: number
  streak: number
  /* Settings → Instant Study → Skip key points: straight to the flashcards. */
  skipKeyPoints?: boolean
  /* The next unit for Another round, given the units already studied in this sitting. */
  choose: (exclude: string[]) => Promise<InstantPick | null>
  onNotebook: (next: Notebook) => void
  onClose: () => void
}

export function InstantStudy({ start, accessToken, studentId, notebook, goal, streak, skipKeyPoints = false, choose, onNotebook, onClose }: SessionProps) {
  // Right answers in a row across this sitting's quizzes (visual only: lib/rewards.ts).
  const [combo] = useState(createCombo)
  const dialog = useRef<HTMLDialogElement>(null)
  const [round, setRound] = useState<{ pick: InstantPick | null; n: number; streak: number }>({ pick: start, n: 1, streak })
  const studied = useRef<string[]>(start ? [unitKey(start.course, start.unit)] : [])

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (!node.open) {
      try {
        node.showModal()
      } catch {
        node.setAttribute('open', '')
      }
    }
    document.documentElement.classList.add('instant-open')
    return () => {
      document.documentElement.classList.remove('instant-open')
      if (node.open) node.close()
    }
  }, [])

  async function another(streakNow: number) {
    const next = await choose(studied.current)
    if (next) studied.current = [...studied.current, unitKey(next.course, next.unit)]
    setRound((current) => ({ pick: next ?? current.pick, n: current.n + 1, streak: streakNow }))
  }

  const course = round.pick ? notebook.courses.find((item) => item.name.trim() === round.pick?.course.trim()) : undefined
  return (
    <dialog
      ref={dialog}
      className="instant"
      aria-labelledby="instant-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      style={course?.tone ? { ['--course' as string]: course.tone } as CSSProperties : undefined}
    >
      {round.pick ? (
        <Round
          key={round.n}
          pick={round.pick}
          course={course}
          accessToken={accessToken}
          studentId={studentId}
          notebook={notebook}
          goal={goal}
          streakBefore={round.streak}
          roundNumber={round.n}
          skipKeyPoints={skipKeyPoints}
          combo={combo}
          onAnother={another}
          onClose={onClose}
        />
      ) : (
        <AddNotes
          accessToken={accessToken}
          notebook={notebook}
          onNotebook={onNotebook}
          onClose={onClose}
          onReady={(pick) => {
            studied.current = [unitKey(pick.course, pick.unit)]
            setRound((current) => ({ pick, n: current.n + 1, streak: current.streak }))
          }}
        />
      )}
    </dialog>
  )
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="instant__close" onClick={onClose} aria-label="Close Instant Study">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
  )
}

/* ---------- One round ---------- */

type PointsState = { status: 'loading' | 'ready' | 'skipped'; points: string[]; note: string }
type CardsState = { status: 'loading' | 'making' | 'ready' | 'empty'; queue: ReviewCard[]; total: number; note: string }
type QuizItem = { question: GeneratedQuestion; answer: string; result: AnswerResult | null; revealed: string | null; busy: boolean; error: string }

function keyPointsSkipped(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'no_notes' || error.code === 'notes_too_short') return 'Your notes are a little short for key points, so we went straight to practice.'
    if (error.code === 'ai_daily_limit' || error.code === 'rate_limited' || error.status === 429) return 'Key points are paused by today’s AI limit, so we skipped them.'
  }
  return 'Key points couldn’t load right now, so we skipped them.'
}

function quizSkipped(error: unknown) {
  if (error instanceof ApiError && (error.status === 429 || error.code === 'ai_daily_limit')) return 'The quiz is paused by today’s AI limit, so this round ends with your cards.'
  return 'Quiz questions couldn’t load right now, so this round ends with your cards.'
}

function Round({ pick, course, accessToken, studentId, notebook, goal, streakBefore, roundNumber, skipKeyPoints, combo, onAnother, onClose }: {
  pick: InstantPick
  course: Course | undefined
  accessToken?: string
  studentId: string
  notebook: Notebook
  goal: number
  streakBefore: number
  roundNumber: number
  skipKeyPoints: boolean
  combo: Combo
  onAnother: (streakNow: number) => Promise<void>
  onClose: () => void
}) {
  const data = useData()
  const { course: courseName, unit } = pick
  const [order, setOrder] = useState<Step[] | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [finished, setFinished] = useState(false)
  const [points, setPoints] = useState<PointsState>({ status: 'loading', points: [], note: '' })
  const [cards, setCards] = useState<CardsState>({ status: 'loading', queue: [], total: 0, note: '' })
  const [revealed, setRevealed] = useState(false)
  const [graded, setGraded] = useState(0)
  const [unsaved, setUnsaved] = useState(0)
  const pending = useRef(pendingGrades())
  const settle = useRef(() => pending.current.settled()).current
  const [quiz, setQuiz] = useState<QuizItem[]>([])
  const [quizIndex, setQuizIndex] = useState(0)
  const [quizStatus, setQuizStatus] = useState<'loading' | 'ready' | 'skipped'>('loading')
  const [quizNote, setQuizNote] = useState('')
  const quizContext = useRef<Promise<NoteQuizContext> | null>(null)
  const nextQuestion = useRef<Promise<GeneratedQuestion> | null>(null)
  const asked = useRef(0)
  const loadedQuestions = useRef(0)
  const mounted = useRef(true)
  const stage = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Key points, with a head start: ready in time, they come first; otherwise the cards do.
  useEffect(() => {
    // The student chose to skip key points (Settings): no request, cards first.
    if (skipKeyPoints) {
      setPoints({ status: 'skipped', points: [], note: '' })
      setOrder(['cards', 'quiz'])
      return
    }
    const controller = new AbortController()
    let decided = false
    const decide = (first: Step[]) => {
      if (decided) return
      decided = true
      setOrder(first)
    }
    const timer = window.setTimeout(() => decide(['cards', 'points', 'quiz']), POINTS_HEAD_START_MS)
    data.getKeyPoints(courseName, unit, accessToken, controller.signal)
      .then((result) => {
        if (result.points.length) {
          setPoints({ status: 'ready', points: result.points, note: '' })
          decide(['points', 'cards', 'quiz'])
        } else {
          setPoints({ status: 'skipped', points: [], note: 'There weren’t enough key points in these notes, so we went straight to practice.' })
          decide(['cards', 'quiz'])
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setPoints({ status: 'skipped', points: [], note: keyPointsSkipped(error) })
        decide(['cards', 'quiz'])
      })
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [data, accessToken, courseName, unit, skipKeyPoints])

  // Flashcards: due first, then new. A unit with notes but no cards gets them made first.
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const queue = () => data.getReviewQueue({ course: courseName, unit, limit: SESSION_CARDS }, accessToken, signal).then((result) => result.cards)
    const ready = (found: ReviewCard[]) => setCards({ status: 'ready', queue: found, total: found.length, note: '' })
    const empty = (note: string) => setCards({ status: 'empty', queue: [], total: 0, note })
    async function load() {
      const first = await queue()
      if (first.length) return ready(first)
      const library = await data.listFlashcards({ course: courseName, unit }, accessToken, signal)
      if (library.cards.length) return empty('Every card here is studied for today. They’ll be back when they’re due.')
      const waiting = library.notes.filter((note) => note.status === 'none' || note.status === 'failed' || note.status === 'generating')
      if (!waiting.length) return empty('These notes are too short for flashcards. Add a few more facts to make some.')
      setCards((current) => ({ ...current, status: 'making' }))
      for (const note of waiting.slice(0, MAKE_NOTES_MAX)) {
        if (note.status === 'generating') continue
        try {
          const made = await data.generateNoteFlashcards(note.note_id, note.status === 'failed' ? { retry: true } : undefined, accessToken, signal)
          if (made.cards.length) announceReviewChange()
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return
          if (error instanceof ApiError && (error.status === 429 || error.code === 'ai_daily_limit')) {
            return empty('Flashcards are paused by today’s AI limit, so we’ll go to the quiz.')
          }
          // 409: already being made elsewhere; checked below.
        }
        const found = await queue()
        if (found.length) return ready(found)
      }
      for (let tries = 0; tries < POLL_TRIES; tries += 1) {
        await wait(POLL_MS)
        if (signal.aborted) return
        const found = await queue()
        if (found.length) return ready(found)
      }
      empty('Flashcards couldn’t be made from these notes right now.')
    }
    load().catch((error: unknown) => {
      if (signal.aborted || isAbortError(error)) return
      empty('Your flashcards didn’t load, so we’ll go to the quiz.')
    })
    return () => controller.abort()
  }, [data, accessToken, courseName, unit])

  // The quiz: the unit's notes (for the question's context) and the first question, fetched ahead.
  function requestQuestion(): Promise<GeneratedQuestion> {
    if (!quizContext.current) {
      quizContext.current = data.listNotes(courseName, unit, accessToken).then((notes) => ({
        course: courseName,
        unit,
        files: notes.map((note) => note.file_name),
        other_units: (notebook.courses.find((item) => item.name === courseName)?.units ?? []).filter((name) => name !== unit),
        other_courses: notebook.courses.map((item) => item.name).filter((name) => name !== courseName),
      }), () => ({ course: courseName, unit, files: [], other_units: [], other_courses: [] }))
    }
    asked.current += 1
    return quizContext.current.then((context) => data.generateQuestion('mixed', 1, context, accessToken))
  }

  function prefetch() {
    if (nextQuestion.current || asked.current >= SESSION_QUESTIONS) return
    const promise = requestQuestion()
    promise.catch(() => undefined)
    nextQuestion.current = promise
  }

  async function loadQuestion() {
    const promise = nextQuestion.current ?? requestQuestion()
    nextQuestion.current = null
    try {
      const question = await promise
      if (!mounted.current) return
      loadedQuestions.current += 1
      setQuiz((current) => [...current, { question, answer: '', result: null, revealed: null, busy: false, error: '' }])
      setQuizStatus('ready')
      prefetch()
    } catch (error) {
      if (!mounted.current) return
      if (!loadedQuestions.current) {
        setQuizStatus('skipped')
        setQuizNote(quizSkipped(error))
      } else {
        // Fewer questions than planned: finish with what was answered.
        setFinished(true)
      }
    }
  }

  const steps = order ?? ['points', 'cards', 'quiz']
  const step: Step | null = finished ? null : order ? steps[stepIndex] ?? null : null

  function advance() {
    setRevealed(false)
    if (stepIndex + 1 >= steps.length) setFinished(true)
    else setStepIndex(stepIndex + 1)
    stage.current?.scrollTo?.({ top: 0 })
  }

  // Steps that have nothing to show move on by themselves; the reason stays as one line.
  // A note shows once its step has been reached, not while an earlier step is still open.
  const reached = (name: Step) => finished || (order !== null && steps.indexOf(name) >= 0 && steps.indexOf(name) <= stepIndex)
  const skipNotes = [
    points.status === 'skipped' && reached('points') ? points.note : '',
    cards.status === 'empty' && reached('cards') ? cards.note : '',
    quizStatus === 'skipped' && reached('quiz') ? quizNote : '',
  ].filter(Boolean)
  // What the button on a step leads to: the next step that has something to show.
  const upcoming = steps.slice(stepIndex + 1).find((name) => !(name === 'cards' && cards.status === 'empty') && !(name === 'points' && points.status === 'skipped') && !(name === 'quiz' && quizStatus === 'skipped'))
  const nextName = upcoming ? { points: 'key points', cards: 'flashcards', quiz: 'quiz' }[upcoming] : 'finish'
  useEffect(() => {
    if (step === 'points' && points.status === 'skipped') advance()
    if (step === 'cards' && cards.status === 'empty') advance()
    if (step === 'quiz' && quizStatus === 'skipped') advance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, points.status, cards.status, quizStatus])

  // The first question is asked for once the student is on the cards, so it is ready by the quiz
  // (and a session closed straight away asks for none).
  useEffect(() => {
    if (step === 'cards') prefetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Entering the quiz asks for the first question (usually already fetched).
  useEffect(() => {
    if (step === 'quiz' && !quiz.length && quizStatus === 'loading') void loadQuestion()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  /* Cards */
  const card = cards.queue[0] ?? null
  function grade(choice: ReviewGrade) {
    if (!card || !revealed) return
    setCards((current) => ({ ...current, queue: current.queue.slice(1) }))
    setGraded((value) => value + 1)
    setRevealed(false)
    const save = () => data.gradeReviewCard(card.id, choice, accessToken)
    void pending.current.track(save().catch(() => wait(1500).then(save)).then(
      () => announceReviewChange(),
      () => { if (mounted.current) setUnsaved((value) => value + 1) },
    ))
  }

  // Space/Enter shows the answer, 1–4 grade it (not while typing).
  useEffect(() => {
    if (step !== 'cards' || !card) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      if ((event.key === ' ' || event.key === 'Enter') && !revealed) {
        if (target?.closest('button, a') && !target.closest('.instant-card')) return
        event.preventDefault()
        setRevealed(true)
        return
      }
      const index = ['1', '2', '3', '4'].indexOf(event.key)
      if (index >= 0 && revealed) {
        event.preventDefault()
        grade(GRADES[index])
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // The last card graded ends the step.
  useEffect(() => {
    if (step === 'cards' && cards.status === 'ready' && !card) advance()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, cards.status, card])

  /* Quiz */
  const item = quiz[quizIndex] ?? null
  const updateItem = (change: Partial<QuizItem>) => setQuiz((current) => current.map((entry, index) => index === quizIndex ? { ...entry, ...change } : entry))

  async function check(answer: string, event?: FormEvent) {
    event?.preventDefault()
    if (!item || !answer.trim() || item.busy || item.result?.correct || item.revealed) return
    updateItem({ busy: true, error: '', answer })
    try {
      const result = await data.analyzeAnswer(item.question, answer, studentId, accessToken)
      data.recordUnitAttempt({ course: courseName, unit, correct: result.correct })
      combo.report(result.correct)
      emitRewards(rewardsFromResponse(result))
      if (mounted.current) updateItem({ busy: false, result })
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof ApiError && error.status === 409) return updateItem({ busy: false, error: 'This question was already answered.' })
      updateItem({ busy: false, error: error instanceof Error && error.message ? error.message : 'Couldn’t check that answer. Try again.' })
    }
  }

  async function reveal() {
    if (!item || item.busy) return
    updateItem({ busy: true, error: '' })
    try {
      const shown = await data.revealAnswer(item.question.question_id, accessToken)
      if (mounted.current) updateItem({ busy: false, revealed: shown.correct_answer })
    } catch {
      if (mounted.current) updateItem({ busy: false, error: 'Couldn’t show the answer right now. Try again.' })
    }
  }

  function nextInQuiz() {
    if (quizIndex + 1 >= SESSION_QUESTIONS) return setFinished(true)
    setQuizIndex(quizIndex + 1)
    if (quiz.length <= quizIndex + 1) void loadQuestion()
  }

  const xp = quiz.reduce((sum, entry) => sum + (entry.result?.xp_earned ?? 0), 0)
  const right = quiz.filter((entry) => entry.result?.correct).length

  /* Progress across the steps */
  const fraction: Record<Step, number> = {
    points: points.status === 'skipped' || steps.indexOf('points') < stepIndex || finished ? 1 : 0,
    cards: finished || steps.indexOf('cards') < stepIndex ? 1 : cards.total ? graded / cards.total : 0,
    quiz: finished ? 1 : quiz.filter((entry) => entry.result?.correct || entry.revealed).length / SESSION_QUESTIONS,
  }

  useAnnounce(step ? STEP_LABEL[step] : finished ? 'Round complete' : '')

  return (
    <div className="instant__frame">
      <div className="instant__band">
      <header className="instant__head">
        <span className="ui-course-mark instant__mark" aria-hidden="true" style={course?.tone ? { ['--course' as string]: course.tone } as CSSProperties : undefined}>{courseInitial(courseName)}</span>
        <div className="instant__where">
          <h2 className="instant__title" id="instant-title">
            <span className="sr-only">Instant Study: </span>{unit}
          </h2>
          <p className="instant__sub">{courseName}{roundNumber > 1 ? ` · round ${roundNumber}` : ''} · {instantReason(pick)}</p>
        </div>
        <CloseButton onClose={onClose} />
      </header>

      <ol className="instant__steps" aria-label="Session progress">
        {steps.map((name, index) => (
          <li key={name} className={`instant__step${step === name ? ' is-current' : ''}${fraction[name] >= 1 ? ' is-done' : ''}`} aria-current={step === name ? 'step' : undefined}>
            <span className="instant__step-bar" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, fraction[name])})` }} /></span>
            <span className={`instant__step-label ui-tone--${STEP_TONE[name]}`}><StepChip step={name} /><span>{index + 1}. {STEP_LABEL[name]}</span></span>
          </li>
        ))}
      </ol>

      {skipNotes.length && !finished ? <p className="instant__skip" role="note">{skipNotes[skipNotes.length - 1]}</p> : null}
      </div>

      <div className="instant__stage" ref={stage}>
        {finished ? (
          <Celebration
            key="done"
            accessToken={accessToken}
            studentId={studentId}
            goal={goal}
            streakBefore={streakBefore}
            xp={xp}
            cardsDone={graded}
            right={right}
            asked={quiz.filter((entry) => entry.result || entry.revealed).length}
            unsaved={unsaved}
            settle={settle}
            skipNotes={skipNotes}
            onAnother={onAnother}
            onClose={onClose}
          />
        ) : !order ? (
          <Loading label="Getting your session ready…" />
        ) : step === 'points' ? (
          points.status === 'loading' ? <Loading label="Pulling out the key points…" /> : (
            <section className="instant-pane instant-points" key="points">
              <h3 className="instant-pane__title"><StepChip step="points" />Key points</h3>
              <p className="instant-pane__copy">From your notes on {unit}. Read them once, then test yourself.</p>
              <ul className="instant-points__list">
                {points.points.map((point) => <li key={point}><MathText text={point} /></li>)}
              </ul>
              <div className="instant__actions">
                <button type="button" className="instant-button instant-button--go" onClick={advance}>
                  {upcoming ? `Got it — ${nextName}` : 'Got it — finish'}
                </button>
              </div>
            </section>
          )
        ) : step === 'cards' ? (
          cards.status === 'loading' || cards.status === 'making' ? (
            <Loading label={cards.status === 'making' ? 'Making flashcards from your notes…' : 'Finding your cards…'} />
          ) : card ? (
            <section className="instant-pane instant-cards" key="cards">
              <p className="instant-pane__count"><span className="instant-pane__count-main"><StepChip step="cards" />Card {graded + 1} of {cards.total}</span><span>{card.review.state === 'new' ? 'New' : 'Due'}</span></p>
              <button
                type="button"
                className={`instant-card${revealed ? ' is-revealed' : ''}`}
                onClick={() => setRevealed(true)}
                aria-label={revealed ? undefined : 'Show answer'}
                disabled={revealed}
                key={card.id}
              >
                <span className="instant-card__label">Question</span>
                <span className="instant-card__text"><MathText text={card.front} /></span>
                {revealed ? (
                  <span className="instant-card__answer">
                    <span className="instant-card__label">Answer</span>
                    <span className="instant-card__text"><MathText text={card.back} /></span>
                  </span>
                ) : <span className="instant-card__tap" aria-hidden="true">Tap to flip</span>}
              </button>
              <div className="instant__actions">
                {revealed ? (
                  <div className="instant-grades" role="group" aria-label="How well did you know it?">
                    {GRADES.map((choice, index) => {
                      const preview = gradePreview(card)
                      return (
                        <button
                          key={choice}
                          type="button"
                          className={`instant-grade is-${choice}`}
                          onClick={() => grade(choice)}
                          aria-label={`${GRADE_LABELS[choice]}, next review in ${spokenInterval(preview[choice])}`}
                          aria-keyshortcuts={String(index + 1)}
                        >
                          <span>{GRADE_LABELS[choice]}</span>
                          <small>{formatInterval(preview[choice])}</small>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <button type="button" className="instant-button instant-button--go" onClick={() => setRevealed(true)}>Show answer</button>
                )}
              </div>
            </section>
          ) : <Loading label="Finding your cards…" />
        ) : step === 'quiz' ? (
          quizStatus === 'loading' || !item ? <Loading label={`Writing question ${quizIndex + 1} from your notes…`} /> : (
            <section className="instant-pane instant-quiz" key={`quiz-${quizIndex}`}>
              <p className="instant-pane__count"><span className="instant-pane__count-main"><StepChip step="quiz" />Question {quizIndex + 1} of {SESSION_QUESTIONS}</span>{(item.question as { repeat?: boolean }).repeat ? <span>Seen before</span> : null}</p>
              <p className="instant-quiz__question"><MathText text={item.question.question} /></p>
              <QuizAnswer item={item} onCheck={check} onReveal={reveal} onNext={nextInQuiz} onRetry={() => updateItem({ result: null, answer: '', error: '' })} last={quizIndex + 1 >= SESSION_QUESTIONS} />
            </section>
          )
        ) : null}
      </div>
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="instant-pane instant-loading" aria-busy="true">
      <span className="ui-skeleton instant-loading__card" aria-hidden="true" />
      <p className="instant-loading__label"><span className="ui-spinner" aria-hidden="true" />{label}</p>
    </div>
  )
}

function QuizAnswer({ item, onCheck, onReveal, onNext, onRetry, last }: {
  item: QuizItem
  onCheck: (answer: string, event?: FormEvent) => void
  onReveal: () => void
  onNext: () => void
  onRetry: () => void
  last: boolean
}) {
  const [text, setText] = useState(item.answer)
  const input = useRef<HTMLInputElement>(null)
  const result = item.result
  const settled = Boolean(result?.correct || item.revealed)
  const nextLabel = last ? 'Finish' : 'Next question'

  useEffect(() => {
    if (!result && !item.revealed) input.current?.focus({ preventScroll: true })
  }, [result, item.revealed])

  let feedback: ReactNode = null
  if (result?.correct) {
    feedback = (
      <div className="instant-feedback is-right" role="status">
        <strong><span aria-hidden="true">✓ </span>Correct{result.xp_earned ? <span className="instant-feedback__xp"> +{result.xp_earned} XP</span> : null}</strong>
        <p><MathText text={result.explanation} /></p>
      </div>
    )
  } else if (item.revealed !== null) {
    feedback = (
      <div className="instant-feedback is-shown" role="status">
        <strong>Answer: <MathText text={item.revealed} /></strong>
        {result ? <p><MathText text={result.misconception || result.explanation} /></p> : null}
      </div>
    )
  } else if (result) {
    feedback = (
      <div className="instant-feedback is-wrong" role="status">
        <strong>Not quite</strong>
        <p><MathText text={result.misconception || result.explanation} /></p>
        {result.hint ? <p className="instant-feedback__hint">Hint: <MathText text={result.hint} /></p> : null}
      </div>
    )
  }

  return (
    <>
      {item.question.choices?.length && !settled && !result ? (
        <div className="instant-choices">
          {item.question.choices.map((choice) => (
            <button key={choice} type="button" className="instant-choice" disabled={item.busy} onClick={() => { setText(choice); onCheck(choice) }}>
              <MathText text={choice} />
            </button>
          ))}
        </div>
      ) : !settled && !result ? (
        <form className="instant-answer" onSubmit={(event) => onCheck(text, event)}>
          <label className="sr-only" htmlFor="instant-answer">Your answer</label>
          <input
            ref={input}
            id="instant-answer"
            className="ui-input instant-answer__input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type your answer"
            autoComplete="off"
            maxLength={500}
            readOnly={item.busy}
          />
        </form>
      ) : null}
      {feedback}
      {item.error ? <p className="instant-feedback__error" role="alert">{item.error}</p> : null}
      <div className="instant__actions">
        {settled ? (
          <button type="button" className="instant-button instant-button--go" onClick={onNext}>{nextLabel}</button>
        ) : result ? (
          <>
            <button type="button" className="instant-button instant-button--go" onClick={onRetry}>Try again</button>
            <button type="button" className="instant-button" onClick={onReveal} disabled={item.busy}>Show answer</button>
          </>
        ) : (
          <>
            <button type="button" className={`instant-button instant-button--go${item.busy ? ' is-busy' : ''}`} disabled={!text.trim() || item.busy} onClick={() => onCheck(text)}>
              {item.busy ? 'Checking…' : 'Check'}
            </button>
            <button type="button" className="instant-button instant-button--quiet" onClick={onReveal} disabled={item.busy}>I don’t know</button>
          </>
        )}
      </div>
    </>
  )
}

/* ---------- The end of a round ---------- */

function Celebration({ accessToken, studentId, goal, streakBefore, xp, cardsDone, right, asked, unsaved, settle, skipNotes, onAnother, onClose }: {
  accessToken?: string
  studentId: string
  goal: number
  streakBefore: number
  xp: number
  cardsDone: number
  right: number
  asked: number
  unsaved: number
  settle: () => Promise<void>
  skipNotes: string[]
  onAnother: (streakNow: number) => Promise<void>
  onClose: () => void
}) {
  const data = useData()
  const [after, setAfter] = useState<{ streak: number; today: number } | null>(null)
  const [going, setGoing] = useState(false)
  const again = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    // Grades still saving count the study day; wait for them, then read the totals.
    // A round with real study in it counts for quests and badges (its rewards are announced by lib/api.ts).
    const studied = cardsDone > 0 || asked > 0
    void settle()
      .then(() => (studied && accessToken ? data.completeInstantStudy(accessToken).catch(() => null) : null))
      .then(() => data.getProgress(studentId, accessToken, true)).then((progress) => {
      if (!live) return
      const today = progress?.recent_xp?.find((day) => day.day === localDay(new Date(data.now())))?.xp ?? 0
      setAfter({ streak: Math.max(progress?.streak ?? streakBefore, 0), today })
    }).catch(() => { if (live) setAfter({ streak: streakBefore, today: 0 }) })
    return () => { live = false }
    // Once per finished round: the counts are final when this screen mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, accessToken, studentId, settle, streakBefore])

  useEffect(() => { again.current?.focus({ preventScroll: true }) }, [])

  const streak = after?.streak ?? streakBefore
  const bumped = after !== null && after.streak > streakBefore
  const today = after?.today ?? 0
  const percent = Math.min(100, Math.round((today / Math.max(goal, 1)) * 100))
  const studiedSomething = cardsDone > 0 || asked > 0
  const title = !studiedSomething ? 'Nothing to study here yet' : asked && right === asked ? 'Perfect round!' : 'Round complete!'
  const summary = [cardsDone ? `${cardsDone} ${cardsDone === 1 ? 'card' : 'cards'}` : '', asked ? `${right} of ${asked} right` : ''].filter(Boolean).join(' · ')

  useAnnounce(after ? `${title} ${xp ? `${xp} XP earned. ` : ''}Streak ${streak} ${streak === 1 ? 'day' : 'days'}.` : '')

  async function anotherRound() {
    setGoing(true)
    await onAnother(streak)
  }

  return (
    <section className="instant-pane instant-done" key="done">
      <div className="instant-done__card">
        <p className="instant-done__eyebrow" aria-hidden="true">{studiedSomething ? '🎉' : '📝'}</p>
        <h3 className="instant-done__title">{title}</h3>
        {summary ? <p className="instant-done__summary">{summary}</p> : null}
        {!studiedSomething && skipNotes.length ? <p className="instant-done__summary">{skipNotes[0]}</p> : null}
      </div>
      <ul className="instant-done__stats" aria-label="This round">
        <li className="instant-stat ui-tone--violet">
          <span className="instant-stat__label">XP earned</span>
          <span className="instant-stat__value">+{xp}</span>
        </li>
        <li className={`instant-stat ui-tone--orange${bumped ? ' is-bumped' : ''}`}>
          <span className="instant-stat__label">Streak</span>
          <span className="instant-stat__value"><span className="instant-stat__flame" aria-hidden="true">🔥</span> {streak} {streak === 1 ? 'day' : 'days'}</span>
          {bumped ? <span className="instant-stat__note">+1 today</span> : null}
          {streak >= 7 ? <img className="ui-mascot-cheer instant-stat__cheer" src="/bindit-mascot-cutout.webp" alt="" width="36" height="43" /> : null}
        </li>
        <li className="instant-stat ui-tone--blue">
          <span className="instant-stat__label">{today >= goal ? 'Daily goal met' : 'Daily goal'}</span>
          <span className="instant-stat__value">{after ? today : '…'}<small> / {goal} XP</small></span>
          <span className="instant-stat__meter" aria-hidden="true"><span style={{ transform: `scaleX(${percent / 100})` }} /></span>
        </li>
      </ul>
      {unsaved ? <p className="instant-feedback__error" role="alert">{unsaved === 1 ? 'One card grade' : `${unsaved} card grades`} didn’t save. Check your connection.</p> : null}
      <div className="instant__actions instant-done__actions">
        <button ref={again} type="button" className={`instant-button instant-button--go instant-button--big${going ? ' is-busy' : ''}`} onClick={() => { void anotherRound() }} disabled={going}>
          <InstantMark size={18} /> Another round
        </button>
        <button type="button" className="instant-button" onClick={onClose}>Done</button>
      </div>
    </section>
  )
}

/* ---------- No notes yet ---------- */

function AddNotes({ accessToken, notebook, onNotebook, onClose, onReady }: {
  accessToken?: string
  notebook: Notebook
  onNotebook: (next: Notebook) => void
  onClose: () => void
  onReady: (pick: InstantPick) => void
}) {
  const data = useData()
  const [text, setText] = useState('')
  const [courseName, setCourseName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = notebook.courses.find((item) => item.name === notebook.activeCourse)
  const place = active && notebook.activeUnit && active.units.includes(notebook.activeUnit) ? { course: active.name, unit: notebook.activeUnit } : null

  function snap() {
    onClose()
    // Home's Snap notes card (phones): open its camera inside this same tap.
    const button = document.querySelector<HTMLButtonElement>('.home-snap button:not([disabled])')
    button?.scrollIntoView({ block: 'center' })
    button?.click()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const notes = text.trim()
    if (!notes || busy) return
    let current = data.loadNotebook()
    let target = place
    if (!target) {
      const name = courseName.trim().slice(0, COURSE_NAME_MAX)
      if (!name) {
        setError('Name the course these notes are for.')
        return
      }
      current = notebookWithCourse(current, name)
      if (!current.activeUnit) current = notebookWithNextUnit(current)
      target = { course: current.activeCourse, unit: current.activeUnit }
    }
    setBusy(true)
    setError('')
    try {
      const file = new File([notes], `typed-notes-${localDay(new Date(data.now()))}.txt`, { type: 'text/plain' })
      const uploaded = await data.uploadNote(file, target.course, target.unit, accessToken)
      const deposit = noteDeposit(uploaded, target)
      const next = { ...current, deposits: [deposit, ...current.deposits.filter((note) => note.id !== deposit.id)] }
      try {
        data.saveNotebook(next)
      } catch {
        // Storage can be unavailable; the note is saved on the server.
      }
      onNotebook(next)
      onReady({ course: target.course, unit: target.unit, reason: 'recent', due: 0, fresh: 0, accuracy: null, notes: 1 })
    } catch (failure) {
      setError(uploadFailure(failure, 'paste').message)
      setBusy(false)
    }
  }

  return (
    <div className="instant__frame">
      <div className="instant__band">
        <header className="instant__head">
          <span className="instant__mark instant__mark--bolt" aria-hidden="true"><InstantMark size={22} /></span>
          <div className="instant__where">
            <h2 className="instant__title" id="instant-title">Instant Study</h2>
            <p className="instant__sub">A 5-minute session made from your own notes</p>
          </div>
          <CloseButton onClose={onClose} />
        </header>
      </div>
      <div className="instant__stage">
        <section className="instant-pane instant-empty">
          <img className="ui-empty__mascot instant-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="120" height="144" />
          <h3 className="instant-done__title">First, a few notes</h3>
          <p className="instant-pane__copy">Instant Study turns your notes into key points, flashcards and a quick quiz. Add some to start.</p>

          <div className="instant-empty__ways">
            <button type="button" className="instant-way instant-way--snap ui-tone--blue" onClick={snap}>
              <span className="ui-icon">{Icons.camera}</span>
              <span><strong>Snap notes</strong><small>Take a photo of your notebook</small></span>
            </button>
            <a className="instant-way ui-tone--teal" href="#tools" onClick={onClose}>
              <span className="ui-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6" /></svg></span>
              <span><strong>Add a file</strong><small>PDF, Word, slides text or a photo, in Study</small></span>
            </a>
          </div>

          <form className="instant-paste" onSubmit={save}>
            <label className="instant-paste__label" htmlFor="instant-paste">Or paste text</label>
            <textarea
              id="instant-paste"
              className="ui-textarea instant-paste__text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste your class notes here"
              rows={5}
              readOnly={busy}
            />
            {place ? (
              <p className="instant-paste__where">Saves to <b>{place.course}</b> · {place.unit}</p>
            ) : (
              <>
                <label className="instant-paste__label" htmlFor="instant-course">Course</label>
                <input id="instant-course" className="ui-input instant-paste__course" value={courseName} onChange={(event) => setCourseName(event.target.value)} placeholder="e.g. AP Biology" maxLength={COURSE_NAME_MAX} readOnly={busy} />
              </>
            )}
            {error ? <p className="instant-feedback__error" role="alert">{error}</p> : null}
            <div className="instant__actions">
              <button type="submit" className={`instant-button instant-button--go${busy ? ' is-busy' : ''}`} disabled={!text.trim() || busy}>
                {busy ? 'Saving…' : <><InstantMark size={18} /> Save and study</>}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  )
}
