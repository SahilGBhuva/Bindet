import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isAbortError, RequestTimeoutError } from '../lib/api'
import type { AnswerResult, Flashcard, GeneratedQuestion, Topic } from '../lib/api'
import { useData } from '../lib/dataSource'
import {
  fileToCourseImageDataUrl,
  notesFor,
  pickCourseTone,
  unitsFor,
  withCourseTones,
} from '../lib/session'
import type { Course, NoteDeposit } from '../lib/types'
import { courseInitial } from '../lib/tones'
import './Tools.css'

type ToolView = 'scan' | 'cards' | 'quiz'
type NoteSource = 'file' | 'paste'

const QUIZ_TOPICS: { id: Topic; label: string }[] = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'addition', label: 'Addition' },
  { id: 'subtraction', label: 'Subtraction' },
  { id: 'multiplication', label: 'Multiplication' },
  { id: 'division', label: 'Division' },
]

const QUIZ_LEVELS = [
  { id: 1, label: 'Level 1' },
  { id: 2, label: 'Level 2' },
  { id: 3, label: 'Level 3' },
]

const VIEWS: { id: ToolView; label: string }[] = [
  { id: 'scan', label: 'Notes' },
  { id: 'cards', label: 'Flashcards' },
  { id: 'quiz', label: 'Quiz' },
]

function courseTone(course: { name: string; tone?: string }) {
  return course.tone ?? withCourseTones([{ name: course.name, units: [] }])[0].tone ?? '#0b58f5'
}

function CourseMark({ course, size = 'sm' }: { course: Course; size?: 'sm' | 'lg' }) {
  if (course.image) return <img className={`tools__thumb tools__thumb--${size}`} src={course.image} alt="" />
  return (
    <span className={`ui-course-mark ui-course-mark--${size}`} style={{ ['--course' as string]: courseTone(course) }} aria-hidden="true">
      {courseInitial(course.name)}
    </span>
  )
}

function GripMark() {
  return (
    <svg className="tools__grip" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="7" r="1.4" />
      <circle cx="15" cy="7" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="17" r="1.4" />
      <circle cx="15" cy="17" r="1.4" />
    </svg>
  )
}

function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg className="tools__chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === 'up' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function formatDay(value: string) {
  const time = Date.parse(value)
  return Number.isNaN(time) ? '' : dayFormat.format(time)
}

/* A short label for the kind of source, read from the file name. */
function fileKind(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'webp', 'heic', 'gif'].includes(extension)) return 'IMG'
  if (extension === 'md') return 'MD'
  if (['pdf', 'docx', 'txt', 'csv', 'json'].includes(extension)) return extension.toUpperCase()
  return 'DOC'
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z" />
      <path d="M14 3.5v4h4M9 12.5h6M9 16h4" />
    </svg>
  )
}

function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" />
    </svg>
  )
}

function ArrowIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === 'left' ? 'M19 12H5m6-6-6 6 6 6' : 'M5 12h14m-6-6 6 6-6 6'} />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function Tools({ accessToken }: { accessToken?: string }) {
  const data = useData()
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [addingCourse, setAddingCourse] = useState(false)
  const [newCourse, setNewCourse] = useState('')
  const [newUnit, setNewUnit] = useState('')
  const [addingUnit, setAddingUnit] = useState(false)
  const [renamingUnit, setRenamingUnit] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [renamingCourse, setRenamingCourse] = useState('')
  const [courseRenameDraft, setCourseRenameDraft] = useState('')
  const [menuCourse, setMenuCourse] = useState('')
  // Where the open course menu was opened from: a row in the course list, or the compact phone bar.
  const [menuPlace, setMenuPlace] = useState<'rail' | 'bar'>('rail')
  const [file, setFile] = useState<File | null>(null)
  const [pastedNotes, setPastedNotes] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [removingNoteId, setRemovingNoteId] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState<'' | NoteSource>('')
  const [uploadError, setUploadError] = useState<{ source: NoteSource; message: string; retry: boolean } | null>(null)
  const [cardIndex, setCardIndex] = useState(0)
  const [cardFlipped, setCardFlipped] = useState(false)
  const [quizTopic, setQuizTopic] = useState<Topic>('mixed')
  const [quizDifficulty, setQuizDifficulty] = useState(1)
  const [quizQuestion, setQuizQuestion] = useState<GeneratedQuestion | null>(null)
  const [quizAnswer, setQuizAnswer] = useState('')
  const [quizResult, setQuizResult] = useState<AnswerResult | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizChecking, setQuizChecking] = useState(false)
  const [quizError, setQuizError] = useState('')
  const [quizFailed, setQuizFailed] = useState<'' | 'load' | 'check'>('')
  const [deck, setDeck] = useState<{ key: string; cards: Flashcard[] } | null>(null)
  const [cardsBusy, setCardsBusy] = useState(false)
  const [cardsError, setCardsError] = useState('')
  const [cardsRequest, setCardsRequest] = useState(0)
  const [panelFn, setPanelFn] = useState<ToolView>('scan')
  const [orderOpen, setOrderOpen] = useState(false)
  const [orderDrag, setOrderDrag] = useState('')
  const [lookCourse, setLookCourse] = useState('')
  const [lookBusy, setLookBusy] = useState(false)
  const [lookHint, setLookHint] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const courseImageInput = useRef<HTMLInputElement>(null)
  const orderDragIndex = useRef(-1)
  const menuRef = useRef<HTMLDivElement>(null)
  const studentId = useRef(data.getStudentId())
  // AI generation is rate limited per day, so generated content is only requested
  // when what it depends on changes, never just because the user switched views.
  const pendingDeckKey = useRef('')
  const latestDeckKey = useRef('')
  const loadedQuizKey = useRef('')
  const quizSequence = useRef(0)
  // At most one question is fetched ahead per quiz setting; leaving that setting cancels it.
  const prefetchedQuestions = useRef(new Map<string, { promise: Promise<GeneratedQuestion>; controller: AbortController }>())
  const intentTimer = useRef(0)

  const courses = notebook.courses
  const activeCourse = notebook.activeCourse
  const activeUnit = notebook.activeUnit
  const units = unitsFor(courses, activeCourse)
  const current = courses.find((course) => course.name === activeCourse)
  const looking = courses.find((course) => course.name === lookCourse) ?? current
  const unitNotes = notesFor(notebook.deposits, activeCourse, activeUnit)
  const courseNoteCount = notebook.deposits.filter((note) => note.course === activeCourse).length
  const deckKey = `${activeCourse}|${activeUnit}|${unitNotes.length}`
  latestDeckKey.current = deckKey
  const cards = deck?.key === deckKey ? deck.cards : []
  const card = cards.length ? cards[cardIndex % cards.length] : null
  const uploadBusy = Boolean(uploading)
  const quizKey = `${activeCourse}|${activeUnit}|${unitNotes.length ? `notes:${unitNotes.length}` : quizTopic}|${quizDifficulty}`

  useEffect(() => {
    data.saveNotebook(notebook)
  }, [data, notebook])

  // A status message clears itself; errors that need a decision are shown inline instead.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!orderOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOrderOpen(false)
      setOrderDrag('')
      orderDragIndex.current = -1
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [orderOpen])

  useEffect(() => {
    if (!menuCourse) return
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuCourse('')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuCourse('')
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuCourse])

  // Writes the unit's deck once per set of notes. Called when the Flashcards view opens,
  // and a moment earlier when the pointer rests on (or focus reaches) its tab.
  function startDeck() {
    if (!activeCourse || !activeUnit || unitNotes.length === 0) return
    const key = deckKey
    if (deck?.key === key || pendingDeckKey.current === key) return
    pendingDeckKey.current = key
    setCardsBusy(true)
    setCardsError('')
    void data.generateFlashcards({ course: activeCourse, unit: activeUnit, count: 10 }, accessToken)
      .then((result) => {
        if (latestDeckKey.current !== key) return
        setDeck({ key, cards: result.cards })
        setCardIndex(0)
        setCardFlipped(false)
      })
      .catch((error: unknown) => {
        if (latestDeckKey.current === key) setCardsError(error instanceof RequestTimeoutError ? error.message : 'Couldn’t generate flashcards. Try again in a moment.')
      })
      .finally(() => {
        if (pendingDeckKey.current !== key) return
        pendingDeckKey.current = ''
        setCardsBusy(false)
      })
  }

  const startDeckForView = useEffectEvent(() => startDeck())

  useEffect(() => {
    if (panelFn === 'cards') startDeckForView()
  }, [panelFn, deckKey, cardsRequest])

  // Reads the latest quiz inputs without making them reasons to request a new question.
  const loadQuizForKey = useEffectEvent(() => {
    void loadQuizQuestion()
  })

  useEffect(() => {
    if (panelFn !== 'quiz' || loadedQuizKey.current === quizKey) return
    loadedQuizKey.current = quizKey
    loadQuizForKey()
  }, [panelFn, quizKey])

  // A question fetched ahead for another course, unit or level is no longer wanted.
  useEffect(() => {
    const prefetched = prefetchedQuestions.current
    for (const [key, entry] of prefetched) {
      if (key === quizKey) continue
      entry.controller.abort()
      prefetched.delete(key)
    }
  }, [quizKey])

  // Leaving the page cancels anything still being fetched ahead.
  useEffect(() => {
    const prefetched = prefetchedQuestions.current
    return () => {
      window.clearTimeout(intentTimer.current)
      prefetched.forEach((entry) => entry.controller.abort())
      prefetched.clear()
    }
  }, [])

  function addCourse(event: FormEvent) {
    event.preventDefault()
    const name = newCourse.trim()
    if (!name) return
    setNotebook((current) => {
      if (current.courses.some((course) => course.name === name)) {
        return { ...current, activeCourse: name, activeUnit: unitsFor(current.courses, name)[0] ?? '' }
      }
      const courses: Course[] = [...current.courses, { name, units: [], tone: pickCourseTone(current.courses) }]
      return { ...current, courses, activeCourse: name, activeUnit: '' }
    })
    setNewCourse('')
    setAddingCourse(false)
  }

  function closeAddCourse() {
    setAddingCourse(false)
    setNewCourse('')
  }

  function chooseCourse(name: string) {
    setAddingUnit(false)
    setNewUnit('')
    setRenamingUnit('')
    setRenameDraft('')
    setRenamingCourse('')
    setCourseRenameDraft('')
    setAddingCourse(false)
    setNewCourse('')
    setMenuCourse('')
    setCardIndex(0)
    setCardFlipped(false)
    setNotebook((current) => ({
      ...current,
      activeCourse: name,
      activeUnit: unitsFor(current.courses, name)[0] ?? '',
    }))
  }

  function moveCourse(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return
    setNotebook((current) => {
      if (to >= current.courses.length) return current
      const next = [...current.courses]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return { ...current, courses: next }
    })
  }

  function startRenameCourse(name: string) {
    chooseCourse(name)
    setRenamingCourse(name)
    setCourseRenameDraft(name)
  }

  function cancelRenameCourse() {
    setRenamingCourse('')
    setCourseRenameDraft('')
  }

  function commitRenameCourse(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const from = renamingCourse
    const to = courseRenameDraft.trim()
    if (!from) return
    if (!to || to === from) {
      cancelRenameCourse()
      return
    }
    if (courses.some((course) => course.name !== from && course.name === to)) {
      setNotice(`“${to}” is already a course.`)
      return
    }
    setNotebook((current) => ({
      ...current,
      courses: current.courses.map((course) => (course.name === from ? { ...course, name: to } : course)),
      deposits: current.deposits.map((item) => (item.course === from ? { ...item, course: to } : item)),
      activeCourse: current.activeCourse === from ? to : current.activeCourse,
    }))
    setLookCourse((current) => (current === from ? to : current))
    cancelRenameCourse()
  }

  function setCourseImage(name: string, image: string | undefined) {
    setNotebook((current) => ({
      ...current,
      courses: current.courses.map((course) => (course.name === name ? { ...course, image } : course)),
    }))
  }

  async function applyCourseImage(file: File | null) {
    const name = looking?.name
    if (!name || !file) return
    if (!file.type.startsWith('image/')) {
      setLookHint('Pick a photo or image file.')
      return
    }
    setLookBusy(true)
    setLookHint('')
    try {
      const image = await fileToCourseImageDataUrl(file)
      setCourseImage(name, image)
      setLookHint(`Cover added to ${name}.`)
    } catch {
      setLookHint('Could not read that image. Try another photo.')
    } finally {
      setLookBusy(false)
      if (courseImageInput.current) courseImageInput.current.value = ''
    }
  }

  function removeCourse(name: string) {
    if (!name) return
    setNotebook((current) => {
      const courses = current.courses.filter((course) => course.name !== name)
      const deposits = current.deposits.filter((item) => item.course !== name)
      if (courses.length === 0) {
        return { ...current, courses, deposits, activeCourse: '', activeUnit: '' }
      }
      const activeCourse =
        current.activeCourse === name ? courses[0].name : current.activeCourse
      const activeUnit =
        activeCourse === current.activeCourse
          ? current.activeUnit
          : (unitsFor(courses, activeCourse)[0] ?? '')
      return { ...current, courses, deposits, activeCourse, activeUnit }
    })
    setNotice(`Removed “${name}”.`)
    setLookCourse((current) => (current === name ? '' : current))
  }

  function confirmRemoveCourse(course: Course) {
    setMenuCourse('')
    const notes = notebook.deposits.filter((note) => note.course === course.name).length
    const detail = [plural(course.units.length, 'unit'), plural(notes, 'note')].join(' and ')
    if (data.confirm(`Delete “${course.name}”? Its ${detail} will be removed from this device.`)) {
      removeCourse(course.name)
    }
  }

  function openCustomize(name: string) {
    setMenuCourse('')
    setLookCourse(name || courses[0]?.name || '')
    setLookHint('')
    setOrderOpen(true)
  }

  function closeCustomize() {
    setOrderOpen(false)
    setOrderDrag('')
    orderDragIndex.current = -1
  }

  function chooseUnit(name: string) {
    setCardIndex(0)
    setCardFlipped(false)
    setNotebook((current) => ({ ...current, activeUnit: name }))
  }

  function addUnit(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const name = newUnit.trim()
    if (!name) return
    setNotebook((current) => {
      const already = unitsFor(current.courses, current.activeCourse)
      if (already.includes(name)) {
        return { ...current, activeUnit: name }
      }
      const courses = current.courses.map((course) =>
        course.name === current.activeCourse ? { ...course, units: [...course.units, name] } : course,
      )
      return { ...current, courses, activeUnit: name }
    })
    setNewUnit('')
    setAddingUnit(false)
  }

  function startRename(name: string) {
    setAddingUnit(false)
    setRenamingUnit(name)
    setRenameDraft(name)
    chooseUnit(name)
  }

  function cancelRename() {
    setRenamingUnit('')
    setRenameDraft('')
  }

  function commitRename(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const from = renamingUnit
    const to = renameDraft.trim()
    if (!from) return
    if (!to || to === from) {
      cancelRename()
      return
    }
    const taken = unitsFor(courses, activeCourse).some((item) => item !== from && item === to)
    if (taken) {
      setNotice(`“${to}” already exists in ${activeCourse}.`)
      return
    }
    setNotebook((current) => {
      const courses = current.courses.map((course) =>
        course.name === current.activeCourse
          ? { ...course, units: course.units.map((item) => (item === from ? to : item)) }
          : course,
      )
      const deposits = current.deposits.map((item) =>
        item.course === current.activeCourse && item.unit === from ? { ...item, unit: to } : item,
      )
      return {
        ...current,
        courses,
        deposits,
        activeUnit: current.activeUnit === from ? to : current.activeUnit,
      }
    })
    cancelRename()
  }

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0]
    setFile(next ?? null)
    setUploadError(null)
  }

  function onDropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragActive(false)
    const next = event.dataTransfer.files?.[0]
    if (!next) return
    setFile(next)
    setUploadError(null)
  }

  function goCard(direction: 'next' | 'prev') {
    if (cards.length < 2) return
    setCardFlipped(false)
    setCardIndex((index) => (direction === 'next' ? (index + 1) % cards.length : (index - 1 + cards.length) % cards.length))
  }

  async function loadQuizQuestion() {
    const sequence = ++quizSequence.current
    const prefetched = prefetchedQuestions.current.get(quizKey)
    setQuizBusy(true)
    setQuizChecking(false)
    setQuizError('')
    setQuizFailed('')
    setQuizResult(null)
    setQuizAnswer('')
    try {
      if (prefetched) prefetchedQuestions.current.delete(quizKey)
      const next = await (prefetched?.promise ?? requestQuizQuestion())
      if (sequence !== quizSequence.current) return
      setQuizQuestion(next)
      // While the student works on this one, the next is fetched in the background.
      primeNextQuestion()
    } catch (error) {
      if (sequence === quizSequence.current && !isAbortError(error)) {
        setQuizError(error instanceof RequestTimeoutError ? error.message : 'Couldn’t load a question. Try again in a moment.')
        setQuizFailed('load')
      }
    } finally {
      if (sequence === quizSequence.current) setQuizBusy(false)
    }
  }

  function requestQuizQuestion(signal?: AbortSignal) {
    return data.generateQuestion(
      quizTopic,
      quizDifficulty,
      activeCourse && activeUnit
        ? {
            course: activeCourse,
            unit: activeUnit,
            files: unitNotes.map((note) => note.fileName),
            other_units: units.filter((name) => name !== activeUnit),
            other_courses: courses.map((course) => course.name).filter((name) => name !== activeCourse),
          }
        : undefined,
      accessToken,
      signal,
    )
  }

  function primeNextQuestion() {
    const key = quizKey
    if (prefetchedQuestions.current.has(key)) return
    const controller = new AbortController()
    const entry = { promise: requestQuizQuestion(controller.signal), controller }
    prefetchedQuestions.current.set(key, entry)
    // A failed prefetch is simply dropped; the next question is then fetched on demand.
    void entry.promise.catch(() => { if (prefetchedQuestions.current.get(key) === entry) prefetchedQuestions.current.delete(key) })
  }

  // Resting on (or tabbing to) the Flashcards or Quiz tab starts its AI work early,
  // so it is usually ready by the time the view opens. One deck or one question at most.
  function showIntent(view: ToolView) {
    window.clearTimeout(intentTimer.current)
    if (view === panelFn || !activeCourse || !activeUnit) return
    if (view === 'cards') startDeck()
    else if (view === 'quiz' && loadedQuizKey.current !== quizKey) primeNextQuestion()
  }

  function hoverIntent(view: ToolView) {
    window.clearTimeout(intentTimer.current)
    intentTimer.current = window.setTimeout(() => showIntent(view), 120)
  }

  function checkQuizAnswer(event: FormEvent) {
    event.preventDefault()
    void gradeAnswer(quizAnswer)
  }

  async function gradeAnswer(answer: string) {
    if (!quizQuestion || !answer.trim() || quizBusy) return
    setQuizBusy(true)
    setQuizChecking(true)
    setQuizError('')
    setQuizFailed('')
    try {
      const result = await data.analyzeAnswer(quizQuestion, answer, studentId.current, accessToken)
      setQuizResult(result)
      data.recordUnitAttempt({
        course: activeCourse,
        unit: activeUnit || quizQuestion.topic,
        correct: result.correct,
      })
    } catch (error) {
      setQuizError(error instanceof RequestTimeoutError ? error.message : 'Couldn’t check that answer. Try again in a moment.')
      setQuizFailed('check')
    } finally {
      setQuizBusy(false)
      setQuizChecking(false)
    }
  }

  async function sendUpload(event: FormEvent) {
    event.preventDefault()
    if (!file || uploadBusy) return
    await ingestNote(file, 'file')
  }

  async function sendPastedNotes(event: FormEvent) {
    event.preventDefault()
    const text = pastedNotes.trim()
    if (!text || uploadBusy) return
    const typedNote = new File([text], `typed-notes-${new Date().toISOString().slice(0, 10)}.txt`, { type: 'text/plain' })
    const saved = await ingestNote(typedNote, 'paste')
    if (saved) setPastedNotes('')
  }

  async function ingestNote(candidate: File, source: NoteSource): Promise<boolean> {
    if (!activeUnit) {
      setUploadError({ source, message: `Create a unit in ${activeCourse} first, then send your notes there.`, retry: false })
      return false
    }
    if (candidate.size > 10 * 1024 * 1024) {
      setUploadError({ source, message: `“${candidate.name}” is ${formatBytes(candidate.size)}. Notes must be 10 MB or smaller.`, retry: false })
      return false
    }
    setUploading(source)
    setUploadError(null)
    setNotice('')
    try {
      const uploaded = await data.uploadNote(candidate, activeCourse, activeUnit, accessToken)
      const deposit: NoteDeposit = {
        id: uploaded.id,
        course: uploaded.course,
        unit: uploaded.unit,
        fileName: uploaded.file_name,
        createdAt: uploaded.created_at,
        status: uploaded.status,
        textPreview: uploaded.text_preview,
      }
      setNotebook((current) => ({ ...current, deposits: [deposit, ...current.deposits.filter((note) => note.id !== deposit.id)] }))
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      setNotice(`Added “${deposit.fileName}” to ${activeCourse} → ${activeUnit}.`)
      return true
    } catch (error) {
      setUploadError({ source, message: error instanceof Error ? error.message : 'Could not read that note.', retry: true })
      return false
    } finally {
      setUploading('')
    }
  }

  async function removeNote(note: NoteDeposit) {
    if (removingNoteId) return
    setRemovingNoteId(note.id)
    try {
      await data.deleteNote(note.id, accessToken)
      setNotebook((current) => ({ ...current, deposits: current.deposits.filter((item) => item.id !== note.id) }))
      setNotice(`Removed “${note.fileName}”.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove that note.')
    } finally {
      setRemovingNoteId('')
    }
  }

  function toggleCourseMenu(name: string, place: 'rail' | 'bar') {
    setMenuPlace(place)
    setMenuCourse((open) => (open === name && menuPlace === place ? '' : name))
  }

  function clearFile() {
    setFile(null)
    setUploadError(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  function onCardsKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    event.preventDefault()
    goCard(event.key === 'ArrowRight' ? 'next' : 'prev')
  }

  function retryQuiz() {
    if (quizFailed === 'check' && quizQuestion && quizAnswer.trim()) void gradeAnswer(quizAnswer)
    else void loadQuizQuestion()
  }

  const courseMenu = (course: Course, place: 'rail' | 'bar') => {
    const open = menuCourse === course.name && menuPlace === place
    return (
      <div className={`tools__course-menu tools__course-menu--${place}`} ref={open ? menuRef : undefined}>
        <button
          className="tools__icon-button"
          type="button"
          aria-label={`${course.name} options`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => toggleCourseMenu(course.name, place)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
        </button>
        {open ? (
          <div className="ui-menu tools__menu" role="menu" aria-label={`${course.name} options`}>
            <button className="ui-menu__item" type="button" role="menuitem" onClick={() => { setMenuCourse(''); startRenameCourse(course.name) }}>Rename</button>
            <button className="ui-menu__item" type="button" role="menuitem" onClick={() => openCustomize(course.name)}>Customize…</button>
            <button className="ui-menu__item ui-menu__item--danger" type="button" role="menuitem" onClick={() => confirmRemoveCourse(course)}>Delete…</button>
          </div>
        ) : null}
      </div>
    )
  }

  const addCourseForm = (
    <form className="tools__add-course" onSubmit={addCourse}>
      <input
        className="ui-input"
        value={newCourse}
        onChange={(event) => setNewCourse(event.target.value)}
        placeholder="Course name"
        aria-label="New course name"
        autoFocus
        onBlur={() => {
          if (!newCourse.trim()) closeAddCourse()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeAddCourse()
          }
        }}
      />
    </form>
  )

  const toast = notice ? (
    <p className="app-toast" role="status">
      {notice}
      <button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button>
    </p>
  ) : null

  if (courses.length === 0) {
    return (
      <div className="ui-page tools">
        <header className="ui-page-header">
          <div>
            <span className="ui-eyebrow">Study</span>
            <h1 className="ui-page-title tools__title">Your binder</h1>
            <p className="ui-page-subtitle">Organize notes by course and unit, then practice with flashcards and quizzes built from them.</p>
          </div>
        </header>
        <section className="ui-panel tools__first-run" aria-labelledby="tools-first-run-title">
          <div className="ui-empty">
            <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
            <h2 className="ui-empty__title" id="tools-first-run-title">Start with your first course</h2>
            <p className="ui-empty__copy">Courses hold units, and each unit holds the notes your flashcards and quizzes are built from.</p>
            <form className="tools__empty-form" onSubmit={addCourse}>
              <input
                className="ui-input"
                value={newCourse}
                onChange={(event) => setNewCourse(event.target.value)}
                placeholder="e.g. Biology"
                aria-label="Course name"
              />
              <button className="ui-button ui-button--primary" type="submit" disabled={!newCourse.trim()}>Add course</button>
            </form>
          </div>
        </section>
        {toast}
      </div>
    )
  }

  const cardPosition = cards.length ? (cardIndex % cards.length) + 1 : 0
  const loadingQuestion = quizBusy && !quizChecking

  return (
    <div className="ui-page tools" style={current ? { ['--course' as string]: courseTone(current) } : undefined}>
      <header className="ui-page-header">
        <div className="tools__heading">
          <span className="ui-eyebrow">Study</span>
          <h1 className="ui-page-title tools__title">{activeCourse || 'Your binder'}</h1>
          <p className="ui-page-subtitle">
            {current ? `${plural(current.units.length, 'unit')} · ${plural(courseNoteCount, 'note')}` : 'Pick a course to get started.'}
          </p>
        </div>
        <div className="tools__header-actions">
          <button className="ui-button" type="button" onClick={() => openCustomize(activeCourse)}>Manage courses</button>
        </div>
      </header>

      <div className="tools__layout">
        <nav className="tools__courses" aria-label="Courses">
          <h2 className="tools__courses-title">Courses</h2>
          <ul className="tools__course-list">
            {courses.map((course) => {
              const isActive = course.name === activeCourse
              return (
                <li key={course.name} className={`tools__course${isActive ? ' is-active' : ''}`} style={{ ['--course' as string]: courseTone(course) }}>
                  {renamingCourse === course.name ? (
                    <form className="tools__course-rename" onSubmit={commitRenameCourse}>
                      <input
                        className="ui-input"
                        value={courseRenameDraft}
                        onChange={(event) => setCourseRenameDraft(event.target.value)}
                        aria-label={`Rename ${course.name}`}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => commitRenameCourse()}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRenameCourse()
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      className="tools__course-button"
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      title="Double-click to rename"
                      onClick={() => chooseCourse(course.name)}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        startRenameCourse(course.name)
                      }}
                    >
                      <CourseMark course={course} />
                      <span className="tools__course-name">{course.name}</span>
                      <span className="ui-count" aria-label={plural(course.units.length, 'unit')}>{course.units.length}</span>
                    </button>
                  )}
                  {renamingCourse !== course.name ? courseMenu(course, 'rail') : null}
                </li>
              )
            })}
          </ul>
          <div className="tools__course-tools">
            {current && renamingCourse !== current.name ? courseMenu(current, 'bar') : null}
            {addingCourse ? addCourseForm : (
              <button className="tools__add-row" type="button" onClick={() => setAddingCourse(true)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span>Add course</span>
              </button>
            )}
          </div>
        </nav>

        <section className="ui-panel tools__workspace" aria-label={activeCourse ? `${activeCourse} workspace` : 'Workspace'}>
          <div className="ui-tabs tools__unit-tabs" role="tablist" aria-label={`Units in ${activeCourse}`}>
            {units.map((item) =>
              item === renamingUnit ? (
                <form key={item} className="tools__unit-form" onSubmit={commitRename}>
                  <input
                    className="ui-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    aria-label={`Rename ${item}`}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => commitRename()}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRename()
                      }
                      if (event.key === 'Enter') commitRename(event)
                    }}
                  />
                </form>
              ) : (
                <button
                  key={item}
                  className="ui-tab"
                  type="button"
                  role="tab"
                  title="Double-click to rename"
                  aria-selected={item === activeUnit}
                  onClick={() => chooseUnit(item)}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    startRename(item)
                  }}
                >
                  {item}
                </button>
              ),
            )}
            {addingUnit ? (
              <form className="tools__unit-form" onSubmit={addUnit}>
                <input
                  className="ui-input"
                  value={newUnit}
                  onChange={(event) => setNewUnit(event.target.value)}
                  placeholder="Unit name"
                  aria-label={`New ${activeCourse} unit`}
                  autoFocus
                  onBlur={() => {
                    if (!newUnit.trim()) setAddingUnit(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setNewUnit('')
                      setAddingUnit(false)
                    }
                    if (event.key === 'Enter') addUnit(event)
                  }}
                />
              </form>
            ) : (
              <button className="ui-tab tools__add-unit" type="button" onClick={() => setAddingUnit(true)}>
                + Add unit
              </button>
            )}
          </div>

          {!activeUnit ? (
            <div className="ui-empty tools__unit-empty">
              <h2 className="ui-empty__title">{units.length ? 'Pick a unit' : `No units in ${activeCourse} yet`}</h2>
              <p className="ui-empty__copy">
                {units.length ? 'Choose a unit above to see its notes, flashcards, and quiz.' : 'Units group your notes by topic, like chapters in a textbook. Add one to start collecting notes.'}
              </p>
              {units.length ? null : <button className="ui-button ui-button--primary" type="button" onClick={() => setAddingUnit(true)}>Add a unit</button>}
            </div>
          ) : (
            <>
              <div className="tools__toolbar">
                <h2 className="tools__unit-title">{activeUnit}</h2>
                <div className="ui-segmented tools__views" role="tablist" aria-label="Study view">
                  {VIEWS.map((view) => (
                    <button
                      key={view.id}
                      className="ui-segmented__item"
                      type="button"
                      role="tab"
                      aria-selected={panelFn === view.id}
                      onClick={() => setPanelFn(view.id)}
                      onPointerEnter={view.id === 'scan' ? undefined : () => hoverIntent(view.id)}
                      onPointerLeave={() => window.clearTimeout(intentTimer.current)}
                      onFocus={view.id === 'scan' ? undefined : () => showIntent(view.id)}
                    >
                      {view.label}
                      {view.id === 'scan' ? <span className="ui-count">{unitNotes.length}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              {panelFn === 'scan' ? (
                <div className="tools__notes" role="tabpanel" aria-label="Notes">
                  <div className="tools__add-notes">
                    <form className="tools__upload" onSubmit={sendUpload} aria-busy={uploading === 'file'}>
                      <h3 className="tools__label" id="tools-upload-title">Upload a file</h3>
                      <div
                        className={`tools__dropzone${dragActive ? ' is-dragging' : ''}${file ? ' has-file' : ''}${uploading === 'file' ? ' is-busy' : ''}${uploadError?.source === 'file' ? ' has-error' : ''}`}
                        onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={(event) => {
                          const nextTarget = event.relatedTarget
                          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragActive(false)
                        }}
                        onDrop={onDropFile}
                      >
                        <input
                          ref={fileInput}
                          className="ui-file-input"
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json"
                          onChange={onPickFile}
                        />
                        <button
                          className="tools__dropzone-button"
                          type="button"
                          aria-describedby="tools-upload-meta"
                          disabled={uploading === 'file'}
                          onClick={() => fileInput.current?.click()}
                        >
                          <span className="tools__dropzone-icon" aria-hidden="true">
                            {uploading === 'file' ? <span className="ui-spinner" /> : file ? <FileIcon /> : <UploadIcon />}
                          </span>
                          <span className="tools__dropzone-title">
                            {uploading === 'file' && file
                              ? `Reading ${file.name}…`
                              : dragActive
                                ? `Release to add to ${activeUnit}`
                                : file
                                  ? file.name
                                  : 'Drop a file here, or browse'}
                          </span>
                          <span className="tools__dropzone-meta" id="tools-upload-meta">
                            {uploading === 'file'
                              ? 'Pulling out the text so flashcards and quizzes can use it.'
                              : file
                                ? `${formatBytes(file.size)} · Choose to pick a different file`
                                : 'PDF, DOCX, TXT, Markdown, CSV, JSON, or a photo of handwritten notes. Up to 10 MB.'}
                          </span>
                        </button>
                      </div>
                      {uploadError?.source === 'file' ? (
                        <div className="ui-alert" role="alert">
                          <span>{uploadError.message}</span>
                          {uploadError.retry && file ? (
                            <button className="ui-button ui-button--sm" type="submit">Try again</button>
                          ) : (
                            <button className="ui-button ui-button--sm" type="button" onClick={() => { clearFile(); fileInput.current?.click() }}>Choose another file</button>
                          )}
                        </div>
                      ) : null}
                      <div className="tools__form-actions">
                        {uploading === 'file' ? <span className="tools__status" role="status">Reading your notes…</span> : null}
                        {file && uploading !== 'file' ? <button className="ui-button ui-button--ghost" type="button" onClick={clearFile}>Clear</button> : null}
                        <button className={`ui-button ui-button--primary${uploading === 'file' ? ' is-busy' : ''}`} type="submit" disabled={!file || uploading === 'paste'}>Upload</button>
                      </div>
                    </form>

                    <form className="tools__paste" onSubmit={sendPastedNotes} aria-busy={uploading === 'paste'}>
                      <label className="tools__label" htmlFor="pasted-notes">Paste or type notes</label>
                      <textarea
                        id="pasted-notes"
                        className="ui-textarea"
                        value={pastedNotes}
                        onChange={(event) => {
                          setPastedNotes(event.target.value)
                          if (uploadError?.source === 'paste') setUploadError(null)
                        }}
                        placeholder="Paste from Google Docs, a class handout, or your own notes"
                        rows={6}
                        readOnly={uploading === 'paste'}
                      />
                      {uploadError?.source === 'paste' ? (
                        <div className="ui-alert" role="alert">
                          <span>{uploadError.message}</span>
                          {uploadError.retry ? <button className="ui-button ui-button--sm" type="submit">Try again</button> : null}
                        </div>
                      ) : null}
                      <div className="tools__form-actions">
                        {uploading === 'paste' ? <span className="tools__status" role="status">Saving your notes…</span> : null}
                        <button className={`ui-button${uploading === 'paste' ? ' is-busy' : ''}`} type="submit" disabled={!pastedNotes.trim() || uploading === 'file'}>Add typed notes</button>
                      </div>
                    </form>
                  </div>

                  <section className="tools__sources" aria-labelledby="tools-sources-title">
                    <div className="tools__sources-head">
                      <h3 className="tools__label" id="tools-sources-title">Sources in {activeUnit}</h3>
                      <span className="ui-count">{plural(unitNotes.length, 'file')}</span>
                    </div>
                    {unitNotes.length ? (
                      <ul className="ui-list tools__source-list">
                        {unitNotes.map((note) => (
                          <li key={note.id} className={`ui-row tools__source${removingNoteId === note.id ? ' is-removing' : ''}`}>
                            <span className="tools__source-kind" aria-hidden="true">{fileKind(note.fileName)}</span>
                            <div className="ui-row__main">
                              <span className="ui-row__title">{note.fileName}</span>
                              <span className="ui-row__meta">
                                {formatDay(note.createdAt)}{formatDay(note.createdAt) ? ' · ' : ''}{note.textPreview || 'Text extracted and ready.'}
                              </span>
                            </div>
                            <button
                              className="ui-button ui-button--ghost ui-button--sm"
                              type="button"
                              onClick={() => void removeNote(note)}
                              disabled={removingNoteId === note.id}
                              aria-label={`Remove ${note.fileName}`}
                            >
                              {removingNoteId === note.id ? 'Removing…' : 'Remove'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="tools__sources-empty">
                        <p className="tools__sources-empty-title">Nothing here yet</p>
                        <p className="tools__hint">Add a file or paste notes above. Flashcards and quiz questions for {activeUnit} are built from them.</p>
                      </div>
                    )}
                  </section>
                </div>
              ) : null}

              {panelFn === 'cards' ? (
                <div className="tools__cards" role="tabpanel" aria-label="Flashcards" onKeyDown={onCardsKey}>
                  {unitNotes.length === 0 ? (
                    <div className="ui-empty">
                      <h3 className="ui-empty__title">No notes in {activeUnit} yet</h3>
                      <p className="ui-empty__copy">Flashcards are written from this unit’s notes. Add a file or paste some text first.</p>
                      <button className="ui-button ui-button--primary" type="button" onClick={() => setPanelFn('scan')}>Add notes</button>
                    </div>
                  ) : card ? (
                    <>
                      <button
                        className={`tools__card${cardFlipped ? ' is-flipped' : ''}`}
                        type="button"
                        onClick={() => setCardFlipped((open) => !open)}
                      >
                        <span className="tools__card-face" key={`${cardPosition}-${cardFlipped ? 'back' : 'front'}`} aria-live="polite">
                          <span className="tools__card-label">{cardFlipped ? 'Answer' : 'Question'}</span>
                          <span className="tools__card-text">{cardFlipped ? card.back : card.front}</span>
                        </span>
                        <span className="tools__card-hint" aria-hidden="true">
                          <FlipIcon />
                          {cardFlipped ? 'Show the question' : 'Reveal the answer'}
                        </span>
                      </button>
                      <div className="tools__card-progress" aria-hidden="true">
                        <span style={{ transform: `scaleX(${cardPosition / cards.length})` }} />
                      </div>
                      <div className="tools__card-nav">
                        <button className="ui-button" type="button" onClick={() => goCard('prev')} disabled={cards.length < 2}>
                          <ArrowIcon direction="left" />Previous
                        </button>
                        <span className="tools__card-count" aria-live="polite">{cardPosition} of {cards.length}</span>
                        <button className="ui-button" type="button" onClick={() => goCard('next')} disabled={cards.length < 2}>
                          Next<ArrowIcon direction="right" />
                        </button>
                      </div>
                      <p className="tools__keys">
                        <kbd>Space</kbd> flips · <kbd>←</kbd> <kbd>→</kbd> move between cards
                      </p>
                    </>
                  ) : cardsError && !cardsBusy ? (
                    <div className="tools__cards-error">
                      <div className="ui-alert" role="alert">
                        <span>{cardsError}</span>
                        <button className="ui-button ui-button--sm" type="button" onClick={() => setCardsRequest((count) => count + 1)}>Try again</button>
                      </div>
                    </div>
                  ) : (
                    <div className="tools__card-loading" aria-busy="true">
                      <div className="tools__card tools__card--skeleton" aria-hidden="true">
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                      </div>
                      <p className="tools__status" role="status">
                        <span className="ui-spinner" />Writing flashcards from {plural(unitNotes.length, 'note')}…
                      </p>
                    </div>
                  )}
                </div>
              ) : null}

              {panelFn === 'quiz' ? (
                <div className="tools__quiz" role="tabpanel" aria-label="Quiz">
                  <div className="tools__quiz-bar">
                    <p className="tools__quiz-source">
                      {unitNotes.length
                        ? `Questions come from ${plural(unitNotes.length, 'note')} in ${activeUnit}.`
                        : `No notes in ${activeUnit} yet, so these are math practice questions.`}
                    </p>
                    <div className="tools__quiz-controls">
                      {unitNotes.length === 0 ? (
                        <select className="ui-select" aria-label="Topic" value={quizTopic} onChange={(event) => setQuizTopic(event.target.value as Topic)}>
                          {QUIZ_TOPICS.map((topic) => <option key={topic.id} value={topic.id}>{topic.label}</option>)}
                        </select>
                      ) : null}
                      <select className="ui-select" aria-label="Level" value={quizDifficulty} onChange={(event) => setQuizDifficulty(Number(event.target.value))}>
                        {QUIZ_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                      </select>
                      <button className="ui-button" type="button" onClick={() => void loadQuizQuestion()} disabled={quizBusy}>
                        {quizQuestion && !quizResult && !quizError ? 'Skip' : 'New question'}
                      </button>
                    </div>
                  </div>

                  <div className={`tools__question${loadingQuestion ? ' is-loading' : ''}`} aria-busy={quizBusy}>
                    {loadingQuestion || (!quizQuestion && !quizError) ? (
                      <div className="tools__question-skeleton">
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                        <p className="sr-only" role="status">Loading a question…</p>
                      </div>
                    ) : quizQuestion ? (
                      <>
                        <span className="ui-eyebrow">Question · Level {quizQuestion.difficulty || quizDifficulty}</span>
                        <p className="tools__prompt">{quizQuestion.question}</p>
                        {quizQuestion.choices?.length ? (
                          <div className="tools__choices" role="group" aria-label="Answer choices">
                            {quizQuestion.choices.map((choice, index) => {
                              const picked = quizAnswer === choice
                              const verdict = picked && quizResult ? (quizResult.correct ? 'correct' : 'incorrect') : ''
                              return (
                                <button
                                  key={choice}
                                  type="button"
                                  className={`tools__choice${picked ? ' is-picked' : ''}${verdict ? ` is-${verdict}` : ''}`}
                                  aria-pressed={picked}
                                  disabled={quizBusy || Boolean(quizResult)}
                                  onClick={() => {
                                    setQuizAnswer(choice)
                                    void gradeAnswer(choice)
                                  }}
                                >
                                  <span className="tools__choice-key" aria-hidden="true">
                                    {verdict === 'correct' ? <CheckIcon /> : verdict === 'incorrect' ? <CrossIcon /> : String.fromCharCode(65 + index)}
                                  </span>
                                  <span className="tools__choice-text">{choice}</span>
                                  {picked && quizChecking ? <span className="tools__choice-state"><span className="ui-spinner" />Checking…</span> : null}
                                  {verdict ? <span className="tools__choice-state">{verdict === 'correct' ? 'Correct' : 'Incorrect'}</span> : null}
                                </button>
                              )
                            })}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>

                  {/* Multiple-choice questions answer with the choice buttons; the demo never shows the text field. */}
                  {quizQuestion?.choices?.length || (data.sandboxed && !quizQuestion) ? null : (
                    <form className="tools__answer" onSubmit={checkQuizAnswer}>
                      <input
                        className="ui-input"
                        type="text"
                        value={quizAnswer}
                        onChange={(event) => setQuizAnswer(event.target.value)}
                        placeholder="Your answer"
                        aria-label="Your answer"
                        autoComplete="off"
                        disabled={quizBusy || !quizQuestion}
                      />
                      <button className={`ui-button ui-button--primary${quizChecking ? ' is-busy' : ''}`} type="submit" disabled={quizBusy || !quizQuestion || !quizAnswer.trim()}>
                        Check
                      </button>
                    </form>
                  )}

                  {quizError ? (
                    <div className="ui-alert" role="alert">
                      <span>{quizError}</span>
                      <button className="ui-button ui-button--sm" type="button" onClick={retryQuiz} disabled={quizBusy}>Try again</button>
                    </div>
                  ) : null}
                  {quizResult ? (
                    <div className={`tools__result ${quizResult.correct ? 'is-correct' : 'is-incorrect'}`} role="status">
                      <p className="tools__result-title">
                        <span className="tools__result-icon" aria-hidden="true">{quizResult.correct ? <CheckIcon /> : <CrossIcon />}</span>
                        {quizResult.correct ? 'Correct' : 'Not quite'}
                        {quizResult.xp_earned ? <span className="ui-badge ui-badge--accent">+{quizResult.xp_earned} XP</span> : null}
                      </p>
                      <p className="tools__result-body">{quizResult.explanation}</p>
                      {quizResult.hint ? <p className="tools__result-body"><strong>Hint:</strong> {quizResult.hint}</p> : null}
                      <div className="tools__result-foot">
                        <p className="tools__result-meta">
                          {quizResult.total_xp.toLocaleString()} XP total · answer streak {quizResult.streak}
                        </p>
                        <div className="tools__quiz-controls tools__result-actions">
                          {quizResult.correct ? null : <a className="tools__tutor-link" href="#tutor">Ask the tutor about this</a>}
                          <button className="ui-button" type="button" onClick={() => void loadQuizQuestion()} disabled={quizBusy}>
                            Next question<ArrowIcon direction="right" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {toast}

      {orderOpen ? (
        <div className="ui-dialog-backdrop" role="presentation" onClick={closeCustomize}>
          <div
            className="ui-dialog tools__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customize-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui-dialog__header">
              <h2 className="ui-dialog__title" id="customize-title">Customize courses</h2>
            </div>
            <div className="tools__dialog-body">
              <section className="tools__dialog-order" aria-labelledby="customize-order-title">
                <div>
                  <h3 className="tools__label" id="customize-order-title">Order</h3>
                  <p className="tools__hint">Drag to reorder, or use the arrows. Double-click a name to rename it.</p>
                </div>
                <ol className="tools__order-list">
                  {courses.map((course, index) => (
                    <li
                      key={course.name}
                      className={`tools__order-item${orderDrag === course.name ? ' is-dragging' : ''}${course.name === looking?.name ? ' is-selected' : ''}`}
                      style={{ ['--course' as string]: courseTone(course) }}
                      draggable={renamingCourse !== course.name}
                      onClick={() => {
                        setLookCourse(course.name)
                        chooseCourse(course.name)
                        setLookHint('')
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        startRenameCourse(course.name)
                      }}
                      onDragStart={(event) => {
                        if (renamingCourse === course.name) {
                          event.preventDefault()
                          return
                        }
                        orderDragIndex.current = index
                        setOrderDrag(course.name)
                        event.dataTransfer.setData('text/plain', course.name)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const from = orderDragIndex.current
                        if (from < 0) return
                        const box = event.currentTarget.getBoundingClientRect()
                        let to = event.clientY < box.top + box.height / 2 ? index : index + 1
                        if (from < to) to -= 1
                        if (from === to) return
                        orderDragIndex.current = to
                        moveCourse(from, to)
                      }}
                      onDragEnd={() => {
                        orderDragIndex.current = -1
                        setOrderDrag('')
                      }}
                    >
                      <GripMark />
                      <CourseMark course={course} />
                      {renamingCourse === course.name ? (
                        <input
                          className="ui-input tools__order-rename"
                          value={courseRenameDraft}
                          onChange={(event) => setCourseRenameDraft(event.target.value)}
                          aria-label={`Rename ${course.name}`}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => commitRenameCourse()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              event.stopPropagation()
                              cancelRenameCourse()
                            }
                            if (event.key === 'Enter') commitRenameCourse(event)
                          }}
                        />
                      ) : (
                        <span className="tools__order-name">{course.name}</span>
                      )}
                      <span className="tools__order-shift">
                        <button
                          className="tools__icon-button"
                          type="button"
                          aria-label={`Move ${course.name} up`}
                          disabled={index === 0}
                          onClick={(event) => { event.stopPropagation(); moveCourse(index, index - 1) }}
                        >
                          <Chevron direction="up" />
                        </button>
                        <button
                          className="tools__icon-button"
                          type="button"
                          aria-label={`Move ${course.name} down`}
                          disabled={index === courses.length - 1}
                          onClick={(event) => { event.stopPropagation(); moveCourse(index, index + 1) }}
                        >
                          <Chevron direction="down" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              <section
                className="tools__dialog-cover"
                aria-labelledby="customize-cover-title"
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  void applyCourseImage(event.dataTransfer.files?.[0] ?? null)
                }}
              >
                <h3 className="tools__label" id="customize-cover-title">Cover</h3>
                <input
                  ref={courseImageInput}
                  className="ui-file-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void applyCourseImage(event.target.files?.[0] ?? null)}
                />
                {looking ? (
                  <>
                    <div className="tools__cover-preview">
                      <CourseMark course={looking} size="lg" />
                      <div className="tools__cover-copy">
                        <p className="tools__cover-name">{looking.name}</p>
                        <p className="tools__hint">{looking.image ? 'Cover image shown in your course list.' : 'No cover. The course color is used instead.'}</p>
                      </div>
                    </div>
                    <p className="tools__hint">Drop an image here or choose one from your files.</p>
                    <div className="tools__form-actions tools__form-actions--start">
                      <button className={`ui-button${lookBusy ? ' is-busy' : ''}`} type="button" disabled={lookBusy} onClick={() => courseImageInput.current?.click()}>
                        {lookBusy ? 'Adding…' : looking.image ? 'Change cover' : 'Add cover'}
                      </button>
                      {looking.image ? (
                        <button
                          className="ui-button ui-button--ghost"
                          type="button"
                          disabled={lookBusy}
                          onClick={() => {
                            setCourseImage(looking.name, undefined)
                            setLookHint(`Cover removed from ${looking.name}.`)
                          }}
                        >
                          Remove cover
                        </button>
                      ) : null}
                    </div>
                    {lookHint ? <p className="tools__hint" role="status">{lookHint}</p> : null}
                  </>
                ) : null}
              </section>
            </div>
            <div className="ui-dialog__footer">
              <button className="ui-button ui-button--primary" type="button" onClick={closeCustomize} autoFocus>Done</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
