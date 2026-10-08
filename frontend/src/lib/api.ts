import { ACCOUNT_DATA_CLEARED_EVENT, loadAuthSession, refreshAuthSession } from './auth'
import { getStudentId } from './session'

export type Topic = 'addition' | 'subtraction' | 'multiplication' | 'division' | 'mixed'
// choices is optional: when present, the quiz offers them as answer buttons (the demo questions use it).
export type GeneratedQuestion = { question_id: string; question: string; topic: string; difficulty: number; choices?: string[] }
export type NoteQuizContext = {
  course: string
  unit: string
  files: string[]
  other_units: string[]
  other_courses: string[]
}
/* A flashcard saved on the server, written once from one note. */
export type Flashcard = {
  id: string
  note_id: string
  course: string
  unit: string
  front: string
  back: string
  topic: string
  created_at: string
}
export type NoteFlashcardStatus = 'ready' | 'generating' | 'failed' | 'too_short' | 'none'
export type NoteFlashcardState = {
  note_id: string
  file_name: string
  status: NoteFlashcardStatus
  card_count: number
  error: string | null
  updated_at: string | null
}
export type NoteFlashcardsResult = { note_id: string; status: 'ready' | 'too_short'; created: boolean; cards: Flashcard[] }
export type FlashcardLibrary = { cards: Flashcard[]; notes: NoteFlashcardState[] }
export type UploadedNote = {
  id: string
  course: string
  unit: string
  file_name: string
  content_type: string
  size_bytes: number
  status: 'ready'
  text_preview: string
  created_at: string
  pages_skipped?: number
  notice?: string | null
}
export type AnswerResult = {
  correct: boolean
  score: number
  mistake_type: string | null
  misconception: string | null
  explanation: string
  hint: string | null
  grading_source: 'deterministic' | 'ai' | 'fallback'
  xp_earned: number
  total_xp: number
  streak: number
}
export type TopicStat = { topic: string; attempts: number; correct_answers: number; accuracy: number }
export type Progress = {
  student_id: string
  total_xp: number
  attempts: number
  correct_answers: number
  accuracy: number
  streak: number
  best_streak: number
  login_streak: number
  best_login_streak: number
  weak_topics: string[]
  topics: TopicStat[]
  // XP per local day, oldest first. Present on server responses; the demo may omit it.
  recent_xp?: { day: string; xp: number }[]
}
export type Profile = {
  student_id: string
  username: string
  display_name: string
  avatar_path: string
  friend_code: string
  daily_goal: number
  discoverable: boolean
  allow_friend_requests: boolean
  total_xp: number
  streak: number
  best_streak: number
  login_streak: number
  best_login_streak: number
}
/* A row of the weekly league (you and your friends). */
export type LeaguePerson = {
  student_id: string
  username: string
  display_name: string
  avatar_path: string
  total_xp: number
  streak: number
  active_today: boolean
  weekly_xp: number
}
/*
 * Friend streak with one friend: consecutive days you both studied, counted from today (or
 * from yesterday while today isn't shared yet), on your own calendar day.
 * done: you both studied today. at_risk: a live streak today hasn't extended yet.
 * broken: you had shared days, but the streak ended. none: never on the same day.
 */
export type FriendStreakStatus = 'done' | 'at_risk' | 'broken' | 'none'
export type FriendStreakDay = { day: string; me: boolean; friend: boolean }
export type Friend = LeaguePerson & {
  friend_streak: number
  best_friend_streak: number
  streak_status: FriendStreakStatus
  me_today: boolean
  friend_today: boolean
  /* The last 14 days, oldest first, ending today. */
  streak_days: FriendStreakDay[]
}
export type FriendRequest = { request_id: number; username: string; display_name: string; created_at: string }
export type FriendQuest = { id: number; friend_id: string; friend_name: string; target_xp: number; progress_xp: number; status: string; expires_at: string }
export type PersonSuggestion = { student_id: string; username: string; display_name: string; avatar_path: string; friend_code: string }
export type SocialActivity = { id: number; student_id: string; username: string; display_name: string; xp: number; created_at: string; reaction_count: number; reacted: boolean }
export type SocialNotification = { id: number; kind: string; message: string; is_read: boolean; created_at: string }
export type FriendsHub = { friends: Friend[]; requests: FriendRequest[]; leaderboard: LeaguePerson[]; quests: FriendQuest[]; suggestions: PersonSuggestion[]; activity: SocialActivity[]; notifications: SocialNotification[] }
export type StudyGroupMember = { student_id: string; username: string; display_name: string; avatar_path: string; role: 'owner' | 'member'; weekly_xp: number; joined_at: string }
export type StudyGroupActivity = { id: number; student_id: string; display_name: string; xp: number; created_at: string }
export type StudyGroup = {
  id: string
  name: string
  description: string
  invite_code: string
  weekly_goal_xp: number
  weekly_xp: number
  role: 'owner' | 'member'
  created_at: string
  members: StudyGroupMember[]
  activity: StudyGroupActivity[]
}

const API_URL = import.meta.env.VITE_API_URL ?? ''

/* Server timestamps are UTC. Some database drivers omit the zone, so add it before parsing. */
export function parseServerTime(value: string | null | undefined): number {
  if (!value) return NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`)
}
const CACHE_WINDOW_MS = 30_000

/*
 * Fired on window after this tab changes tasks, study groups or the profile, so
 * views that cache them (the sidebar) refresh at once instead of within 30 seconds.
 */
export const TASKS_CHANGED_EVENT = 'bindit:tasks-changed'
export const GROUPS_CHANGED_EVENT = 'bindit:groups-changed'
export const PROFILE_CHANGED_EVENT = 'bindit:profile-changed'

function announce(name: string) {
  window.dispatchEvent(new Event(name))
}

function tokenSubject(accessToken: string) {
  try {
    const encoded = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: string }
    if (payload.sub) return payload.sub
  } catch {
    // Non-JWT development sessions still get isolated in-memory cache keys.
  }
  let hash = 0
  for (let index = 0; index < accessToken.length; index += 1) hash = Math.imul(31, hash) + accessToken.charCodeAt(index) | 0
  return `session-${hash >>> 0}`
}

function readSessionCache<T>(key: string): { savedAt: number; data: T } | null {
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { savedAt: number; data: T } | null
    return cached?.data ? cached : null
  } catch {
    return null
  }
}

function writeSessionCache<T>(key: string, data: T) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }))
  } catch {
    // Storage can be unavailable in private browsing; the in-memory cache still works.
  }
}

async function resolvedToken(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit
  const saved = loadAuthSession()
  const session = saved ? await refreshAuthSession(saved) : null
  return session?.access_token
}

/*
 * AI requests fail fast with a clear message instead of hanging. The budgets sit
 * above the server's own model timeouts, so a slow but working answer still lands.
 */
export const AI_TIMEOUTS = { question: 25_000, grade: 25_000, flashcards: 60_000, upload: 60_000, practiceTest: 75_000, practiceGrade: 45_000 } as const
export const AI_TIMEOUT_MESSAGE = 'This is taking longer than usual. Try again in a moment.'

export class RequestTimeoutError extends Error {
  constructor() {
    super(AI_TIMEOUT_MESSAGE)
    this.name = 'RequestTimeoutError'
  }
}

export const OFFLINE_MESSAGE = 'You’re offline. This needs an internet connection — try again when you’re back online.'

/** The device is offline, so the request was not sent (or could not reach bindet). */
export class OfflineError extends Error {
  constructor() {
    super(OFFLINE_MESSAGE)
    this.name = 'OfflineError'
  }
}

function deviceOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export const RATE_LIMITED_MESSAGE = 'You’re doing that too fast. Try again in a minute.'
export const AI_BREAK_MESSAGE = 'The AI is taking a short break. Try again later.'

// Fixed text for error codes the backend can send (as `code`, `error`, or a bare `detail`).
const API_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: RATE_LIMITED_MESSAGE,
  task_assign_rate_limited: RATE_LIMITED_MESSAGE,
  ai_daily_limit: AI_BREAK_MESSAGE,
  ai_unavailable: AI_BREAK_MESSAGE,
  tutor_busy: 'Finish your other tutor reply first.',
}

/** An error response from the bindet API, with its HTTP status and machine code (when it sent one). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status: number, code = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const CODE_LIKE = /^[a-z][a-z0-9_]*$/

/**
 * Turns an API error body into a friendly ApiError. Known codes get fixed text;
 * a readable `detail` string is kept; a bare 429 says to slow down.
 */
export function apiError(status: number, data: unknown, fallback: string): ApiError {
  const body = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const detail = body.detail
  const nested = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : {}
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : ''
  const code = [body.code, body.error, nested.code, nested.error, detail]
    .map(text)
    .find((value) => CODE_LIKE.test(value)) ?? ''
  const readable = [detail, nested.message, body.message]
    .map(text)
    .find((value) => value && !CODE_LIKE.test(value)) ?? ''
  // An object detail ({ code, message }) carries text written for the student, so it wins
  // over the fixed text for its code. The daily AI limit keeps one consistent message.
  const serverMessage = code === 'ai_daily_limit' ? '' : text(nested.message)
  const message = serverMessage
    || API_ERROR_MESSAGES[code]
    || readable
    || (status === 429 ? RATE_LIMITED_MESSAGE : '')
    || fallback
  return new ApiError(message, status, code)
}

/* True when a request was cancelled on purpose (navigation, a newer request). */
export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

// Identical GET requests already on their way share one network request (pages, the
// sidebar and the app shell often ask for the same profile, tasks or groups at startup).
const inFlight = new Map<string, Promise<unknown>>()

export function request<T>(path: string, options?: RequestInit & { timeoutMs?: number }, accessToken?: string): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' || options?.body) return sendRequest<T>(path, options, accessToken)
  const key = `${accessToken ?? ''}|${path}`
  let shared = inFlight.get(key) as Promise<T> | undefined
  if (!shared) {
    // Not tied to any one caller's cancellation: other callers may still be waiting on it.
    const { signal: _ignored, ...rest } = options ?? {}
    void _ignored
    shared = sendRequest<T>(path, rest, accessToken)
    inFlight.set(key, shared)
    const clear = () => { if (inFlight.get(key) === shared) inFlight.delete(key) }
    shared.then(clear, clear)
  }
  const callerSignal = options?.signal
  // Each caller gets its own copy, so one page changing the result can't affect another.
  const own = shared.then((value) => (typeof structuredClone === 'function' ? structuredClone(value) : value))
  if (!callerSignal) return own
  if (callerSignal.aborted) return Promise.reject(callerSignal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(callerSignal.reason ?? new DOMException('Aborted', 'AbortError'))
    callerSignal.addEventListener('abort', onAbort, { once: true })
    own.then(
      (value) => { callerSignal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { callerSignal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function sendRequest<T>(path: string, options?: RequestInit & { timeoutMs?: number }, accessToken?: string): Promise<T> {
  const { timeoutMs, signal: callerSignal, ...init } = options ?? {}
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const token = await resolvedToken(accessToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  // The student's time zone (minutes, as getTimezoneOffset gives it), so streak days follow their own calendar.
  headers.set('X-TZ-Offset', String(new Date().getTimezoneOffset()))
  callerSignal?.throwIfAborted()
  // Offline: say so at once instead of waiting for the request to fail.
  if (deviceOffline()) throw new OfflineError()
  // One controller carries both the caller's cancellation and the time budget.
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = timeoutMs ? window.setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) : 0
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError()
    if (deviceOffline() && !isAbortError(error)) throw new OfflineError()
    throw error
  } finally {
    window.clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw apiError(response.status, data, `bindet could not complete that request (${response.status}).`)
  }
  return response.json() as Promise<T>
}

async function optimizedImage(file: File): Promise<File> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return file
  try {
    const bitmap = await createImageBitmap(file)
    const largestSide = Math.max(bitmap.width, bitmap.height)
    if (file.size < 1_000_000 && largestSide <= 1800) {
      bitmap.close()
      return file
    }
    const scale = Math.min(1, 1800 / largestSide)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    let blob: Blob | null = null
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
    }
    bitmap.close()
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp', lastModified: file.lastModified })
  } catch {
    return file
  }
}

export type UploadNoteOptions = {
  /* Called once the file has finished sending, while the server is still reading it. */
  onSent?: () => void
}

export async function uploadNote(file: File, course: string, unit: string, accessToken?: string, options?: UploadNoteOptions) {
  const preparedFile = await optimizedImage(file)
  const form = new FormData()
  form.set('file', preparedFile)
  form.set('course', course)
  form.set('unit', unit)
  if (options?.onSent) return sendWithProgress<UploadedNote>('/api/notes', form, AI_TIMEOUTS.upload, options.onSent, accessToken)
  return request<UploadedNote>('/api/notes', { method: 'POST', body: form, timeoutMs: AI_TIMEOUTS.upload }, accessToken)
}

/*
 * A form POST that says when its body has finished uploading (fetch cannot), so a page can
 * switch from "Uploading…" to "Reading your notes…" at the real moment. Errors match request().
 */
async function sendWithProgress<T>(path: string, body: FormData, timeoutMs: number, onSent: () => void, accessToken?: string): Promise<T> {
  if (deviceOffline()) throw new OfflineError()
  const token = await resolvedToken(accessToken)
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let sent = false
    const markSent = () => {
      if (sent) return
      sent = true
      onSent()
    }
    xhr.open('POST', `${API_URL}${path}`)
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('X-TZ-Offset', String(new Date().getTimezoneOffset()))
    xhr.timeout = timeoutMs
    xhr.upload.onload = markSent
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.loaded >= event.total) markSent() }
    xhr.onload = () => {
      markSent()
      let data: unknown = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T)
      else reject(apiError(xhr.status, data, `bindet could not complete that request (${xhr.status}).`))
    }
    xhr.ontimeout = () => reject(new RequestTimeoutError())
    xhr.onerror = () => reject(deviceOffline() ? new OfflineError() : new TypeError('bindet couldn’t be reached. Check your connection and try again.'))
    xhr.send(body)
  })
}

export function deleteNote(noteId: string, accessToken?: string) {
  return request<{ deleted: boolean }>(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }, accessToken)
}

/* Renames a course (no unit) or one of its units on the server, moving the saved notes and flashcards with it. */
export function moveNotes(scope: { course: string; unit?: string; newCourse: string; newUnit?: string }, accessToken?: string) {
  return request<{ moved: number }>('/api/notes/move', {
    method: 'POST',
    body: JSON.stringify({ course: scope.course, unit: scope.unit, new_course: scope.newCourse, new_unit: scope.newUnit }),
  }, accessToken)
}

export function generateQuestion(topic: Topic, difficulty: number, notes?: NoteQuizContext, accessToken?: string, signal?: AbortSignal, instructions?: string) {
  return request<GeneratedQuestion>('/api/generate-question', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      difficulty,
      student_id: getStudentId(),
      notes: notes ?? undefined,
      instructions: instructions?.trim() || undefined,
    }),
    signal,
    timeoutMs: AI_TIMEOUTS.question,
  }, accessToken)
}

export function listNotes(course: string, unit: string, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ course, unit })
  return request<UploadedNote[]>(`/api/notes?${query}`, { signal }, accessToken)
}

/* Writes and saves flashcards for one note, or returns the ones already saved. */
export function generateNoteFlashcards(noteId: string, options?: { retry?: boolean }, accessToken?: string, signal?: AbortSignal) {
  const query = options?.retry ? '?retry=1' : ''
  return request<NoteFlashcardsResult>(`/api/notes/${encodeURIComponent(noteId)}/flashcards${query}`, {
    method: 'POST',
    signal,
    timeoutMs: AI_TIMEOUTS.flashcards,
  }, accessToken)
}

/* Replaces a note's flashcards with new ones made using the student's instructions. Asking again with the same instructions returns the saved cards. */
export function remakeNoteFlashcards(noteId: string, instructions: string, accessToken?: string, signal?: AbortSignal) {
  return request<NoteFlashcardsResult>(`/api/notes/${encodeURIComponent(noteId)}/flashcards/remake`, {
    method: 'POST',
    body: JSON.stringify({ instructions }),
    signal,
    timeoutMs: AI_TIMEOUTS.flashcards,
  }, accessToken)
}

/* A practice test: one question per item. Answers, explanations and topics arrive only once it is submitted. */
export type PracticeItem = {
  position: number
  type: 'multiple_choice' | 'short_answer'
  prompt: string
  choices: string[]
  answer?: string
  explanation?: string
  topic?: string
  student_answer?: string
  correct?: boolean
  grading_source?: 'deterministic' | 'ai'
  feedback?: string
}
export type PracticeTopic = { topic: string; correct: number; total: number; weak: boolean }
export type PracticeTest = {
  id: string
  course: string
  unit: string | null
  status: 'in_progress' | 'submitted'
  created_at: string
  started_at: string
  submitted_at: string | null
  time_limit_s: number | null
  deadline: string | null
  server_now: string
  question_count: number
  score: number | null
  over_time: boolean
  xp_earned: number
  items: PracticeItem[]
  time_used_s?: number | null
  topics?: PracticeTopic[]
  total_xp?: number
}
export type PracticeTestSummary = Pick<PracticeTest, 'id' | 'course' | 'unit' | 'status' | 'created_at' | 'submitted_at' | 'question_count' | 'score' | 'time_limit_s' | 'deadline' | 'over_time'>
export type PracticeTestOptions = {
  course: string
  // null: the whole course.
  unit: string | null
  count: number
  // null: untimed.
  timeLimitMin: number | null
  instructions?: string
  // Ask for new questions instead of retaking the saved test for these notes and settings.
  newQuestions?: boolean
}

/* Writes a practice test from the unit's (or course's) notes, or serves the saved one again. */
export function createPracticeTest(options: PracticeTestOptions, accessToken?: string, signal?: AbortSignal) {
  return request<PracticeTest>('/api/practice-tests', {
    method: 'POST',
    body: JSON.stringify({
      course: options.course,
      unit: options.unit ?? undefined,
      count: options.count,
      time_limit_min: options.timeLimitMin ?? undefined,
      untimed: options.timeLimitMin === null,
      instructions: options.instructions?.trim() || undefined,
      new_questions: Boolean(options.newQuestions),
    }),
    signal,
    timeoutMs: AI_TIMEOUTS.practiceTest,
  }, accessToken)
}

export function getPracticeTest(testId: string, accessToken?: string, signal?: AbortSignal) {
  return request<PracticeTest>(`/api/practice-tests/${encodeURIComponent(testId)}`, { signal }, accessToken)
}

/* Grades the test once. A second submit answers 409 already_submitted. */
export function submitPracticeTest(testId: string, answers: { position: number; answer: string }[], accessToken?: string) {
  return request<PracticeTest>(`/api/practice-tests/${encodeURIComponent(testId)}/submit`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
    timeoutMs: AI_TIMEOUTS.practiceGrade,
  }, accessToken)
}

/* The last 20 tests in a course, or in one unit of it. Never calls the AI. */
export async function listPracticeTests(course: string, unit: string | null, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ course })
  if (unit !== null) query.set('unit', unit)
  const result = await request<{ tests: PracticeTestSummary[] }>(`/api/practice-tests?${query}`, { signal }, accessToken)
  return result.tests
}

/* The saved flashcards for a unit and each note's flashcard state. Never calls the AI. */
export function listFlashcards(scope: { course: string; unit: string }, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ course: scope.course, unit: scope.unit })
  return request<FlashcardLibrary>(`/api/flashcards?${query}`, { signal }, accessToken)
}

/* Spaced-repetition review of saved flashcards. "new": never reviewed; "learning": due again within a day. */
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'
export type ReviewState = 'new' | 'learning' | 'review'
export type CardReview = {
  state: ReviewState
  due_at: string | null
  interval_days: number
  /* The scheduler's state (backend/review.py), so the client can compute previews itself. */
  ease?: number
  reps?: number
  lapses?: number
  /* Interval in days each grade would give this card. */
  preview: Record<ReviewGrade, number>
}
export type ReviewCard = Flashcard & { review: CardReview }
export type ReviewSummary = {
  due: number
  new_available: number
  next_due_at: string | null
  by_unit: { course: string; unit: string; due: number; new: number }[]
}
export type ReviewGradeResult = {
  card_id: string
  review: {
    state: ReviewState
    due_at: string
    interval_days: number
    ease: number
    reps: number
    lapses: number
    last_grade: ReviewGrade
    last_reviewed_at: string
  }
  next_due_at: string
  duplicate: boolean
}

const tzOffset = () => new Date().getTimezoneOffset()

/* Cards due today (the student's own day) and new cards left today, across every unit. */
export function getReviewSummary(accessToken?: string, signal?: AbortSignal) {
  return request<ReviewSummary>(`/api/review/summary?tz_offset=${tzOffset()}`, { signal }, accessToken)
}

/* The next cards to review: one unit, one course, or everything when no scope is given. */
export function getReviewQueue(scope: { course?: string; unit?: string; limit?: number }, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ tz_offset: String(tzOffset()), limit: String(scope.limit ?? 20) })
  if (scope.course) query.set('course', scope.course)
  if (scope.unit) query.set('unit', scope.unit)
  return request<{ cards: ReviewCard[] }>(`/api/review/queue?${query}`, { signal }, accessToken)
}

export function gradeReviewCard(cardId: string, grade: ReviewGrade, accessToken?: string) {
  return request<ReviewGradeResult>(`/api/review/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    body: JSON.stringify({ grade, tz_offset: tzOffset() }),
  }, accessToken)
}

export function analyzeAnswer(question: GeneratedQuestion, studentAnswer: string, studentId: string, accessToken?: string) {
  return request<AnswerResult>('/api/analyze-answer', {
    method: 'POST',
    body: JSON.stringify({ question_id: question.question_id, student_answer: studentAnswer, student_id: studentId }),
    timeoutMs: AI_TIMEOUTS.grade,
  }, accessToken)
}

/*
 * Wakes the API and its connection to the AI provider just before an AI feature is
 * used (focusing the tutor, opening a quiz). Costs no AI quota and carries no data.
 */
let lastWarm = 0
export function warmAI() {
  const now = Date.now()
  if (now - lastWarm < 120_000) return
  lastWarm = now
  void fetch(`${API_URL}/api/ai/warm`, { method: 'POST', keepalive: true }).catch(() => { lastWarm = 0 })
}

const progressCache = new Map<string, { savedAt: number; data: Progress | null }>()
const profileCache = new Map<string, { savedAt: number; data: Profile | null }>()

export function getCachedProgress(studentId: string) {
  return progressCache.get(studentId)?.data ?? readSessionCache<Progress>(`bindit:progress:${studentId}`)?.data ?? null
}

export function getCachedProfile(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return profileCache.get(identity)?.data ?? readSessionCache<Profile>(`bindit:profile:${identity}`)?.data ?? null
}

export async function getProgress(studentId: string, accessToken?: string, force = false): Promise<Progress | null> {
  const cached = progressCache.get(studentId) ?? readSessionCache<Progress>(`bindit:progress:${studentId}`)
  if (!force && cached && Date.now() - cached.savedAt < CACHE_WINDOW_MS) return cached.data
  const headers = new Headers()
  const token = await resolvedToken(accessToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-TZ-Offset', String(new Date().getTimezoneOffset()))
  const response = await fetch(`${API_URL}/api/progress/${encodeURIComponent(studentId)}?tz_offset=${new Date().getTimezoneOffset()}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw apiError(response.status, data, `bindet could not load progress (${response.status}).`)
  }
  const data = await response.json() as Progress
  progressCache.set(studentId, { savedAt: Date.now(), data })
  writeSessionCache(`bindit:progress:${studentId}`, data)
  return data
}

export async function getAccountProfile(accessToken: string, force = false): Promise<Profile | null> {
  const identity = tokenSubject(accessToken)
  const cached = profileCache.get(identity) ?? readSessionCache<Profile>(`bindit:profile:${identity}`)
  if (!force && cached && Date.now() - cached.savedAt < CACHE_WINDOW_MS) return cached.data
  const response = await fetch(`${API_URL}/api/account/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Could not load your bindet profile.')
  const data = await response.json() as Profile
  profileCache.set(identity, { savedAt: Date.now(), data })
  writeSessionCache(`bindit:profile:${identity}`, data)
  return data
}

export function recordDailyLogin(studentId: string, accessToken?: string) {
  return request<Progress>('/api/daily-login', {
    method: 'POST',
    body: JSON.stringify({ student_id: studentId }),
  }, accessToken)
}

export function saveAccountProfile(
  accessToken: string,
  profile: { username: string; display_name: string; guest_id?: string; daily_goal?: number; avatar_path?: string },
) {
  return request<Profile>('/api/account/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  }, accessToken).then((saved) => {
    const identity = tokenSubject(accessToken)
    profileCache.set(identity, { savedAt: Date.now(), data: saved })
    writeSessionCache(`bindit:profile:${identity}`, saved)
    announce(PROFILE_CHANGED_EVENT)
    return saved
  })
}


const socialCache = new Map<string, { savedAt: number; data: FriendsHub }>()
const groupCache = new Map<string, { savedAt: number; data: StudyGroup[] }>()

// Forget every cached account response when this browser's account data is cleared.
window.addEventListener(ACCOUNT_DATA_CLEARED_EVENT, () => {
  progressCache.clear()
  profileCache.clear()
  socialCache.clear()
  groupCache.clear()
})

export function getCachedFriends(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return socialCache.get(identity)?.data ?? readSessionCache<FriendsHub>(`bindit:social:${identity}`)?.data ?? null
}

export function getCachedStudyGroups(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return groupCache.get(identity)?.data ?? readSessionCache<StudyGroup[]>(`bindit:groups:${identity}`)?.data ?? null
}

export async function getFriends(accessToken: string, force = false) {
  const identity = tokenSubject(accessToken)
  const cached = socialCache.get(identity) ?? readSessionCache<FriendsHub>(`bindit:social:${identity}`)
  if (!force && cached && Date.now() - cached.savedAt < CACHE_WINDOW_MS) return cached.data
  const data = await request<FriendsHub>('/api/friends', undefined, accessToken)
  socialCache.set(identity, { savedAt: Date.now(), data })
  writeSessionCache(`bindit:social:${identity}`, data)
  return data
}

export async function getStudyGroups(accessToken: string, force = false) {
  const identity = tokenSubject(accessToken)
  const cached = groupCache.get(identity) ?? readSessionCache<StudyGroup[]>(`bindit:groups:${identity}`)
  if (!force && cached && Date.now() - cached.savedAt < CACHE_WINDOW_MS) return cached.data
  const data = await request<StudyGroup[]>('/api/study-groups', undefined, accessToken)
  groupCache.set(identity, { savedAt: Date.now(), data })
  writeSessionCache(`bindit:groups:${identity}`, data)
  return data
}

/* After a group change the cached list is stale: the next read fetches, and listeners refresh now. */
function groupsChanged<T>(accessToken: string) {
  return (result: T) => {
    const identity = tokenSubject(accessToken)
    const cached = groupCache.get(identity)
    if (cached) groupCache.set(identity, { savedAt: 0, data: cached.data })
    try {
      sessionStorage.removeItem(`bindit:groups:${identity}`)
    } catch {
      // Storage unavailable: nothing cached there.
    }
    announce(GROUPS_CHANGED_EVENT)
    return result
  }
}

export function createStudyGroup(group: { name: string; description: string; weekly_goal_xp: number }, accessToken: string) {
  return request<StudyGroup>('/api/study-groups', { method: 'POST', body: JSON.stringify(group) }, accessToken).then(groupsChanged<StudyGroup>(accessToken))
}

export function joinStudyGroup(inviteCode: string, accessToken: string) {
  return request<StudyGroup>('/api/study-groups/join', { method: 'POST', body: JSON.stringify({ invite_code: inviteCode }) }, accessToken).then(groupsChanged<StudyGroup>(accessToken))
}

/* Leaving as the owner works only when nobody else is left (the group is deleted); otherwise 409 owner_must_transfer. */
export function leaveStudyGroup(groupId: string, accessToken: string) {
  return request<{ left: boolean }>(`/api/study-groups/${encodeURIComponent(groupId)}/members/me`, { method: 'DELETE' }, accessToken).then(groupsChanged<{ left: boolean }>(accessToken))
}

export function sendFriendRequest(friendCode: string, accessToken: string) {
  return request('/api/friends/requests', { method: 'POST', body: JSON.stringify({ friend_code: friendCode }) }, accessToken)
}

export function answerFriendRequest(requestId: number, accept: boolean, accessToken: string) {
  return request(`/api/friends/requests/${requestId}`, { method: 'POST', body: JSON.stringify({ accept }) }, accessToken)
}

export function removeFriend(friendId: string, accessToken: string) {
  return request(`/api/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' }, accessToken)
}

/* An in-app reminder to a friend who hasn't studied today (never email or push). Limited per friend per day. */
export function nudgeFriend(friendId: string, accessToken: string) {
  return request<{ nudged: boolean }>(`/api/friend-streaks/${encodeURIComponent(friendId)}/nudge`, { method: 'POST' }, accessToken)
}

export function startFriendQuest(friendId: string, accessToken: string) {
  return request<FriendQuest>('/api/friend-quests', { method: 'POST', body: JSON.stringify({ friend_id: friendId, target_xp: 100 }) }, accessToken)
}

export function searchFriends(query: string, accessToken: string) {
  return request<PersonSuggestion[]>(`/api/friends/search?q=${encodeURIComponent(query)}`, undefined, accessToken)
}

export function reactToActivity(eventId: number, accessToken: string) {
  return request<{ reacted: boolean }>(`/api/social/activity/${eventId}/reaction`, { method: 'POST' }, accessToken)
}

export function readSocialNotifications(accessToken: string) {
  return request<{ updated: boolean }>('/api/social/notifications/read', { method: 'POST' }, accessToken)
}

export function saveSocialPrivacy(discoverable: boolean, allowFriendRequests: boolean, accessToken: string) {
  return request<{ discoverable: boolean; allow_friend_requests: boolean }>('/api/social/privacy', {
    method: 'PUT', body: JSON.stringify({ discoverable, allow_friend_requests: allowFriendRequests }),
  }, accessToken)
}

export function blockSocialUser(userId: string, accessToken: string) {
  return request<{ blocked: boolean }>(`/api/social/blocks/${encodeURIComponent(userId)}`, { method: 'POST' }, accessToken)
}

export function reportSocialUser(userId: string, accessToken: string) {
  return request<{ submitted: boolean }>('/api/social/reports', {
    method: 'POST', body: JSON.stringify({ user_id: userId, reason: 'inappropriate_behavior', details: '' }),
  }, accessToken)
}

/* ---- Tutor ---------------------------------------------------------------- */

export type StudyMode = 'explain' | 'guide'
export type TutorConversation = { id: string; title: string; course: string; unit: string; created_at: string; updated_at: string; pinned?: boolean; study_mode?: StudyMode }
/* model_tier "small_talk" marks Otto's fixed reply to chit-chat (no AI involved). rating: 1 up, -1 down, 0 none. */
export type TutorMessage = { id: number; role: 'user' | 'assistant'; content: string; attachments: string[]; model_tier: string; created_at: string; rating?: number }
export type TutorStreamHandlers = {
  onUploadProgress?: (fraction: number) => void
  onMeta?: (meta: { conversation: TutorConversation; tier: string; grounded_in: string[] }) => void
  /* The student's message as saved by the server. Arrives just before the first words of the reply. */
  onSaved?: (message: TutorMessage) => void
  /* Text that arrived since the last call. Batched to at most one call per frame. */
  onDelta?: (text: string) => void
  onDone?: (result: { message: TutorMessage; partial?: boolean }) => void
  /* After the reply: Otto named the new conversation. */
  onTitle?: (result: { conversation_id: string; title: string }) => void
  /* After the reply: Otto saved something to its memory (notice is true the first time ever). */
  onMemory?: (result: { saved: number; notice: boolean }) => void
  onError?: (message: string) => void
}

const tutorListCache = new Map<string, TutorConversation[]>()
const tutorMessageCache = new Map<string, TutorMessage[]>()

export function getCachedTutorConversations(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return tutorListCache.get(identity) ?? readSessionCache<TutorConversation[]>(`bindit:tutor:${identity}`)?.data ?? null
}

export function setCachedTutorConversations(accessToken: string, data: TutorConversation[]) {
  const identity = tokenSubject(accessToken)
  tutorListCache.set(identity, data)
  writeSessionCache(`bindit:tutor:${identity}`, data)
}

export async function getTutorConversations(accessToken: string) {
  const data = await request<TutorConversation[]>('/api/tutor/conversations', undefined, accessToken)
  setCachedTutorConversations(accessToken, data)
  return data
}

export function getCachedTutorMessages(accessToken: string, conversationId: string) {
  return tutorMessageCache.get(`${tokenSubject(accessToken)}:${conversationId}`) ?? null
}

export function setCachedTutorMessages(accessToken: string, conversationId: string, data: TutorMessage[]) {
  tutorMessageCache.set(`${tokenSubject(accessToken)}:${conversationId}`, data)
}

export async function getTutorMessages(accessToken: string, conversationId: string, before?: number) {
  const data = await request<TutorMessage[]>(`/api/tutor/conversations/${encodeURIComponent(conversationId)}/messages${before ? `?before=${before}` : ''}`, undefined, accessToken)
  if (!before) setCachedTutorMessages(accessToken, conversationId, data)
  return data
}

export function updateTutorConversation(accessToken: string, conversationId: string, change: { title?: string; pinned?: boolean; study_mode?: StudyMode }) {
  return request<TutorConversation>(`/api/tutor/conversations/${encodeURIComponent(conversationId)}`, { method: 'PATCH', body: JSON.stringify(change) }, accessToken)
}

/* Thumbs up (1), down (-1) or cleared (0) on one of Otto's replies. */
export function rateTutorMessage(accessToken: string, messageId: number, rating: -1 | 0 | 1) {
  return request<{ message_id: number; rating: number }>(`/api/tutor/messages/${messageId}/rating`, { method: 'PUT', body: JSON.stringify({ rating }) }, accessToken)
}

/* Saves one of Otto's replies (once) as a note in a unit; its flashcards then come from generateNoteFlashcards. */
export function saveTutorReplyAsNote(accessToken: string, messageId: number, course: string, unit: string) {
  return request<{ id: string; course: string; unit: string; file_name: string; created: boolean }>(`/api/tutor/messages/${messageId}/note`, {
    method: 'POST', body: JSON.stringify({ course, unit }),
  }, accessToken)
}

/* ---- Otto: how Otto talks to you, and what Otto remembers ---------------- */

export type OttoPersonality = 'friendly' | 'chill' | 'direct' | 'coach' | 'funny'
export type OttoProfile = { preferred_name: string; personality: OttoPersonality; about: string; memory_enabled: boolean; memory_noticed?: boolean }
export type OttoMemoryItem = { id: number; text: string; source: 'otto' | 'student'; created_at: string; updated_at: string }
export type OttoMemory = { enabled: boolean; items: OttoMemoryItem[]; limits: { max_items: number; max_chars: number; item_max_chars: number } }
export const OTTO_PERSONALITIES: { id: OttoPersonality; label: string; hint: string }[] = [
  { id: 'friendly', label: 'Friendly & encouraging', hint: 'Warm and upbeat' },
  { id: 'chill', label: 'Chill & casual', hint: 'Relaxed, everyday words' },
  { id: 'direct', label: 'Straight to the point', hint: 'Answer first, little chat' },
  { id: 'coach', label: 'Coach mode', hint: 'Pushes you to try first' },
  { id: 'funny', label: 'Funny', hint: 'The odd joke or pun' },
]
export const OTTO_ABOUT_MAX = 300
export const OTTO_NAME_MAX = 30
export const OTTO_MEMORY_CHANGED_EVENT = 'bindit:otto-memory-changed'

const ottoProfileCache = new Map<string, OttoProfile>()

export function getCachedOttoProfile(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return ottoProfileCache.get(identity) ?? readSessionCache<OttoProfile>(`bindit:otto:${identity}`)?.data ?? null
}

function cacheOttoProfile(accessToken: string, profile: OttoProfile) {
  const identity = tokenSubject(accessToken)
  ottoProfileCache.set(identity, profile)
  writeSessionCache(`bindit:otto:${identity}`, profile)
}

export async function getOttoProfile(accessToken: string) {
  const profile = await request<OttoProfile>('/api/otto/profile', undefined, accessToken)
  cacheOttoProfile(accessToken, profile)
  return profile
}

export async function saveOttoProfile(accessToken: string, profile: OttoProfile) {
  const { preferred_name, personality, about, memory_enabled } = profile
  const saved = await request<OttoProfile>('/api/otto/profile', { method: 'PUT', body: JSON.stringify({ preferred_name, personality, about, memory_enabled }) }, accessToken)
  cacheOttoProfile(accessToken, saved)
  return saved
}

export function getOttoMemory(accessToken: string, signal?: AbortSignal) {
  return request<OttoMemory>('/api/otto/memory', { signal }, accessToken)
}

export function addOttoMemoryItem(accessToken: string, text: string) {
  return request<OttoMemoryItem>('/api/otto/memory', { method: 'POST', body: JSON.stringify({ text }) }, accessToken)
}

export function editOttoMemoryItem(accessToken: string, id: number, text: string) {
  return request<OttoMemoryItem>(`/api/otto/memory/${id}`, { method: 'PATCH', body: JSON.stringify({ text }) }, accessToken)
}

export function deleteOttoMemoryItem(accessToken: string, id: number) {
  return request<{ deleted: boolean }>(`/api/otto/memory/${id}`, { method: 'DELETE' }, accessToken)
}

export function clearOttoMemory(accessToken: string) {
  return request<{ deleted: number }>('/api/otto/memory', { method: 'DELETE' }, accessToken)
}

export function deleteTutorConversation(accessToken: string, conversationId: string) {
  tutorMessageCache.delete(`${tokenSubject(accessToken)}:${conversationId}`)
  return request<{ deleted: boolean }>(`/api/tutor/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }, accessToken)
}

/* Shrinks large photos before they are attached, then returns a data URL. */
export async function prepareTutorImage(file: File): Promise<{ name: string; dataUrl: string; size: number }> {
  const prepared = await optimizedImage(file)
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That image could not be read.'))
    reader.readAsDataURL(prepared)
  })
  return { name: file.name || 'image', dataUrl, size: prepared.size }
}

/* The longest silence allowed on a tutor stream before it is treated as lost. The
   server gives up on the model after its own idle limit (25 s by default) and says so. */
export const TUTOR_IDLE_TIMEOUT_MS = 45_000

/*
 * Sends a tutor message and streams the reply. XHR is used (not fetch) because it
 * reports real upload progress for attached images and exposes the response as
 * it arrives. Tokens are handed to the page at most once per animation frame, so
 * a fast stream never re-renders the conversation more often than it can paint.
 * Returns a function that stops the reply.
 */
export function streamTutorMessage(
  accessToken: string,
  body: { conversation_id?: string; content: string; course?: string; unit?: string; images?: { name: string; data_url: string }[]; study_mode?: StudyMode; regenerate?: boolean },
  handlers: TutorStreamHandlers,
): () => void {
  const xhr = new XMLHttpRequest()
  let seen = 0
  let finished = false
  let pending = ''
  let frame = 0
  let idleTimer = 0
  let stopped = false

  let fallback = 0
  const flush = () => {
    if (frame) cancelAnimationFrame(frame)
    window.clearTimeout(fallback)
    frame = 0
    if (!pending) return
    const text = pending
    pending = ''
    handlers.onDelta?.(text)
  }
  const fail = (message: string) => {
    if (finished) return
    finished = true
    window.clearTimeout(idleTimer)
    flush()
    handlers.onError?.(message)
  }
  const resetIdle = () => {
    window.clearTimeout(idleTimer)
    if (!finished) idleTimer = window.setTimeout(() => { xhr.abort(); fail('Otto stopped responding. Try again.') }, TUTOR_IDLE_TIMEOUT_MS)
  }
  const handleBlock = (block: string) => {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const raw = /^data: (.+)$/m.exec(block)?.[1]
    if (!name || !raw) return
    // Otto's housekeeping arrives after "done", on the same stream.
    if (name === 'title' || name === 'memory') {
      if (stopped) return
      const extra = JSON.parse(raw)
      if (name === 'title') handlers.onTitle?.(extra)
      else handlers.onMemory?.(extra)
      return
    }
    if (finished) return
    const payload = JSON.parse(raw)
    if (name === 'meta') handlers.onMeta?.(payload)
    else if (name === 'user') handlers.onSaved?.(payload.user_message)
    else if (name === 'delta') {
      pending += payload.text
      if (!frame) {
        frame = requestAnimationFrame(flush)
        // Frames pause in background tabs; text still lands, just less often.
        fallback = window.setTimeout(flush, 120)
      }
    } else if (name === 'done') {
      flush()
      finished = true
      window.clearTimeout(idleTimer)
      handlers.onDone?.(payload)
    } else if (name === 'error') fail(apiError(0, payload, 'Otto couldn’t answer. Try again.').message)
  }
  const drain = () => {
    const text = xhr.responseText
    let boundary = text.indexOf('\n\n', seen)
    while (boundary !== -1) {
      handleBlock(text.slice(seen, boundary))
      seen = boundary + 2
      boundary = text.indexOf('\n\n', seen)
    }
  }
  xhr.open('POST', `${API_URL}/api/tutor/messages`)
  xhr.setRequestHeader('Content-Type', 'application/json')
  xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
  xhr.setRequestHeader('X-TZ-Offset', String(new Date().getTimezoneOffset()))
  xhr.upload.onprogress = (event) => {
    resetIdle()
    if (body.images?.length && event.lengthComputable) handlers.onUploadProgress?.(event.loaded / event.total)
  }
  xhr.onprogress = () => {
    resetIdle()
    if (xhr.status === 200) drain()
  }
  xhr.onload = () => {
    if (xhr.status !== 200) {
      let data: unknown = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      fail(apiError(xhr.status, data, `Otto couldn’t answer (${xhr.status}).`).message)
      return
    }
    drain()
    fail('The reply ended unexpectedly. Try again.')
  }
  xhr.onerror = () => fail('bindet couldn’t be reached. Check your connection and try again.')
  xhr.send(JSON.stringify(body))
  resetIdle()
  return () => {
    finished = true
    stopped = true
    window.clearTimeout(idleTimer)
    if (frame) cancelAnimationFrame(frame)
    window.clearTimeout(fallback)
    xhr.abort()
  }
}

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskPerson = { student_id: string; display_name: string }
export type Task = {
  id: string
  title: string
  description: string
  course: string
  project: string
  status: TaskStatus
  priority: TaskPriority
  due_date: string | null
  due_time: string | null
  kind: 'task' | 'event'
  location: string
  milestone_id: number | null
  sort_order: number
  group_id: string | null
  group_name: string | null
  owner: TaskPerson
  assignees: TaskPerson[]
  checklist_total: number
  checklist_done: number
  comment_count: number
  attachment_count: number
  created_at: string
  updated_at: string
  completed_at: string | null
  can_edit: boolean
  can_delete: boolean
  can_manage: boolean
}
export type TaskChecklistItem = { id: number; text: string; done: boolean }
export type TaskComment = { id: number; author_id: string; author_name: string; body: string; created_at: string; mine: boolean }
export type TaskActivityItem = { id: number; actor_name: string; kind: string; detail: string; created_at: string }
export type TaskAttachment = { id: number; kind: 'link' | 'note'; label: string; url: string; note_id: string; added_by_name: string; mine: boolean; created_at: string }
export type TaskDetail = Task & { checklist: TaskChecklistItem[]; comments: TaskComment[]; activity: TaskActivityItem[]; attachments: TaskAttachment[] }
export type TaskInput = Partial<Pick<Task, 'title' | 'description' | 'course' | 'project' | 'status' | 'priority' | 'due_date' | 'due_time' | 'milestone_id' | 'sort_order' | 'kind' | 'location'>> & {
  group_id?: string | null
  assignee_ids?: string[]
}
export type Milestone = { id: number; title: string; due_date: string | null; total: number; done: number; percent: number }
export type GroupAnalytics = {
  group: { id: string; name: string; description: string; role: 'owner' | 'member' }
  members: { student_id: string; display_name: string; username: string; role: 'owner' | 'member'; assigned: number; completed: number; active: boolean }[]
  completion: { completed: number; unfinished: number; no_response: number }
  pace: 'not_started' | 'done' | 'stalled' | 'on_track' | 'at_risk' | 'behind'
  target_date: string | null
  overview: string[]
  totals: { total: number; done: number; overdue: number; percent: number; by_status: Record<TaskStatus, number> }
  milestones: Milestone[]
  series: { date: string; total: number; done: number }[]
  velocity_per_week: number
  projected_finish: string | null
  activity: { id: number; task_id: string; task_title: string; kind: string; detail: string; actor_name: string; created_at: string }[]
}

const taskCache = new Map<string, { savedAt: number; data: Task[] }>()
const analyticsCache = new Map<string, GroupAnalytics>()

window.addEventListener(ACCOUNT_DATA_CLEARED_EVENT, () => {
  tutorListCache.clear()
  tutorMessageCache.clear()
  ottoProfileCache.clear()
  taskCache.clear()
  analyticsCache.clear()
})

export function getCachedTasks(accessToken: string) {
  const identity = tokenSubject(accessToken)
  return taskCache.get(identity)?.data ?? readSessionCache<Task[]>(`bindit:tasks:${identity}`)?.data ?? null
}

/* Keeps optimistic edits in the cache so returning to the page shows them at once. */
export function setCachedTasks(accessToken: string, data: Task[]) {
  const identity = tokenSubject(accessToken)
  taskCache.set(identity, { savedAt: Date.now(), data })
  writeSessionCache(`bindit:tasks:${identity}`, data)
  announce(TASKS_CHANGED_EVENT)
}

export async function getTasks(accessToken: string, force = false) {
  const identity = tokenSubject(accessToken)
  const cached = taskCache.get(identity) ?? readSessionCache<Task[]>(`bindit:tasks:${identity}`)
  if (!force && cached && Date.now() - cached.savedAt < CACHE_WINDOW_MS) return cached.data
  const data = await request<Task[]>('/api/tasks', undefined, accessToken)
  setCachedTasks(accessToken, data)
  return data
}

export function getTask(taskId: string, accessToken: string) {
  return request<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`, undefined, accessToken)
}

export function createTask(task: TaskInput & { title: string }, accessToken: string) {
  return request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(task) }, accessToken)
}

export function updateTask(taskId: string, changes: TaskInput, accessToken: string) {
  return request<Task>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(changes) }, accessToken)
}

export function deleteTask(taskId: string, accessToken: string) {
  return request<{ deleted: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }, accessToken)
}

export function addTaskChecklistItem(taskId: string, text: string, accessToken: string) {
  return request<TaskChecklistItem>(`/api/tasks/${encodeURIComponent(taskId)}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }, accessToken)
}

export function updateTaskChecklistItem(taskId: string, itemId: number, changes: { text?: string; done?: boolean }, accessToken: string) {
  return request<TaskChecklistItem>(`/api/tasks/${encodeURIComponent(taskId)}/checklist/${itemId}`, { method: 'PATCH', body: JSON.stringify(changes) }, accessToken)
}

export function deleteTaskChecklistItem(taskId: string, itemId: number, accessToken: string) {
  return request<{ deleted: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/checklist/${itemId}`, { method: 'DELETE' }, accessToken)
}

export function addTaskComment(taskId: string, body: string, accessToken: string) {
  return request<TaskComment>(`/api/tasks/${encodeURIComponent(taskId)}/comments`, { method: 'POST', body: JSON.stringify({ body }) }, accessToken)
}

export function addTaskLink(taskId: string, url: string, label: string, accessToken: string) {
  return request<TaskAttachment>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, { method: 'POST', body: JSON.stringify({ kind: 'link', url, label }) }, accessToken)
}

export function deleteTaskAttachment(taskId: string, attachmentId: number, accessToken: string) {
  return request<{ deleted: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${attachmentId}`, { method: 'DELETE' }, accessToken)
}

export function getCachedGroupAnalytics(groupId: string) {
  return analyticsCache.get(groupId) ?? null
}

/* `today` is the student's local date, so "overdue" and the burn-down end on their day, not the server's (UTC). */
export async function getGroupAnalytics(groupId: string, accessToken: string, today = localDay()) {
  const data = await request<GroupAnalytics>(`/api/study-groups/${encodeURIComponent(groupId)}/analytics?today=${encodeURIComponent(today)}`, undefined, accessToken)
  analyticsCache.set(groupId, data)
  return data
}

export function createMilestone(groupId: string, milestone: { title: string; due_date: string | null }, accessToken: string) {
  return request<Milestone>(`/api/study-groups/${encodeURIComponent(groupId)}/milestones`, { method: 'POST', body: JSON.stringify(milestone) }, accessToken)
}

export function deleteMilestone(groupId: string, milestoneId: number, accessToken: string) {
  return request<{ deleted: boolean }>(`/api/study-groups/${encodeURIComponent(groupId)}/milestones/${milestoneId}`, { method: 'DELETE' }, accessToken)
}

export function notifyGroup(groupId: string, message: string, accessToken: string) {
  return request<{ notified: number }>(`/api/study-groups/${encodeURIComponent(groupId)}/notify`, { method: 'POST', body: JSON.stringify({ message }) }, accessToken)
}

/* Every course and unit that holds the student's saved notes, from any device. Never calls the AI. */
export type NoteScope = { course: string; unit: string; note_count: number; last_added: string | null }

export async function listNoteScopes(accessToken?: string, signal?: AbortSignal): Promise<NoteScope[]> {
  const data = await request<{ scopes?: NoteScope[] }>('/api/notes/scopes', { signal }, accessToken)
  return Array.isArray(data?.scopes) ? data.scopes : []
}

/* ---- Group ownership ------------------------------------------------------- */

/* Owner only. The group's tasks become their creators' personal tasks. */
export function deleteStudyGroup(groupId: string, accessToken: string) {
  return request<{ deleted: boolean }>(`/api/study-groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }, accessToken)
    .then(groupsChanged<{ deleted: boolean }>(accessToken))
}

/* Owner only; the new owner must already be a member. Returns the updated group. */
export function transferStudyGroup(groupId: string, newOwnerId: string, accessToken: string) {
  return request<StudyGroup>(`/api/study-groups/${encodeURIComponent(groupId)}/transfer`, { method: 'POST', body: JSON.stringify({ new_owner_id: newOwnerId }) }, accessToken)
    .then(groupsChanged<StudyGroup>(accessToken))
}

/* ---- Account deletion ------------------------------------------------------ */

export const DELETE_ACCOUNT_PHRASE = 'DELETE MY ACCOUNT'

/*
 * Permanently deletes the signed-in account and all of its data. The server wants the
 * exact phrase and a sign-in from the last 10 minutes (ApiError code reauth_required
 * otherwise). auth_delete_failed (502) means the data is gone but the login is not.
 */
export function deleteAccount(confirm: string, accessToken: string) {
  return request<{ deleted: boolean }>('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm }), timeoutMs: 60_000 }, accessToken)
}

/* The student's local calendar day (YYYY-MM-DD), which the server uses for "today" and "overdue". */
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
