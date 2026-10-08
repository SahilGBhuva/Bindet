import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AI_BREAK_MESSAGE, ApiError, isAbortError, OFFLINE_MESSAGE, OfflineError, parseServerTime, RATE_LIMITED_MESSAGE, RequestTimeoutError } from '../lib/api'
import type { AnswerResult, Flashcard, FlashcardLibrary, GeneratedQuestion, NoteFlashcardState, NoteFlashcardStatus, NoteScope, PracticeTestSummary, UploadedNote } from '../lib/api'
import { useData } from '../lib/dataSource'
import { isOffline, useOnline } from '../lib/pwa'
import {
  fileToCourseImageDataUrl,
  mergeNoteScopes,
  notesFor,
  pickCourseTone,
  sameName,
  unitsFor,
  withCourseTones,
} from '../lib/session'
import type { Course, NoteDeposit } from '../lib/types'
import { courseInitial } from '../lib/tones'
import { MathText } from '../components/math/Math'
import { announceReviewChange } from '../lib/review'
import { useReviewSummary } from '../lib/useReviewSummary'
import { ReviewSession } from './ReviewSession'
import { PracticeTest } from '../components/practice/PracticeTest'
import { prepareNotePhoto } from '../lib/notePhoto'
import {
  FOCUS_SIZES,
  INSTRUCTIONS_MAX,
  instructionsKey,
  loadFocusSize,
  loadHiddenCourses,
  loadInstructions,
  moveInstructions,
  saveFocusSize,
  saveInstructions,
  setCourseHidden,
} from '../lib/studyPrefs'
import type { InstructionKind } from '../lib/studyPrefs'
import './Tools.css'

type ToolView = 'scan' | 'cards' | 'quiz'
type NoteSource = 'file' | 'paste' | 'photo'
// repeat: the server had nothing new, so this is a question the student has seen before.
type QuizQuestion = GeneratedQuestion & { repeat?: boolean }
type Place = { course: string; unit: string }
// A rename on this page: a whole course (no unit), or one unit of a course.
type Rename = { course: string; unit?: string; newCourse: string; newUnit?: string }

// The server's limits: notes up to 4 MB, course names up to 120 characters and unit names up to 160.
const NOTE_MAX_BYTES = 4 * 1024 * 1024
const COURSE_NAME_MAX = 120
const UNIT_NAME_MAX = 160
const NAME_TOO_LONG_MESSAGE = `Course names can be up to ${COURSE_NAME_MAX} characters and unit names up to ${UNIT_NAME_MAX}. Pick a shorter name.`
// Photos (PNG, JPEG, WebP) are shrunk before they are sent, so their size is checked by the server.
const SHRUNK_TYPES = ['image/png', 'image/jpeg', 'image/webp']
// Course and unit names holding saved notes are fetched again on focus, at most this often.
const SCOPES_REFRESH_MS = 30_000

/* A name the server rejected for its length (422), or the request otherwise invalid. */
function nameRejected(error: unknown) {
  return error instanceof ApiError && error.status === 422
}

/* Where a note filed under `place` is now, after the renames made since. */
function placeAfter(place: Place, renames: Rename[]): Place {
  let { course, unit } = place
  for (const rename of renames) {
    if (!sameName(course, rename.course)) continue
    if (rename.unit === undefined) course = rename.newCourse
    else if (sameName(unit, rename.unit)) {
      course = rename.newCourse
      unit = rename.newUnit ?? unit
    }
  }
  return { course, unit }
}

/* Instructions being typed, moved along with renamed units. */
function movedDrafts(drafts: Record<string, string>, moves: [Place, Place][]) {
  let next = drafts
  for (const [from, to] of moves) {
    for (const kind of ['quiz', 'cards'] as const) {
      const fromKey = instructionsKey(kind, from.course, from.unit)
      if (!(fromKey in next)) continue
      const { [fromKey]: value, ...rest } = next
      next = { ...rest, [instructionsKey(kind, to.course, to.unit)]: value }
    }
  }
  return next
}

/* The calendar day on this device, as YYYY-MM-DD (not the UTC day toISOString gives). */
function localDay(time: number) {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/* A card's front without case or spacing differences, so a duplicate card shows once. */
function cardFace(front: string) {
  return front.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function uniqueCards(list: Flashcard[]) {
  const seen = new Set<string>()
  return list.filter((card) => {
    const face = cardFace(card.front)
    if (seen.has(face)) return false
    seen.add(face)
    return true
  })
}

const collapse = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()
const TEXT_NOTE = /\.(txt|md|csv|json)$/i

/* A camera photo of notes on its way in: prepared once, so Retry resends the same image. */
type PhotoJob = {
  file: File
  preview: string
  name: string
  course: string
  unit: string
  stage: 'preparing' | 'uploading' | 'reading' | 'added' | 'failed'
}

const photoDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

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
  const time = parseServerTime(value)
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

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
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

function FocusIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={on ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
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

/* Where one note's saved flashcards stand, as shown next to the note and in the deck. */
type NoteCards = { status: NoteFlashcardStatus; count: number; error: string; retry: boolean }
type NoteRef = { id: string; course: string; unit: string }

const FLASHCARD_LIMIT_MESSAGE = 'You’ve made a lot of flashcards today — try again tomorrow.'
const FLASHCARD_FAILED_MESSAGE = 'Something went wrong. Try again in a moment.'
const POLL_INTERVAL_MS = 3000
const POLL_ATTEMPTS = 20

function noteCardsFromServer(state: NoteFlashcardState): NoteCards {
  return {
    status: state.status,
    count: state.card_count,
    error: state.status === 'failed' ? state.error || FLASHCARD_FAILED_MESSAGE : '',
    retry: state.status === 'failed',
  }
}

/* A failed generation, in words the student can act on. */
function flashcardFailure(error: unknown): NoteCards {
  const failed = (message: string, retry = true): NoteCards => ({ status: 'failed', count: 0, error: message, retry })
  if (error instanceof ApiError) {
    if (error.status === 404) return failed('This note isn’t saved anymore.', false)
    if (error.status === 429) return failed(error.message && error.message !== RATE_LIMITED_MESSAGE ? error.message : FLASHCARD_LIMIT_MESSAGE)
    if (error.code === 'ai_daily_limit') return failed(AI_BREAK_MESSAGE)
    return failed(error.message || FLASHCARD_FAILED_MESSAGE)
  }
  if (error instanceof RequestTimeoutError) return failed(error.message)
  if (error instanceof OfflineError || isOffline()) return failed(OFFLINE_MESSAGE)
  return failed('Couldn’t reach bindit. Check your connection and try again.')
}

/* Adds cards that are new and refreshes ones already shown, keeping their order so the open card stays put. */
function mergeCards(current: Flashcard[], incoming: Flashcard[]) {
  if (!incoming.length) return current
  const byId = new Map(incoming.map((card) => [card.id, card]))
  const known = new Set(current.map((card) => card.id))
  return [...current.map((card) => byId.get(card.id) ?? card), ...incoming.filter((card) => !known.has(card.id))]
}

function noteFromServer(note: UploadedNote): NoteDeposit {
  return {
    id: note.id,
    course: note.course,
    unit: note.unit,
    fileName: note.file_name,
    createdAt: note.created_at,
    status: 'ready',
    textPreview: note.text_preview,
  }
}

const RECENT_QUESTIONS = 10
const NO_NEW_QUESTION_MESSAGE = 'You’ve gone through every question I can make from these notes — add more notes or change the instructions.'

/* A question's text without case, spacing or punctuation, so a reworded repeat still matches. */
function questionFingerprint(text: string) {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')
}

/* Why a unit's notes or flashcards didn't load, in words the student can act on. */
function libraryFailure(error: unknown, what: 'notes' | 'flashcards' = 'notes') {
  const fallback = `Couldn’t load your ${what}.`
  if (error instanceof OfflineError || isOffline()) return `You’re offline, and the ${what} for this unit aren’t saved on this device yet. Open this unit once while online to study its flashcards offline.`
  if (nameRejected(error)) return `${fallback} ${NAME_TOO_LONG_MESSAGE}`
  if (error instanceof RequestTimeoutError) return `${fallback} ${error.message}`
  if (error instanceof ApiError && (error.status === 401 || error.status === 429)) return `${fallback} ${error.message}`
  return `${fallback} Check your connection and try again.`
}

/* Why a question didn't load, in words the student can act on. */
function quizLoadFailure(error: unknown) {
  if (error instanceof RequestTimeoutError || error instanceof OfflineError) return error.message
  if (error instanceof ApiError && error.message) return error.message
  return 'Couldn’t load a question. Try again in a moment.'
}

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms) })

/* Study's hash asks for Review mode over every unit ("#tools?review=all", from Home or the sidebar). */
function reviewRequested() {
  const [screen, query = ''] = window.location.hash.replace('#', '').split('?')
  return screen === 'tools' && new URLSearchParams(query).get('review') === 'all'
}

/* startReview: the landing demo opens Review over every unit this way (it never reads the hash). */
export function Tools({ accessToken, startReview = false }: { accessToken?: string; startReview?: boolean }) {
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
  const [quizDifficulty, setQuizDifficulty] = useState(1)
  const [quizQuestion, setQuizQuestion] = useState<QuizQuestion | null>(null)
  const [quizAnswer, setQuizAnswer] = useState('')
  const [quizResult, setQuizResult] = useState<AnswerResult | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizChecking, setQuizChecking] = useState(false)
  const [quizError, setQuizError] = useState('')
  const [quizFailed, setQuizFailed] = useState<'' | 'load' | 'check'>('')
  // The server says this question was already answered correctly (a repeated Check).
  const [quizDone, setQuizDone] = useState(false)
  // Every course and unit holding saved notes (null until loaded, or if the server can't say).
  const [scopes, setScopes] = useState<NoteScope[] | null>(null)
  // A note whose text matches one already in its unit, waiting for "Add anyway".
  const [duplicate, setDuplicate] = useState<{ source: NoteSource; file: File; name: string; course: string; unit: string } | null>(null)
  // Saved flashcards and server notes from every unit opened so far; each view filters its own.
  const [savedCards, setSavedCards] = useState<Flashcard[]>([])
  const [serverNotes, setServerNotes] = useState<NoteDeposit[]>([])
  const [noteCards, setNoteCards] = useState<Record<string, NoteCards>>({})
  // cardsFailed: the notes loaded but their flashcards didn't (each is shown on its own).
  const [library, setLibrary] = useState<{ key: string; status: 'loading' | 'ready' | 'error'; error: string; cardsFailed: boolean }>({ key: '', status: 'loading', error: '', cardsFailed: false })
  const [libraryRequest, setLibraryRequest] = useState(0)
  // The unit whose flashcards are shown from this device's offline copy (key and when it was saved).
  const [offlineCopy, setOfflineCopy] = useState<{ key: string; savedAt: number } | null>(null)
  const online = useOnline()
  const [panelFn, setPanelFn] = useState<ToolView>('scan')
  // Focus mode: the current card or question, large, with the panel's other controls hidden.
  const [focusMode, setFocusMode] = useState(false)
  const [focusSize, setFocusSize] = useState(() => (data.sandboxed ? 1 : loadFocusSize()))
  // Flashcards: Browse the deck or Review what's due, chosen per unit. A unit's first visit
  // opens Review when it has due or new cards.
  const [cardModes, setCardModes] = useState<Record<string, 'browse' | 'review'>>({})
  // Review over every unit (the header's "N cards due" button, or Home and the sidebar).
  const [reviewAll, setReviewAll] = useState(() => startReview || (!data.sandboxed && reviewRequested()))
  const reviewSummary = useReviewSummary(accessToken)
  // Custom instructions per unit and kind, as typed (saved on this device), and any rejection.
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({})
  const [instructionErrors, setInstructionErrors] = useState<Record<string, string>>({})
  const [remaking, setRemaking] = useState<{ done: number; total: number } | null>(null)
  const [orderOpen, setOrderOpen] = useState(false)
  const [orderDrag, setOrderDrag] = useState('')
  const [lookCourse, setLookCourse] = useState('')
  const [lookBusy, setLookBusy] = useState(false)
  const [lookHint, setLookHint] = useState('')
  // An open practice test (setup, test or results) for a unit, or for the whole course (unit null).
  const [practice, setPractice] = useState<{ course: string; unit: string | null; openId?: string; key: number } | null>(null)
  // The active unit's practice tests (for Resume and the last score on the Quiz panel).
  const [unitTests, setUnitTests] = useState<{ key: string; tests: PracticeTestSummary[] } | null>(null)
  const [unitTestsRequest, setUnitTestsRequest] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const [photo, setPhoto] = useState<PhotoJob | null>(null)
  // Each preview URL is released when the next photo replaces it, or when the page closes.
  const photoPreview = photo?.preview
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview) }, [photoPreview])
  const courseImageInput = useRef<HTMLInputElement>(null)
  const orderDragIndex = useRef(-1)
  const menuRef = useRef<HTMLDivElement>(null)
  const studentId = useRef(data.getStudentId())
  // AI generation is rate limited per day, so generated content is only requested
  // when what it depends on changes, never just because the user switched views.
  // Flashcards are written once per note, when it is saved, and kept on the server.
  const generatingNotes = useRef(new Set<string>())
  const mounted = useRef(true)
  const loadedQuizKey = useRef('')
  const quizSequence = useRef(0)
  // Fingerprints of the questions shown most recently, newest first.
  const shownQuestions = useRef<string[]>([])
  // At most one question is fetched ahead per quiz setting; leaving that setting cancels it.
  const prefetchedQuestions = useRef(new Map<string, { promise: Promise<GeneratedQuestion>; controller: AbortController; instructions: string }>())
  const intentTimer = useRef(0)
  // The question request in flight, and the quiz setting it was for.
  const quizRequest = useRef<{ key: string; controller: AbortController } | null>(null)
  // Every course and unit rename made on this page, in order; a note uploaded or a deck
  // made while one happened is moved after it lands, so it follows its unit.
  const renameLog = useRef<Rename[]>([])
  // Saved notes' sizes (from the server), to spot the same notes added twice.
  const noteSizes = useRef(new Map<string, number>())
  // Where each known note is filed now, so a check on a note follows its unit through renames.
  const notePlaces = useRef(new Map<string, Place>())
  const scopeRequest = useRef(0)

  const courses = notebook.courses
  const activeCourse = notebook.activeCourse
  const activeUnit = notebook.activeUnit
  const units = unitsFor(courses, activeCourse)
  const current = courses.find((course) => course.name === activeCourse)
  const looking = courses.find((course) => course.name === lookCourse) ?? current
  // A unit's notes are the ones saved on the server (from any device) plus this device's own.
  const localUnitNotes = notesFor(notebook.deposits, activeCourse, activeUnit)
  const unitNotes = [
    ...localUnitNotes,
    ...notesFor(serverNotes, activeCourse, activeUnit).filter((note) => !localUnitNotes.some((item) => item.id === note.id)),
  ].sort((a, b) => (parseServerTime(b.createdAt) || 0) - (parseServerTime(a.createdAt) || 0))
  // Every note in the course, on any device (the server's count), or those this page has seen.
  const courseScopes = scopes?.filter((scope) => sameName(scope.course, activeCourse))
  const courseNoteCount = courseScopes
    ? courseScopes.reduce((sum, scope) => sum + scope.note_count, 0)
    : new Set([
      ...notebook.deposits.filter((note) => sameName(note.course, activeCourse)).map((note) => note.id),
      ...serverNotes.filter((note) => sameName(note.course, activeCourse)).map((note) => note.id),
    ]).size
  const unitKey = `${activeCourse}|${activeUnit}`
  const unitReview = reviewSummary?.by_unit.find((entry) => entry.course === activeCourse && entry.unit === activeUnit)
  // Until the student picks, Review is chosen once the unit has due or new cards, and then
  // kept (so finishing a review shows "All caught up" rather than switching to Browse).
  const reviewReady = Boolean(unitReview && unitReview.due + unitReview.new > 0)
  if (activeUnit && !cardModes[unitKey] && reviewReady) setCardModes((current) => ({ ...current, [unitKey]: 'review' }))
  const cardMode = cardModes[unitKey] ?? (reviewReady ? 'review' : 'browse')
  const libraryLoaded = library.key === unitKey && library.status === 'ready'
  const libraryLoading = library.key !== unitKey || library.status === 'loading'
  const libraryFailed = library.key === unitKey && library.status === 'error'
  const cardsFailed = libraryFailed || (libraryLoaded && library.cardsFailed)
  const unitNoteIds = new Set(unitNotes.map((note) => note.id))
  // The same notes added twice make the same cards: each question shows once.
  const cards = uniqueCards(savedCards.filter((item) => unitNoteIds.has(item.note_id)))
  const card = cards.length ? cards[cardIndex % cards.length] : null
  // A note the server has not reported on yet has no flashcards so far.
  const cardsFor = (note: NoteDeposit): NoteCards | undefined =>
    noteCards[note.id] ?? (libraryLoaded && !library.cardsFailed ? { status: 'none', count: 0, error: '', retry: false } : undefined)
  const notesWith = (status: NoteFlashcardStatus) => unitNotes.filter((note) => cardsFor(note)?.status === status)
  const makingNotes = notesWith('generating')
  const failedNotes = notesWith('failed')
  const waitingNotes = notesWith('none')
  const shortNotes = notesWith('too_short')
  const uploadBusy = Boolean(uploading)
  const quizKey = `${activeCourse}|${activeUnit}|notes:${unitNotes.length}|${quizDifficulty}`
  const quizInstructionsKey = instructionsKey('quiz', activeCourse, activeUnit)
  const cardInstructionsKey = instructionsKey('cards', activeCourse, activeUnit)
  const instructionsFor = (key: string) => instructionDrafts[key] ?? (data.sandboxed ? '' : loadInstructions(key))
  const quizInstructions = instructionsFor(quizInstructionsKey)
  const cardInstructions = instructionsFor(cardInstructionsKey)

  useEffect(() => {
    data.saveNotebook(notebook)
  }, [data, notebook])

  useEffect(() => {
    const places = notePlaces.current
    for (const note of [...serverNotes, ...notebook.deposits]) places.set(note.id, { course: note.course, unit: note.unit })
  }, [notebook.deposits, serverNotes])

  // Adds every course and unit holding saved notes (from any device) to this device's
  // notebook, and keeps the server's note counts. Nothing here is ever removed.
  function loadScopes() {
    const request = ++scopeRequest.current
    const since = renameLog.current.length
    data.listNoteScopes(accessToken).then((listed) => {
      if (!mounted.current || request !== scopeRequest.current) return
      // A rename made while this was loading has moved those notes already: list them under the new name.
      const renames = renameLog.current.slice(since)
      const list = renames.length ? listed.map((scope) => ({ ...scope, ...placeAfter(scope, renames) })) : listed
      setScopes(list)
      const hidden = data.sandboxed ? [] : loadHiddenCourses()
      setNotebook((current) => {
        const merged = mergeNoteScopes(current, list, hidden)
        return merged === current ? current : { ...merged, courses: withCourseTones(merged.courses) }
      })
    }, () => undefined)
  }

  const syncScopes = useEffectEvent(() => loadScopes())

  // On opening the page, and when the window comes back into focus (at most every 30 s).
  useEffect(() => {
    syncScopes()
    if (data.sandboxed) return
    let last = Date.now()
    const onFocus = () => {
      if (Date.now() - last < SCOPES_REFRESH_MS) return
      last = Date.now()
      syncScopes()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [data])

  // The sidebar (or another tab) can change the saved notebook, e.g. pick another course:
  // take its version so this page and the sidebar always show the same course.
  useEffect(() => data.onNotebookChange(() => {
    const loaded = data.loadNotebook()
    const next = { ...loaded, courses: withCourseTones(loaded.courses) }
    setNotebook((current) => {
      if (JSON.stringify(current) === JSON.stringify(next)) return current
      if (current.activeCourse !== next.activeCourse || current.activeUnit !== next.activeUnit) {
        setCardIndex(0)
        setCardFlipped(false)
      }
      return next
    })
  }), [data])

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

  const focusOn = focusMode && (panelFn !== 'scan' || reviewAll || practice !== null)

  // Home and the sidebar link to "#tools?review=all": open Review over every unit, then
  // drop the request from the address so a reload or Back doesn't reopen it.
  useEffect(() => {
    if (data.sandboxed) return
    const sync = () => {
      if (!reviewRequested()) return
      // A practice test in progress stays on the server; its unit's Quiz panel offers Resume.
      setPractice(null)
      setReviewAll(true)
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#tools`)
    }
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [data])

  // Esc leaves focus mode (unless a menu or dialog is open; Esc closes that first).
  useEffect(() => {
    if (!focusOn || orderOpen || menuCourse) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFocusMode(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focusOn, orderOpen, menuCourse])

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

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Takes in what the server reports for a unit: its notes, saved cards, and each note's state.
  // Either list may be missing (its request failed); the other still counts.
  function applyLibrary(course: string, unit: string, result: FlashcardLibrary | null, notes: UploadedNote[] | null) {
    // The server matched these to the course and unit asked for, so they are filed under
    // exactly those names (the server trims names; this page's may differ only in spacing).
    for (const note of notes ?? []) noteSizes.current.set(note.id, note.size_bytes)
    const listed = (notes ?? []).map((note) => ({ ...noteFromServer(note), course, unit }))
    const fromStates: NoteDeposit[] = (result?.notes ?? [])
      .filter((state) => !listed.some((note) => note.id === state.note_id))
      .map((state) => ({ id: state.note_id, course, unit, fileName: state.file_name, createdAt: state.updated_at ?? '', status: 'ready' }))
    const incoming = [...listed, ...fromStates]
    setServerNotes((current) => [...current.filter((note) => !sameName(note.course, course) || !sameName(note.unit, unit)), ...incoming])
    if (!result) return
    setSavedCards((current) => mergeCards(current, result.cards))
    setNoteCards((current) => {
      const next = { ...current }
      for (const state of result.notes) {
        const settled = state.status === 'ready' || state.status === 'too_short'
        // While this page is writing a note's cards, only a finished result replaces "Making flashcards…".
        if (generatingNotes.current.has(state.note_id) && !settled) continue
        const known = current[state.note_id]
        if (state.status === 'none' && known && known.status !== 'none') continue
        next[state.note_id] = noteCardsFromServer(state)
      }
      return next
    })
  }

  const loadUnitLibrary = useEffectEvent((course: string, unit: string, signal: AbortSignal) => {
    const key = `${course}|${unit}`
    // Notes and flashcards load side by side and independently: a failure of one never
    // hides the other (the flashcard states name every note too, so either lists the notes).
    void Promise.allSettled([
      data.listFlashcards({ course, unit }, accessToken, signal),
      data.listNotes(course, unit, accessToken, signal),
    ]).then(async ([cardsResult, notesResult]) => {
      if (signal.aborted) return
      const result = cardsResult.status === 'fulfilled' ? cardsResult.value : null
      const notes = notesResult.status === 'fulfilled' ? notesResult.value : null
      const reason = cardsResult.status === 'rejected' ? cardsResult.reason : null
      // Online: keep a copy of the unit's flashcards for offline study.
      if (result) void data.saveOfflineCards({ course, unit }, result)
      // Offline (or bindet can't be reached at all): show the copy from the last time this unit was opened, if there is one.
      if (!result && !isAbortError(reason) && (reason instanceof OfflineError || reason instanceof TypeError || isOffline())) {
        const saved = await data.loadOfflineCards({ course, unit })
        if (signal.aborted) return
        if (saved) {
          applyLibrary(course, unit, { cards: saved.cards, notes: saved.notes }, null)
          setOfflineCopy({ key, savedAt: saved.savedAt })
          setLibrary({ key, status: 'ready', error: '', cardsFailed: false })
          return
        }
      }
      if (!result && !notes) {
        if (isAbortError(reason)) return
        setLibrary({ key, status: 'error', error: libraryFailure(reason), cardsFailed: true })
        return
      }
      if (result) setOfflineCopy((current) => (current?.key === key ? null : current))
      applyLibrary(course, unit, result, notes)
      setLibrary({ key, status: 'ready', error: result ? '' : libraryFailure(cardsResult.status === 'rejected' ? cardsResult.reason : null, 'flashcards'), cardsFailed: !result })
    })
  })

  // Opening a unit reads its saved notes and flashcards. This never asks the AI for anything.
  useEffect(() => {
    if (!activeCourse || !activeUnit) return
    const controller = new AbortController()
    loadUnitLibrary(activeCourse, activeUnit, controller.signal)
    return () => controller.abort()
  }, [activeCourse, activeUnit, libraryRequest])

  // The Quiz panel shows a test in progress (Resume) and the last score. Never asks the AI.
  const loadUnitTests = useEffectEvent((course: string, unit: string, signal: AbortSignal) => {
    const key = `${course}|${unit}`
    data.listPracticeTests(course, unit, accessToken, signal)
      .then((tests) => { if (!signal.aborted) setUnitTests({ key, tests }) })
      .catch(() => { /* the panel simply shows no history */ })
  })

  useEffect(() => {
    if (panelFn !== 'quiz' || practice || !activeCourse || !activeUnit) return
    const controller = new AbortController()
    loadUnitTests(activeCourse, activeUnit, controller.signal)
    return () => controller.abort()
  }, [panelFn, practice, activeCourse, activeUnit, unitTestsRequest])

  function openPractice(unit: string | null, openId?: string) {
    setFocusMode(false)
    setReviewAll(false)
    setPractice({ course: activeCourse, unit, openId, key: Date.now() })
  }

  function reloadLibrary() {
    setLibrary({ key: unitKey, status: 'loading', error: '', cardsFailed: false })
    setLibraryRequest((count) => count + 1)
  }

  // Back online after showing an offline copy (or failing offline): load the unit from the server again.
  const reloadWhenOnline = useEffectEvent(() => {
    if (offlineCopy?.key === unitKey || libraryFailed) reloadLibrary()
  })
  useEffect(() => {
    if (data.sandboxed) return
    const onOnline = () => reloadWhenOnline()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [data])

  /* Where a note is filed now: it may have moved with a rename since `note` was read. */
  function placeOf(note: NoteRef): Place {
    return notePlaces.current.get(note.id) ?? { course: note.course, unit: note.unit }
  }

  /*
   * The server files a new note, or a note's new cards, under the names it had when the
   * request started. If its course or unit was renamed meanwhile, the rename's move has
   * already run, so they are moved after it here: the note and its cards follow their unit.
   */
  function followRenames(from: Place, since: number): Place {
    const to = placeAfter(from, renameLog.current.slice(since))
    if (to.course === from.course && to.unit === from.unit) return to
    void data.moveNotes({ course: from.course, unit: from.unit, newCourse: to.course, newUnit: to.unit }, accessToken)
      .then(() => { if (mounted.current) { reloadLibrary(); loadScopes() } })
      .catch(() => {
        if (!mounted.current) return
        setNotice(`Couldn’t move your latest notes to “${to.unit}”. They’re saved in “${from.unit}” in ${from.course}.`)
        loadScopes()
      })
    return to
  }

  // Writes and saves one note's flashcards. New cards join the deck as soon as they arrive.
  async function makeFlashcards(note: NoteRef, retry = false) {
    if (generatingNotes.current.has(note.id)) return
    generatingNotes.current.add(note.id)
    const origin = placeOf(note)
    const since = renameLog.current.length
    setNoteCards((current) => ({ ...current, [note.id]: { status: 'generating', count: 0, error: '', retry: false } }))
    let stillWorking = false
    try {
      const result = await data.generateNoteFlashcards(note.id, retry ? { retry: true } : undefined, accessToken)
      if (!mounted.current) return
      followRenames(origin, since)
      setSavedCards((current) => mergeCards(current, result.cards))
      setNoteCards((current) => ({ ...current, [note.id]: { status: result.status, count: result.cards.length, error: '', retry: false } }))
      // New cards are new review cards: due counts and Review's default follow.
      if (result.cards.length) announceReviewChange()
    } catch (error) {
      if (!mounted.current) return
      // Already being written (here or on another device), or slower than our wait: watch for the result.
      stillWorking = (error instanceof ApiError && error.status === 409) || error instanceof RequestTimeoutError
      if (!stillWorking) setNoteCards((current) => ({ ...current, [note.id]: flashcardFailure(error) }))
    } finally {
      if (!stillWorking) generatingNotes.current.delete(note.id)
    }
    if (stillWorking) await watchFlashcards(note, origin, since)
  }

  // Checks the saved flashcards every few seconds, for about a minute, until the note's cards are done.
  // The note is found by its id wherever it is filed now, so a rename meanwhile doesn't lose it.
  async function watchFlashcards(note: NoteRef, origin: Place, since: number) {
    try {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        await wait(POLL_INTERVAL_MS)
        if (!mounted.current) return
        let state: NoteFlashcardState | undefined
        try {
          const place = placeOf(note)
          const result = await data.listFlashcards(place, accessToken)
          if (!mounted.current) return
          setSavedCards((current) => mergeCards(current, result.cards))
          state = result.notes.find((item) => item.note_id === note.id)
        } catch {
          continue
        }
        if (!state || state.status === 'generating') continue
        followRenames(origin, since)
        const settled: NoteCards = state.status === 'none'
          ? { status: 'failed', count: 0, error: FLASHCARD_FAILED_MESSAGE, retry: true }
          : noteCardsFromServer(state)
        setNoteCards((current) => ({ ...current, [note.id]: settled }))
        if (settled.status === 'ready') announceReviewChange()
        return
      }
      if (mounted.current) {
        setNoteCards((current) => ({ ...current, [note.id]: { status: 'failed', count: 0, error: 'This is taking longer than usual. Try again in a moment.', retry: true } }))
      }
    } finally {
      generatingNotes.current.delete(note.id)
    }
  }

  // Notes saved before flashcards were automatic get theirs one at a time, to stay within limits.
  async function makeFlashcardsFor(notes: NoteDeposit[]) {
    const queue = notes
      .filter((note) => !generatingNotes.current.has(note.id))
      .map((note) => ({ note, retry: cardsFor(note)?.status === 'failed' }))
    setNoteCards((current) => {
      const next = { ...current }
      for (const { note } of queue) next[note.id] = { status: 'generating', count: 0, error: '', retry: false }
      return next
    })
    for (const { note, retry } of queue) {
      if (!mounted.current) return
      await makeFlashcards(note, retry)
    }
  }

  // Reads the latest quiz inputs without making them reasons to request a new question.
  const loadQuizForKey = useEffectEvent(() => {
    void loadQuizQuestion()
  })

  // A question fetched for another course, unit or level is no longer wanted: cancel it and
  // clear the old question, so the new setting starts from a clean slate.
  const leaveQuizSetting = useEffectEvent((key: string) => {
    const pending = quizRequest.current
    if (pending && pending.key !== key) {
      pending.controller.abort()
      quizRequest.current = null
    }
    if (loadedQuizKey.current === key || !loadedQuizKey.current) return
    quizSequence.current += 1
    loadedQuizKey.current = ''
    setQuizQuestion(null)
    setQuizResult(null)
    setQuizAnswer('')
    setQuizError('')
    setQuizFailed('')
    setQuizDone(false)
    setQuizBusy(false)
    setQuizChecking(false)
  })

  useEffect(() => {
    leaveQuizSetting(quizKey)
  }, [quizKey])

  // A question is asked for only once the unit's notes have loaded (or failed to): asking
  // earlier would ask again as soon as they arrive, since the notes are part of the setting.
  useEffect(() => {
    if (panelFn !== 'quiz' || libraryLoading || loadedQuizKey.current === quizKey) return
    loadedQuizKey.current = quizKey
    loadQuizForKey()
  }, [panelFn, quizKey, libraryLoading])

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
      quizRequest.current?.controller.abort()
      prefetched.forEach((entry) => entry.controller.abort())
      prefetched.clear()
    }
  }, [])

  function addCourse(event: FormEvent) {
    event.preventDefault()
    const name = newCourse.trim()
    if (!name) return
    if (!data.sandboxed) setCourseHidden(name, false)
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
    // A test in progress stays on the server and can be resumed from its unit's Quiz panel.
    if (practice && !sameName(practice.course, name)) setPractice(null)
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
    renameCourseLocally(from, to)
    cancelRenameCourse()
    void moveServerNotes({ course: from, newCourse: to }, () => renameCourseLocally(to, from))
  }

  function renameCourseLocally(from: string, to: string) {
    const rename: Rename = { course: from, newCourse: to }
    renameLog.current.push(rename)
    setScopes((current) => current?.map((scope) => ({ ...scope, ...placeAfter(scope, [rename]) })) ?? null)
    // The course's units keep their custom instructions.
    if (!data.sandboxed) {
      setCourseHidden(to, false)
      for (const unit of unitsFor(courses, from)) moveInstructions({ course: from, unit }, { course: to, unit })
    }
    setInstructionDrafts((current) => movedDrafts(current, unitsFor(courses, from).map((unit) => [{ course: from, unit }, { course: to, unit }])))
    setNotebook((current) => ({
      ...current,
      courses: current.courses.map((course) => (course.name === from ? { ...course, name: to } : course)),
      deposits: current.deposits.map((item) => (sameName(item.course, from) ? { ...item, course: to } : item)),
      activeCourse: current.activeCourse === from ? to : current.activeCourse,
    }))
    setServerNotes((current) => current.map((item) => (sameName(item.course, from) ? { ...item, course: to } : item)))
    setLookCourse((current) => (current === from ? to : current))
  }

  /*
   * Notes are saved on the server under their course and unit names, so a rename moves
   * them there too; otherwise the renamed unit would show no notes on the next load or on
   * another device. If the server can't do it, the rename is undone and the student told.
   */
  async function moveServerNotes(scope: { course: string; unit?: string; newCourse: string; newUnit?: string }, undo: () => void) {
    try {
      await data.moveNotes(scope, accessToken)
      if (mounted.current) {
        reloadLibrary()
        loadScopes()
      }
    } catch (error) {
      if (!mounted.current) return
      undo()
      const what = scope.unit ?? scope.course
      const reason = nameRejected(error) ? ` ${NAME_TOO_LONG_MESSAGE}`
        : error instanceof ApiError && error.message ? `: ${error.message}` : '. Check your connection and try again.'
      setNotice(`Couldn’t rename “${what}”${reason}`)
    }
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
    // Its notes stay saved on the server: keep the course from coming back on the next sync.
    if (!data.sandboxed) setCourseHidden(name, true)
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
    const course = activeCourse
    renameUnitLocally(course, from, to)
    cancelRename()
    void moveServerNotes({ course, unit: from, newCourse: course, newUnit: to }, () => renameUnitLocally(course, to, from))
  }

  function renameUnitLocally(courseName: string, from: string, to: string) {
    const rename: Rename = { course: courseName, unit: from, newCourse: courseName, newUnit: to }
    renameLog.current.push(rename)
    setScopes((current) => current?.map((scope) => ({ ...scope, ...placeAfter(scope, [rename]) })) ?? null)
    if (!data.sandboxed) moveInstructions({ course: courseName, unit: from }, { course: courseName, unit: to })
    setInstructionDrafts((current) => movedDrafts(current, [[{ course: courseName, unit: from }, { course: courseName, unit: to }]]))
    setNotebook((current) => {
      const courses = current.courses.map((course) =>
        course.name === courseName
          ? { ...course, units: course.units.map((item) => (item === from ? to : item)) }
          : course,
      )
      const deposits = current.deposits.map((item) =>
        sameName(item.course, courseName) && sameName(item.unit, from) ? { ...item, unit: to } : item,
      )
      return {
        ...current,
        courses,
        deposits,
        activeUnit: current.activeCourse === courseName && current.activeUnit === from ? to : current.activeUnit,
      }
    })
    setServerNotes((current) => current.map((item) => (sameName(item.course, courseName) && sameName(item.unit, from) ? { ...item, unit: to } : item)))
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
    const stored = prefetchedQuestions.current.get(quizKey)
    // A question fetched ahead with other instructions is not the one asked for now.
    if (stored && stored.instructions !== quizInstructions.trim()) {
      stored.controller.abort()
      prefetchedQuestions.current.delete(quizKey)
    }
    const prefetched = stored && stored.instructions === quizInstructions.trim() ? stored : undefined
    // The question on screen is never shown again as the "new" one; the last few are avoided when possible.
    const onScreen = quizQuestion ? questionFingerprint(quizQuestion.question) : ''
    const repeats = (question: QuizQuestion) => {
      // The server marks a repeat it chose because nothing new was left: asking again won't help.
      if (question.repeat) return false
      const fingerprint = questionFingerprint(question.question)
      return fingerprint === onScreen || shownQuestions.current.includes(fingerprint)
    }
    // Only one question request at a time; leaving this quiz setting cancels it.
    quizRequest.current?.controller.abort()
    const controller = new AbortController()
    quizRequest.current = { key: quizKey, controller }
    setQuizBusy(true)
    setQuizChecking(false)
    setQuizError('')
    setQuizFailed('')
    setQuizResult(null)
    setQuizDone(false)
    setQuizAnswer('')
    try {
      if (prefetched) prefetchedQuestions.current.delete(quizKey)
      let next: QuizQuestion = await (prefetched?.promise ?? requestQuizQuestion(controller.signal))
      // A question fetched ahead can go stale; a repeat is replaced by asking once more.
      if (sequence === quizSequence.current && repeats(next)) next = await requestQuizQuestion(controller.signal)
      if (sequence !== quizSequence.current) return
      if (onScreen && questionFingerprint(next.question) === onScreen) {
        setQuizError(NO_NEW_QUESTION_MESSAGE)
        setQuizFailed('load')
        return
      }
      shownQuestions.current = [questionFingerprint(next.question), ...shownQuestions.current].slice(0, RECENT_QUESTIONS)
      setQuizQuestion(next)
      // While the student works on this one, the next is fetched in the background.
      primeNextQuestion()
    } catch (error) {
      if (sequence === quizSequence.current && !isAbortError(error)) {
        if (error instanceof ApiError && error.code === 'no_new_question') {
          setQuizError(NO_NEW_QUESTION_MESSAGE)
        } else if (error instanceof ApiError && error.code === 'instructions_rejected') {
          // Shown under the instructions field; the question area says what to do.
          setInstructionErrors((current) => ({ ...current, [quizInstructionsKey]: error.message }))
          setQuizError('Change or clear your instructions to get a new question.')
        } else {
          setQuizError(quizLoadFailure(error))
        }
        setQuizFailed('load')
      }
    } finally {
      if (sequence === quizSequence.current) setQuizBusy(false)
      if (quizRequest.current?.controller === controller) quizRequest.current = null
    }
  }

  function requestQuizQuestion(signal?: AbortSignal): Promise<QuizQuestion> {
    // A unit always has a course and unit, so the server writes the question from its
    // notes (or, without notes, from the unit name); the math topics are never used here.
    return data.generateQuestion(
      'mixed',
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
      quizInstructions.trim() || undefined,
    )
  }

  function primeNextQuestion() {
    const key = quizKey
    if (prefetchedQuestions.current.has(key)) return
    const controller = new AbortController()
    const entry = { promise: requestQuizQuestion(controller.signal), controller, instructions: quizInstructions.trim() }
    prefetchedQuestions.current.set(key, entry)
    // A failed prefetch is simply dropped; the next question is then fetched on demand.
    void entry.promise.catch(() => { if (prefetchedQuestions.current.get(key) === entry) prefetchedQuestions.current.delete(key) })
  }

  // Resting on (or tabbing to) the Quiz tab fetches a question early, so it is usually
  // ready by the time the view opens. Flashcards are already saved, so they need no head start.
  function showIntent(view: ToolView) {
    window.clearTimeout(intentTimer.current)
    if (view === panelFn || !activeCourse || !activeUnit) return
    if (view === 'quiz' && !libraryLoading && loadedQuizKey.current !== quizKey) primeNextQuestion()
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
    if (!quizQuestion || !answer.trim() || quizBusy || quizResult?.correct || quizDone) return
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
      // Already answered correctly (a second Check that crossed the first): nothing went wrong.
      if (error instanceof ApiError && error.status === 409) {
        setQuizDone(true)
        return
      }
      // A 503 means the grader is busy or offline: the answer wasn't graded, so the
      // server's message says to resubmit, and Try again sends the same answer.
      const unavailable = error instanceof ApiError && error.status === 503
      setQuizError(error instanceof RequestTimeoutError || error instanceof OfflineError || unavailable ? (error as Error).message : 'Couldn’t check that answer. Try again in a moment.')
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
    // Named for the day on this device (toISOString would give the UTC day).
    const typedNote = new File([text], `typed-notes-${localDay(data.now())}.txt`, { type: 'text/plain' })
    const saved = await ingestNote(typedNote, 'paste')
    if (saved) setPastedNotes('')
  }

  /* "Take a photo of your notes": the camera opens, and the photo uploads as soon as it is taken. */
  function openCamera() {
    if (!activeUnit) {
      setUploadError({ source: 'photo', message: 'Pick or create a unit first.', retry: false })
      return
    }
    photoInput.current?.click()
  }

  async function onPhotoTaken(event: React.ChangeEvent<HTMLInputElement>) {
    const taken = event.target.files?.[0]
    event.target.value = ''
    if (!taken || uploadBusy) return
    if (!activeUnit) {
      setUploadError({ source: 'photo', message: 'Pick or create a unit first.', retry: false })
      return
    }
    const course = activeCourse
    const unit = activeUnit
    // Each page is its own note: "Photo notes – Oct 7, page 2".
    const base = `Photo notes – ${photoDay.format(new Date(data.now()))}`
    const page = unitNotes.filter((note) => note.fileName.startsWith(base)).length + 1
    const name = `${base}, page ${page}`
    setUploadError(null)
    setPhoto({ file: taken, preview: URL.createObjectURL(taken), name, course, unit, stage: 'preparing' })
    let prepared: File
    try {
      prepared = await prepareNotePhoto(taken, name)
    } catch (error) {
      setPhoto((current) => current && { ...current, stage: 'failed' })
      setUploadError({ source: 'photo', message: error instanceof Error ? error.message : 'That photo could not be prepared.', retry: false })
      return
    }
    const job: PhotoJob = { file: prepared, preview: URL.createObjectURL(prepared), name, course, unit, stage: 'uploading' }
    setPhoto(job)
    await sendPhoto(job)
  }

  async function sendPhoto(job: PhotoJob) {
    setPhoto((current) => current && { ...current, stage: 'uploading' })
    const saved = await ingestNote(job.file, 'photo', () => setPhoto((current) => current && current.stage === 'uploading' ? { ...current, stage: 'reading' } : current))
    setPhoto((current) => current && { ...current, stage: saved ? 'added' : 'failed' })
  }

  /* A note already in this unit with the same text (or, for PDFs and documents, the same file). */
  async function sameNotes(candidate: File): Promise<NoteDeposit | undefined> {
    const isText = TEXT_NOTE.test(candidate.name) || candidate.type.startsWith('text/')
    let text = ''
    if (isText) {
      try {
        text = collapse(await candidate.text())
      } catch {
        return undefined
      }
    }
    return unitNotes.find((note) => {
      const size = noteSizes.current.get(note.id)
      if (!isText) return size === candidate.size && note.fileName.toLowerCase() === candidate.name.toLowerCase()
      const preview = collapse(note.textPreview ?? '')
      if (!preview) return false
      // The preview is the start of the note's text: with the same size, the same start means the same notes.
      return size === undefined ? preview === text : size === candidate.size && text.startsWith(preview)
    })
  }

  async function ingestNote(candidate: File, source: NoteSource, onSent?: () => void, allowDuplicate = false): Promise<boolean> {
    if (!activeUnit) {
      setUploadError({ source, message: source === 'photo' ? 'Pick or create a unit first.' : `Create a unit in ${activeCourse} first, then send your notes there.`, retry: false })
      return false
    }
    if (!SHRUNK_TYPES.includes(candidate.type) && candidate.size > NOTE_MAX_BYTES) {
      setUploadError({ source, message: `“${candidate.name}” is ${formatBytes(candidate.size)}. Notes must be 4 MB or smaller. Try a smaller file, or split it into parts.`, retry: false })
      return false
    }
    // The note is filed under the course and unit it was sent to, even if the student moves on meanwhile.
    const course = activeCourse
    const unit = activeUnit
    setDuplicate(null)
    setUploading(source)
    if (!allowDuplicate && source !== 'photo') {
      const twin = await sameNotes(candidate)
      if (twin) {
        setUploading('')
        setUploadError(null)
        setDuplicate({ source, file: candidate, name: twin.fileName, course, unit })
        return false
      }
    }
    const since = renameLog.current.length
    setUploadError(null)
    setNotice('')
    try {
      const uploaded = await data.uploadNote(candidate, course, unit, accessToken, onSent ? { onSent } : undefined)
      noteSizes.current.set(uploaded.id, uploaded.size_bytes)
      // Renamed while it uploaded: the note follows its unit (the server filed it under the old name).
      const place = followRenames({ course, unit }, since)
      const deposit: NoteDeposit = {
        id: uploaded.id,
        // The server trims names; keep this page's spelling so the note shows in its unit.
        course: place.course,
        unit: place.unit,
        fileName: uploaded.file_name,
        createdAt: uploaded.created_at,
        status: uploaded.status,
        textPreview: uploaded.text_preview,
      }
      setNotebook((current) => ({ ...current, deposits: [deposit, ...current.deposits.filter((note) => note.id !== deposit.id)] }))
      if (source === 'file') {
        setFile(null)
        if (fileInput.current) fileInput.current.value = ''
      }
      setNotice(`Added “${deposit.fileName}” to ${place.course} → ${place.unit}.`)
      notePlaces.current.set(deposit.id, place)
      // (After a move, the counts are fetched once the move is done.)
      if (place.course === course && place.unit === unit) loadScopes()
      // Flashcards are written in the background; the note's row shows how that is going.
      void makeFlashcards(deposit)
      return true
    } catch (error) {
      // Too large (413) or a name too long (422): sending the same thing again won't help.
      const tooLarge = error instanceof ApiError && error.status === 413
      const message = nameRejected(error) ? NAME_TOO_LONG_MESSAGE
        : tooLarge ? error.message || 'Notes must be 4 MB or smaller.'
          : error instanceof Error ? error.message : 'Could not read that note.'
      setUploadError({ source, message, retry: !tooLarge && !nameRejected(error) })
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
      // The server removes the note's flashcards along with it.
      setServerNotes((current) => current.filter((item) => item.id !== note.id))
      setSavedCards((current) => current.filter((item) => item.note_id !== note.id))
      announceReviewChange()
      setNoteCards((current) => {
        const next = { ...current }
        delete next[note.id]
        return next
      })
      setNotice(`Removed “${note.fileName}”.`)
      loadScopes()
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
    // Review mode handles its own keys (ReviewSession).
    if (cardMode === 'review') return
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable]') || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === ' ') {
      // Space flips the card from anywhere in the deck (after Next, focus is on Next), but
      // other buttons here (Retry, Focus, Make flashcards…) keep Space for themselves.
      const control = target.closest('button, a')
      if (!card || (control && !control.hasAttribute('data-card-key'))) return
      event.preventDefault()
      if (!event.repeat) setCardFlipped((open) => !open)
      return
    }
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    goCard(event.key === 'ArrowRight' ? 'next' : 'prev')
  }

  async function addAnyway() {
    const pending = duplicate
    if (!pending) return
    setDuplicate(null)
    const saved = await ingestNote(pending.file, pending.source, undefined, true)
    if (saved && pending.source === 'paste') setPastedNotes('')
  }

  const duplicateAlert = (source: NoteSource) => duplicate && duplicate.source === source && duplicate.course === activeCourse && duplicate.unit === activeUnit ? (
    <div className="ui-alert ui-alert--info" role="alert">
      <span>You already added these notes (“{duplicate.name}”).</span>
      <button className="ui-button ui-button--sm" type="button" onClick={() => void addAnyway()} disabled={uploadBusy}>Add anyway</button>
      <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => setDuplicate(null)}>Cancel</button>
    </div>
  ) : null

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
        maxLength={COURSE_NAME_MAX}
        autoComplete="off"
        autoCapitalize="words"
        enterKeyHint="done"
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
                maxLength={COURSE_NAME_MAX}
                autoComplete="off"
                autoCapitalize="words"
                enterKeyHint="done"
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

  // The flashcard state next to each note: being written, how many, too short, or what went wrong.
  function noteCardsStatus(note: NoteDeposit) {
    const state = cardsFor(note)
    let content: React.ReactNode = null
    if (state?.status === 'generating') content = <><span className="ui-spinner" />Making flashcards…</>
    else if (state?.status === 'ready') content = plural(state.count, 'flashcard')
    else if (state?.status === 'too_short') content = 'Too short for flashcards'
    else if (state?.status === 'none') {
      content = (
        <>
          No flashcards yet
          <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void makeFlashcards(note)} aria-label={`Make flashcards from ${note.fileName}`}>
            Make flashcards
          </button>
        </>
      )
    } else if (state?.status === 'failed') {
      content = (
        <>
          <span>Couldn’t make flashcards. {state.error}</span>
          {state.retry ? (
            <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void makeFlashcards(note, true)} aria-label={`Retry flashcards for ${note.fileName}`}>
              Retry
            </button>
          ) : null}
        </>
      )
    }
    return (
      <span className={`tools__note-cards${state ? ` is-${state.status}` : ''}`} aria-live="polite">
        {content}
      </span>
    )
  }

  // Under the deck (or its empty state): notes still being written, ones that failed, and ones without cards yet.
  const showDeckStatus = panelFn === 'cards' && unitNotes.length > 0 && (card !== null || !libraryLoading)
  const deckStatus = showDeckStatus ? (
    <div className="tools__deck-status" aria-live="polite">
      {card && makingNotes.length ? (
        <p className="tools__status"><span className="ui-spinner" />Making flashcards from {plural(makingNotes.length, 'more note')}…</p>
      ) : null}
      {failedNotes.map((note) => {
        const state = cardsFor(note)
        return (
          <div key={note.id} className="ui-alert">
            <span>Couldn’t make flashcards from “{note.fileName}”. {state?.error}</span>
            {state?.retry ? (
              <button className="ui-button ui-button--sm" type="button" onClick={() => void makeFlashcards(note, true)} aria-label={`Retry flashcards for ${note.fileName}`}>
                Retry
              </button>
            ) : null}
          </div>
        )
      })}
      {waitingNotes.length ? (
        <div className="ui-alert ui-alert--info">
          <span>{waitingNotes.length === 1 ? '1 note doesn’t' : `${waitingNotes.length} notes don’t`} have flashcards yet.</span>
          <button className="ui-button ui-button--sm ui-button--primary" type="button" onClick={() => void makeFlashcardsFor(waitingNotes)}>
            Make flashcards
          </button>
        </div>
      ) : null}
      {card && shortNotes.length ? (
        <p className="tools__hint">{shortNotes.length === 1 ? '1 note was' : `${shortNotes.length} notes were`} too short for flashcards.</p>
      ) : null}
    </div>
  ) : null
  const loadingQuestion = quizBusy && !quizChecking
  // A question answered correctly is done: its answer can't be changed or sent again.
  const answered = Boolean(quizResult?.correct) || quizDone

  function setInstructions(key: string, value: string) {
    const next = value.slice(0, INSTRUCTIONS_MAX)
    setInstructionDrafts((current) => ({ ...current, [key]: next }))
    setInstructionErrors((current) => {
      if (!(key in current)) return current
      const rest = { ...current }
      delete rest[key]
      return rest
    })
    if (!data.sandboxed) saveInstructions(key, next)
  }

  // Replaces each note's flashcards with new ones made using the unit's instructions, one note at a time.
  async function remakeCards() {
    const instructions = cardInstructions.trim()
    const notes = unitNotes.filter((note) => cardsFor(note)?.status !== 'too_short' && !generatingNotes.current.has(note.id))
    if (!instructions || !notes.length || remaking) return
    if (!data.confirm(`Replace the flashcards for ${plural(notes.length, 'note')} in ${activeUnit} with new ones made with your instructions?`)) return
    const key = cardInstructionsKey
    setRemaking({ done: 0, total: notes.length })
    try {
      for (const [index, note] of notes.entries()) {
        if (!mounted.current) return
        const before = noteCards[note.id]
        const origin = placeOf(note)
        const since = renameLog.current.length
        generatingNotes.current.add(note.id)
        setNoteCards((current) => ({ ...current, [note.id]: { status: 'generating', count: 0, error: '', retry: false } }))
        try {
          const result = await data.remakeNoteFlashcards(note.id, instructions, accessToken)
          if (!mounted.current) return
          followRenames(origin, since)
          setSavedCards((current) => mergeCards(current.filter((item) => item.note_id !== note.id), result.cards))
          setNoteCards((current) => ({ ...current, [note.id]: { status: result.status, count: result.cards.length, error: '', retry: false } }))
          setCardIndex(0)
          setCardFlipped(false)
        } catch (error) {
          if (!mounted.current) return
          // The note keeps its old cards; say what went wrong under the field and stop.
          setNoteCards((current) => {
            const next = { ...current }
            if (before) next[note.id] = before
            else delete next[note.id]
            return next
          })
          const message = error instanceof ApiError && error.code === 'instructions_rejected'
            ? error.message
            : `Couldn’t make new cards for “${note.fileName}”: ${flashcardFailure(error).error}`
          setInstructionErrors((current) => ({ ...current, [key]: message }))
          return
        } finally {
          generatingNotes.current.delete(note.id)
        }
        setRemaking({ done: index + 1, total: notes.length })
      }
      setNotice(`Made new flashcards for ${plural(notes.length, 'note')} in ${activeUnit}.`)
      announceReviewChange()
    } finally {
      if (mounted.current) setRemaking(null)
    }
  }

  const instructionsField = (kind: InstructionKind, key: string, value: string, action?: React.ReactNode) => {
    const id = `instructions-${kind}`
    const error = instructionErrors[key]
    return (
      <div className="tools__instructions">
        <label className="tools__label" htmlFor={id}>Instructions <span className="tools__optional">optional</span></label>
        <div className="tools__instructions-row">
          <input
            id={id}
            className="ui-input"
            type="text"
            value={value}
            maxLength={INSTRUCTIONS_MAX}
            onChange={(event) => setInstructions(key, event.target.value)}
            placeholder="e.g. focus on vocabulary, make them harder, use fill-in-the-blank"
            enterKeyHint="done"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-meta${error ? ` ${id}-error` : ''}`}
            autoComplete="off"
          />
          {action}
        </div>
        <p className="tools__instructions-meta" id={`${id}-meta`}>
          <span>{kind === 'quiz' ? 'Used for your next questions in this unit.' : 'Your saved cards change only when you make new ones.'}</span>
          <span className={value.length >= INSTRUCTIONS_MAX ? 'is-full' : ''}>{value.length}/{INSTRUCTIONS_MAX}</span>
        </p>
        {error ? <p className="tools__field-error" id={`${id}-error`} role="alert">{error}</p> : null}
      </div>
    )
  }

  function changeFocusSize(step: number) {
    const next = Math.max(0, Math.min(FOCUS_SIZES.length - 1, step))
    setFocusSize(next)
    if (!data.sandboxed) saveFocusSize(next)
  }

  const focusControls = (
    <div className="tools__focus-controls">
      {focusOn ? (
        <div className="tools__text-size" role="group" aria-label="Text size">
          <button className="ui-button ui-button--sm ui-button--ghost" type="button" onClick={() => changeFocusSize(focusSize - 1)} disabled={focusSize === 0} aria-label="Smaller text">A−</button>
          <span className="tools__text-size-value" aria-live="polite">{Math.round(FOCUS_SIZES[focusSize] * 100)}%</span>
          <button className="ui-button ui-button--sm ui-button--ghost" type="button" onClick={() => changeFocusSize(focusSize + 1)} disabled={focusSize === FOCUS_SIZES.length - 1} aria-label="Larger text">A+</button>
        </div>
      ) : null}
      <button
        className={`ui-button ui-button--sm tools__focus-toggle${focusOn ? ' is-on' : ''}`}
        type="button"
        aria-pressed={focusOn}
        title={focusOn ? 'Leave focus mode (Esc)' : 'Large text, fewer distractions'}
        onClick={() => setFocusMode((on) => !on)}
      >
        <FocusIcon on={focusOn} />Focus
      </button>
    </div>
  )
  const focusStyle = { ['--focus-scale' as string]: String(FOCUS_SIZES[focusSize]) }
  const toneForCourse = (name: string) => {
    const match = courses.find((course) => sameName(course.name, name))
    return match ? courseTone(match) : undefined
  }
  // Pasted text is only saved by "Add typed notes"; leaving it behind would look like saved notes.
  const unsavedPaste = pastedNotes.trim() && panelFn !== 'scan' ? (
    <div className="ui-alert tools__unsaved" role="status">
      <span>Your typed notes aren’t saved yet, so they aren’t used here.</span>
      <button className="ui-button ui-button--sm" type="button" onClick={() => setPanelFn('scan')}>Review and save</button>
    </div>
  ) : null

  const testsHere = unitTests?.key === unitKey ? unitTests.tests : []
  const inProgressTest = testsHere.find((test) => test.status === 'in_progress')
  const lastTest = testsHere.find((test) => test.status === 'submitted')
  const practiceEntry = (
    <section className="tools__practice" aria-labelledby="tools-practice-title">
      <div className="tools__practice-text">
        <h3 className="tools__label" id="tools-practice-title">Practice test</h3>
        <p className="tools__hint">
          {!unitNotes.length
            ? `Add notes to ${activeUnit} to take a timed practice test.`
            : inProgressTest
              ? `You have a test in progress from ${formatDay(inProgressTest.created_at) || 'earlier'}.`
              : lastTest
                ? `Last score: ${lastTest.score ?? 0} of ${lastTest.question_count} (${formatDay(lastTest.created_at)}).`
                : `A timed test of 5–15 questions from ${plural(unitNotes.length, 'note')}, with a score report and weak spots.`}
        </p>
      </div>
      <div className="tools__practice-actions">
        {inProgressTest ? (
          <button className="ui-button ui-button--primary tools__practice-entry" type="button" onClick={() => openPractice(activeUnit, inProgressTest.id)}>
            Resume practice test
          </button>
        ) : null}
        <button className="ui-button tools__practice-entry" type="button" disabled={!unitNotes.length} onClick={() => openPractice(activeUnit)}>
          Take a practice test
        </button>
      </div>
    </section>
  )

  return (
    <div className="ui-page tools" style={current ? { ['--course' as string]: courseTone(current) } : undefined}>
      <header className="ui-page-header">
        <div className="tools__heading">
          <span className="ui-eyebrow">Study</span>
          <h1 className="ui-page-title tools__title">{activeCourse || 'Your binder'}</h1>
          <p className="ui-page-subtitle">
            {current ? `${plural(current.units.length, 'unit')} · ${libraryFailed && !courseNoteCount ? 'notes didn’t load' : plural(courseNoteCount, 'note')}` : 'Pick a course to get started.'}
          </p>
        </div>
        <div className="tools__header-actions">
          {reviewSummary?.due && !reviewAll ? (
            <button className="ui-button ui-button--primary tools__review-all" type="button" onClick={() => { setPractice(null); setReviewAll(true) }}>
              {plural(reviewSummary.due, 'card')} due
            </button>
          ) : null}
          {current ? (
            <button
              className="ui-button tools__practice-entry"
              type="button"
              disabled={!courseNoteCount}
              title={courseNoteCount ? `A timed test from every unit in ${activeCourse}` : 'Add notes to this course first'}
              onClick={() => openPractice(null)}
            >
              Test the whole course
            </button>
          ) : null}
          <button className="ui-button" type="button" onClick={() => openCustomize(activeCourse)}>Manage courses</button>
        </div>
      </header>

      {!data.sandboxed && (!online || offlineCopy?.key === unitKey) ? (
        <p className="ui-alert ui-alert--info tools__offline" role="status">
          <span>
            <strong>You’re offline — showing saved flashcards.</strong>{' '}
            Units you’ve opened before can be studied here. Adding notes, quizzes and the tutor need a connection.
          </span>
        </p>
      ) : null}

      {reviewAll ? (
        <section className="ui-panel tools__review-sheet" aria-labelledby="tools-review-all-title">
          <div className="tools__toolbar tools__review-toolbar">
            <h2 className="tools__unit-title" id="tools-review-all-title">Review · all units</h2>
            <button className="ui-button tools__review-back" type="button" onClick={() => setReviewAll(false)}>
              <ArrowIcon direction="left" />{activeUnit ? `Back to ${activeUnit}` : 'Back to your binder'}
            </button>
          </div>
          <div className={`tools__cards${focusOn ? ' is-focus' : ''}`} style={focusStyle}>
            <ReviewSession scope={{}} accessToken={accessToken} summary={reviewSummary} focusControls={focusControls} toneFor={toneForCourse} />
          </div>
        </section>
      ) : (
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
                        maxLength={COURSE_NAME_MAX}
                        aria-label={`Rename ${course.name}`}
                        autoComplete="off"
                        autoCapitalize="words"
                        enterKeyHint="done"
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
          {practice ? (
            <PracticeTest
              key={practice.key}
              course={practice.course}
              unit={practice.unit}
              openId={practice.openId}
              accessToken={accessToken}
              focusOn={focusOn}
              focusStyle={focusStyle}
              focusControls={focusControls}
              onClose={() => { setPractice(null); setFocusMode(false) }}
              onChanged={() => setUnitTestsRequest((count) => count + 1)}
            />
          ) : (<>
          <div className="ui-tabs tools__unit-tabs" role="tablist" aria-label={`Units in ${activeCourse}`}>
            {units.map((item) =>
              item === renamingUnit ? (
                <form key={item} className="tools__unit-form" onSubmit={commitRename}>
                  <input
                    className="ui-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    maxLength={UNIT_NAME_MAX}
                    aria-label={`Rename ${item}`}
                    autoComplete="off"
                    autoCapitalize="words"
                    enterKeyHint="done"
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
                  maxLength={UNIT_NAME_MAX}
                  autoComplete="off"
                  autoCapitalize="words"
                  enterKeyHint="done"
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
                      onPointerEnter={view.id === 'quiz' ? () => hoverIntent(view.id) : undefined}
                      onPointerLeave={() => window.clearTimeout(intentTimer.current)}
                      onFocus={view.id === 'quiz' ? () => showIntent(view.id) : undefined}
                    >
                      {view.label}
                      {view.id === 'scan' ? <span className="ui-count">{unitNotes.length}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              {panelFn === 'scan' ? (
                <div className="tools__notes" role="tabpanel" aria-label="Notes">
                  <section className="tools__photo" aria-labelledby="tools-photo-title">
                    <input
                      ref={photoInput}
                      className="ui-file-input"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(event) => void onPhotoTaken(event)}
                    />
                    <div className="tools__photo-intro">
                      <h3 className="tools__label" id="tools-photo-title">Snap your notes</h3>
                      <p className="tools__hint">Handwritten or printed. Each photo becomes a note in {activeUnit}, then flashcards.</p>
                    </div>
                    <button
                      className="ui-button tools__photo-button"
                      type="button"
                      onClick={openCamera}
                      disabled={uploadBusy}
                    >
                      <CameraIcon />
                      Take a photo of your notes
                    </button>
                    {photo && photo.course === activeCourse && photo.unit === activeUnit ? (
                      <div className={`tools__photo-job is-${photo.stage}`}>
                        <img src={photo.preview} alt={`Photo: ${photo.name}`} width="56" height="56" decoding="async" />
                        <div className="tools__photo-text">
                          <b>{photo.name}</b>
                          <span>
                            {photo.stage === 'preparing' ? 'Preparing the photo…'
                              : photo.stage === 'uploading' ? 'Uploading…'
                                : photo.stage === 'reading' ? 'Reading your notes…'
                                  : photo.stage === 'added' ? 'Added. Flashcards are on the way.'
                                    : 'Not added yet.'}
                          </span>
                        </div>
                        {photo.stage === 'preparing' || photo.stage === 'uploading' || photo.stage === 'reading' ? <span className="ui-spinner" aria-hidden="true" /> : null}
                        {photo.stage === 'added' ? (
                          <button className="ui-button tools__photo-more" type="button" onClick={openCamera} disabled={uploadBusy}>Add another page</button>
                        ) : null}
                      </div>
                    ) : null}
                    {uploadError?.source === 'photo' ? (
                      <div className="ui-alert" role="alert">
                        <span>{uploadError.message}</span>
                        {uploadError.retry && photo?.stage === 'failed' && photo.course === activeCourse && photo.unit === activeUnit ? (
                          <button className="ui-button ui-button--sm" type="button" onClick={() => void sendPhoto(photo)}>Retry</button>
                        ) : null}
                      </div>
                    ) : null}
                    <p className="sr-only" role="status" aria-live="polite">
                      {photo?.stage === 'uploading' ? `Uploading ${photo.name}.`
                        : photo?.stage === 'reading' ? 'Reading your notes.'
                          : photo?.stage === 'added' ? `${photo.name} added. Making flashcards.`
                            : ''}
                    </p>
                  </section>

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
                                : 'PDF, DOCX, TXT, Markdown, CSV, JSON, or a photo of handwritten notes. Up to 4 MB.'}
                          </span>
                        </button>
                      </div>
                      {duplicateAlert('file')}
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
                        onKeyDown={(event) => {
                          // Ctrl/⌘ + Enter saves, like the button.
                          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault()
                            event.currentTarget.form?.requestSubmit()
                          }
                        }}
                        placeholder="Paste from Google Docs, a class handout, or your own notes"
                        rows={6}
                        readOnly={uploading === 'paste'}
                      />
                      {duplicateAlert('paste')}
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
                    {libraryFailed ? (
                      <div className="ui-alert" role="alert">
                        <span>{library.error}</span>
                        <button className="ui-button ui-button--sm" type="button" onClick={reloadLibrary}>Retry</button>
                      </div>
                    ) : null}
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
                              {noteCardsStatus(note)}
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
                    ) : libraryFailed ? null : libraryLoading ? (
                      <p className="tools__status" role="status"><span className="ui-spinner" />Loading your notes…</p>
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
                <div className={`tools__cards${focusOn ? ' is-focus' : ''}`} style={focusStyle} role="tabpanel" aria-label="Flashcards" onKeyDown={onCardsKey}>
                  {unsavedPaste}
                  {cards.length || cardMode === 'review' ? (
                    <div className="ui-segmented tools__card-modes" role="group" aria-label="Flashcard mode">
                      <button className="ui-segmented__item" type="button" aria-pressed={cardMode === 'browse'} onClick={() => setCardModes((current) => ({ ...current, [unitKey]: 'browse' }))}>Browse</button>
                      <button className="ui-segmented__item" type="button" aria-pressed={cardMode === 'review'} onClick={() => setCardModes((current) => ({ ...current, [unitKey]: 'review' }))}>
                        Review
                        {unitReview?.due ? <span className="ui-count">{unitReview.due}</span> : null}
                      </button>
                    </div>
                  ) : null}
                  {cardMode === 'review' ? (
                    <ReviewSession key={unitKey} scope={{ course: activeCourse, unit: activeUnit }} accessToken={accessToken} summary={reviewSummary} focusControls={focusControls} />
                  ) : null}
                  {cardMode === 'browse' && card ? <div className="tools__focus-bar">{focusControls}</div> : null}
                  {cardMode === 'review' ? null : card ? (
                    <>
                      <button
                        className={`tools__card${cardFlipped ? ' is-flipped' : ''}`}
                        type="button"
                        data-card-key=""
                        onClick={() => setCardFlipped((open) => !open)}
                      >
                        <span className="tools__card-face" key={`${card.id}-${cardFlipped ? 'back' : 'front'}`} aria-live="polite">
                          <span className="tools__card-label">{cardFlipped ? 'Answer' : 'Question'}</span>
                          <span className="tools__card-text"><MathText text={cardFlipped ? card.back : card.front} /></span>
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
                        <button className="ui-button" type="button" data-card-key="" onClick={() => goCard('prev')} disabled={cards.length < 2}>
                          <ArrowIcon direction="left" />Previous
                        </button>
                        <span className="tools__card-count" aria-live="polite">{cardPosition} of {cards.length}</span>
                        <button className="ui-button" type="button" data-card-key="" onClick={() => goCard('next')} disabled={cards.length < 2}>
                          Next<ArrowIcon direction="right" />
                        </button>
                      </div>
                      <p className="tools__keys">
                        <kbd>Space</kbd> flips · <kbd>←</kbd> <kbd>→</kbd> move between cards
                      </p>
                    </>
                  ) : makingNotes.length || libraryLoading ? (
                    <div className="tools__card-loading" aria-busy="true">
                      <div className="tools__card tools__card--skeleton" aria-hidden="true">
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                        <span className="ui-skeleton" />
                      </div>
                      <p className="tools__status" role="status">
                        <span className="ui-spinner" />{makingNotes.length ? 'Making flashcards from your notes…' : 'Loading your flashcards…'}
                      </p>
                    </div>
                  ) : cardsFailed ? (
                    <div className="tools__cards-error">
                      <div className="ui-alert" role="alert">
                        <span>{library.error}</span>
                        <button className="ui-button ui-button--sm" type="button" onClick={reloadLibrary}>Retry</button>
                      </div>
                    </div>
                  ) : unitNotes.length === 0 ? (
                    <div className="ui-empty">
                      <h3 className="ui-empty__title">No notes in {activeUnit} yet</h3>
                      <p className="ui-empty__copy">Flashcards are written from this unit’s notes. Add a file or paste some text first.</p>
                      <button className="ui-button ui-button--primary" type="button" onClick={() => setPanelFn('scan')}>Add notes</button>
                    </div>
                  ) : failedNotes.length || waitingNotes.length ? (
                    <div className="ui-empty">
                      <h3 className="ui-empty__title">No flashcards yet</h3>
                      <p className="ui-empty__copy">
                        {failedNotes.length
                          ? `Flashcards couldn’t be made from ${failedNotes.length === unitNotes.length ? 'your notes' : plural(failedNotes.length, 'note')} in ${activeUnit}.`
                          : `Make flashcards from the notes in ${activeUnit}. They’re saved, so this only happens once.`}
                      </p>
                    </div>
                  ) : (
                    <div className="ui-empty">
                      <h3 className="ui-empty__title">{shortNotes.length === unitNotes.length ? 'Your notes are too short for flashcards' : 'No flashcards in these notes'}</h3>
                      <p className="ui-empty__copy">Flashcards need a few facts or definitions to work from. Add longer notes to {activeUnit}, or paste more text.</p>
                      <button className="ui-button ui-button--primary" type="button" onClick={() => setPanelFn('scan')}>Add notes</button>
                    </div>
                  )}
                  {deckStatus}
                  {unitNotes.length && !libraryLoading ? instructionsField('cards', cardInstructionsKey, cardInstructions, (
                    <button
                      className={`ui-button${remaking ? ' is-busy' : ''}`}
                      type="button"
                      onClick={() => void remakeCards()}
                      disabled={!cardInstructions.trim() || Boolean(remaking) || makingNotes.length > 0}
                    >
                      Make new cards with these instructions
                    </button>
                  )) : null}
                  {remaking ? <p className="tools__status" role="status"><span className="ui-spinner" />Making new cards… {remaking.done} of {remaking.total} notes</p> : null}
                </div>
              ) : null}

              {panelFn === 'quiz' ? (
                <div className={`tools__quiz${focusOn ? ' is-focus' : ''}`} style={focusStyle} role="tabpanel" aria-label="Quiz">
                  {unsavedPaste}
                  <div className="tools__quiz-bar">
                    <p className="tools__quiz-source">
                      {unitNotes.length
                        ? `Questions come from ${plural(unitNotes.length, 'note')} in ${activeUnit}.`
                        : libraryFailed
                          ? <>Couldn’t load your notes for {activeUnit}, so questions are based on the unit name. <button className="tools__inline-button" type="button" onClick={reloadLibrary}>Retry</button></>
                          : libraryLoading
                            ? `Checking ${activeUnit} for notes…`
                            : `No notes in ${activeUnit} yet — questions are based on the unit name. Add notes for questions from your own material.`}
                    </p>
                    <div className="tools__quiz-controls">
                      <select className="ui-select" aria-label="Level" value={quizDifficulty} onChange={(event) => setQuizDifficulty(Number(event.target.value))}>
                        {QUIZ_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                      </select>
                      <button className={`ui-button${loadingQuestion ? ' is-busy' : ''}`} type="button" onClick={() => void loadQuizQuestion()} disabled={quizBusy}>
                        {quizQuestion && !quizResult && !quizDone && !quizError ? 'Skip' : 'New question'}
                      </button>
                      {focusControls}
                    </div>
                  </div>

                  {instructionsField('quiz', quizInstructionsKey, quizInstructions)}

                  {practiceEntry}

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
                        {quizQuestion.repeat ? <p className="tools__repeat-note">You’ve seen this one before.</p> : null}
                        <p className="tools__prompt"><MathText text={quizQuestion.question} /></p>
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
                                  disabled={quizBusy || Boolean(quizResult) || quizDone}
                                  onClick={() => {
                                    setQuizAnswer(choice)
                                    void gradeAnswer(choice)
                                  }}
                                >
                                  <span className="tools__choice-key" aria-hidden="true">
                                    {verdict === 'correct' ? <CheckIcon /> : verdict === 'incorrect' ? <CrossIcon /> : String.fromCharCode(65 + index)}
                                  </span>
                                  <span className="tools__choice-text"><MathText text={choice} /></span>
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
                        enterKeyHint="go"
                        autoCapitalize="off"
                        aria-label="Your answer"
                        autoComplete="off"
                        disabled={quizBusy || !quizQuestion || answered}
                      />
                      <button className={`ui-button ui-button--primary${quizChecking ? ' is-busy' : ''}`} type="submit" disabled={quizBusy || !quizQuestion || !quizAnswer.trim() || answered}>
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
                  {quizDone && !quizResult ? (
                    <div className="tools__result is-correct" role="status">
                      <p className="tools__result-title">
                        <span className="tools__result-icon" aria-hidden="true"><CheckIcon /></span>
                        Already answered
                      </p>
                      <p className="tools__result-body">You’ve already answered this question correctly.</p>
                      <div className="tools__result-foot">
                        <div className="tools__quiz-controls tools__result-actions">
                          <button className="ui-button" type="button" onClick={() => void loadQuizQuestion()} disabled={quizBusy}>
                            Next question<ArrowIcon direction="right" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {quizResult ? (
                    <div className={`tools__result ${quizResult.correct ? 'is-correct' : 'is-incorrect'}`} role="status">
                      <p className="tools__result-title">
                        <span className="tools__result-icon" aria-hidden="true">{quizResult.correct ? <CheckIcon /> : <CrossIcon />}</span>
                        {quizResult.correct ? 'Correct' : 'Not quite'}
                        {quizResult.xp_earned ? <span className="ui-badge ui-badge--accent">+{quizResult.xp_earned} XP</span> : null}
                      </p>
                      <p className="tools__result-body"><MathText text={quizResult.explanation} /></p>
                      {quizResult.hint ? <p className="tools__result-body"><strong>Hint:</strong> <MathText text={quizResult.hint} /></p> : null}
                      <div className="tools__result-foot">
                        <p className="tools__result-meta">
                          {quizResult.total_xp.toLocaleString()} XP total · answer streak {quizResult.streak}
                        </p>
                        <div className="tools__quiz-controls tools__result-actions">
                          {quizResult.correct ? null : <a className="tools__tutor-link" href="#tutor">Ask Otto about this</a>}
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
          </>)}
        </section>
      </div>
      )}

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
                          maxLength={COURSE_NAME_MAX}
                          aria-label={`Rename ${course.name}`}
                          autoComplete="off"
                          autoCapitalize="words"
                          enterKeyHint="done"
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
