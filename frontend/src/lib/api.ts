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
export type Friend = {
  student_id: string
  username: string
  display_name: string
  avatar_path: string
  total_xp: number
  streak: number
  active_today: boolean
  weekly_xp: number
  friend_streak: number
}
export type FriendRequest = { request_id: number; username: string; display_name: string; created_at: string }
export type FriendQuest = { id: number; friend_id: string; friend_name: string; target_xp: number; progress_xp: number; status: string; expires_at: string }
export type PersonSuggestion = { student_id: string; username: string; display_name: string; avatar_path: string; friend_code: string }
export type SocialActivity = { id: number; student_id: string; username: string; display_name: string; xp: number; created_at: string; reaction_count: number; reacted: boolean }
export type SocialNotification = { id: number; kind: string; message: string; is_read: boolean; created_at: string }
export type FriendsHub = { friends: Friend[]; requests: FriendRequest[]; leaderboard: Friend[]; quests: FriendQuest[]; suggestions: PersonSuggestion[]; activity: SocialActivity[]; notifications: SocialNotification[] }
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
export const AI_TIMEOUTS = { question: 25_000, grade: 25_000, flashcards: 60_000, upload: 60_000 } as const
export const AI_TIMEOUT_MESSAGE = 'This is taking longer than usual. Try again in a moment.'

export class RequestTimeoutError extends Error {
  constructor() {
    super(AI_TIMEOUT_MESSAGE)
    this.name = 'RequestTimeoutError'
  }
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

/** An error response from the bindit API, with its HTTP status and machine code (when it sent one). */
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

async function request<T>(path: string, options?: RequestInit & { timeoutMs?: number }, accessToken?: string): Promise<T> {
  const { timeoutMs, signal: callerSignal, ...init } = options ?? {}
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const token = await resolvedToken(accessToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  callerSignal?.throwIfAborted()
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
    throw error
  } finally {
    window.clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw apiError(response.status, data, `bindit could not complete that request (${response.status}).`)
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

export async function uploadNote(file: File, course: string, unit: string, accessToken?: string) {
  const preparedFile = await optimizedImage(file)
  const form = new FormData()
  form.set('file', preparedFile)
  form.set('course', course)
  form.set('unit', unit)
  return request<UploadedNote>('/api/notes', { method: 'POST', body: form, timeoutMs: AI_TIMEOUTS.upload }, accessToken)
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

export function generateQuestion(topic: Topic, difficulty: number, notes?: NoteQuizContext, accessToken?: string, signal?: AbortSignal) {
  return request<GeneratedQuestion>('/api/generate-question', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      difficulty,
      student_id: getStudentId(),
      notes: notes ?? undefined,
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

/* The saved flashcards for a unit and each note's flashcard state. Never calls the AI. */
export function listFlashcards(scope: { course: string; unit: string }, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ course: scope.course, unit: scope.unit })
  return request<FlashcardLibrary>(`/api/flashcards?${query}`, { signal }, accessToken)
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
  const response = await fetch(`${API_URL}/api/progress/${encodeURIComponent(studentId)}?tz_offset=${new Date().getTimezoneOffset()}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw apiError(response.status, data, `bindit could not load progress (${response.status}).`)
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
  if (!response.ok) throw new Error('Could not load your bindit profile.')
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
  }, accessToken)
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

export function createStudyGroup(group: { name: string; description: string; weekly_goal_xp: number }, accessToken: string) {
  return request<StudyGroup>('/api/study-groups', { method: 'POST', body: JSON.stringify(group) }, accessToken)
}

export function joinStudyGroup(inviteCode: string, accessToken: string) {
  return request<StudyGroup>('/api/study-groups/join', { method: 'POST', body: JSON.stringify({ invite_code: inviteCode }) }, accessToken)
}

export function leaveStudyGroup(groupId: string, accessToken: string) {
  return request<{ left: boolean }>(`/api/study-groups/${encodeURIComponent(groupId)}/members/me`, { method: 'DELETE' }, accessToken)
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

export type TutorConversation = { id: string; title: string; course: string; unit: string; created_at: string; updated_at: string }
export type TutorMessage = { id: number; role: 'user' | 'assistant'; content: string; attachments: string[]; model_tier: string; created_at: string }
export type TutorStreamHandlers = {
  onUploadProgress?: (fraction: number) => void
  onMeta?: (meta: { conversation: TutorConversation; tier: string; grounded_in: string[] }) => void
  /* The student's message as saved by the server. Arrives just before the first words of the reply. */
  onSaved?: (message: TutorMessage) => void
  /* Text that arrived since the last call. Batched to at most one call per frame. */
  onDelta?: (text: string) => void
  onDone?: (result: { message: TutorMessage; partial?: boolean }) => void
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
  body: { conversation_id?: string; content: string; course?: string; unit?: string; images?: { name: string; data_url: string }[] },
  handlers: TutorStreamHandlers,
): () => void {
  const xhr = new XMLHttpRequest()
  let seen = 0
  let finished = false
  let pending = ''
  let frame = 0
  let idleTimer = 0

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
    if (!finished) idleTimer = window.setTimeout(() => { xhr.abort(); fail('The tutor stopped responding. Try again.') }, TUTOR_IDLE_TIMEOUT_MS)
  }
  const handleBlock = (block: string) => {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const raw = /^data: (.+)$/m.exec(block)?.[1]
    if (!name || !raw || finished) return
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
    } else if (name === 'error') fail(apiError(0, payload, 'The tutor could not answer. Try again.').message)
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
      fail(apiError(xhr.status, data, `The tutor could not answer (${xhr.status}).`).message)
      return
    }
    drain()
    fail('The reply ended unexpectedly. Try again.')
  }
  xhr.onerror = () => fail('bindit couldn’t be reached. Check your connection and try again.')
  xhr.send(JSON.stringify(body))
  resetIdle()
  return () => {
    finished = true
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

export async function getGroupAnalytics(groupId: string, accessToken: string) {
  const data = await request<GroupAnalytics>(`/api/study-groups/${encodeURIComponent(groupId)}/analytics`, undefined, accessToken)
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
