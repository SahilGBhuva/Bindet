import { loadAuthSession, refreshAuthSession } from './auth'
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
export type Flashcard = { front: string; back: string; topic: string }
export type FlashcardDeck = {
  course: string
  unit: string
  personalized: boolean
  cards: Flashcard[]
}
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

async function request<T>(path: string, options?: RequestInit, accessToken?: string): Promise<T> {
  const headers = new Headers(options?.headers)
  if (!(options?.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const token = await resolvedToken(accessToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(data?.detail ?? `Bindit could not complete that request (${response.status}).`)
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
  return request<UploadedNote>('/api/notes', { method: 'POST', body: form }, accessToken)
}

export function deleteNote(noteId: string, accessToken?: string) {
  return request<{ deleted: boolean }>(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }, accessToken)
}

export function generateQuestion(topic: Topic, difficulty: number, notes?: NoteQuizContext) {
  return request<GeneratedQuestion>('/api/generate-question', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      difficulty,
      student_id: getStudentId(),
      notes: notes ?? undefined,
    }),
  })
}

export function generateFlashcards(
  context: { course: string; unit: string; files?: string[]; count?: number },
  accessToken?: string,
) {
  return request<FlashcardDeck>('/api/generate-flashcards', {
    method: 'POST',
    body: JSON.stringify({
      student_id: getStudentId(),
      course: context.course,
      unit: context.unit,
      files: context.files ?? [],
      count: context.count ?? 10,
    }),
  }, accessToken)
}

export function analyzeAnswer(question: GeneratedQuestion, studentAnswer: string, studentId: string, accessToken?: string) {
  return request<AnswerResult>('/api/analyze-answer', {
    method: 'POST',
    body: JSON.stringify({ question_id: question.question_id, student_answer: studentAnswer, student_id: studentId }),
  }, accessToken)
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
  const response = await fetch(`${API_URL}/api/progress/${encodeURIComponent(studentId)}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new Error(data?.detail ?? `Bindit could not load progress (${response.status}).`)
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
  if (!response.ok) throw new Error('Could not load your Bindit profile.')
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
  profile: { username: string; display_name: string; guest_id: string; daily_goal?: number; avatar_path?: string },
) {
  return request<Profile>('/api/account/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  }, accessToken)
}

const socialCache = new Map<string, { savedAt: number; data: FriendsHub }>()
const groupCache = new Map<string, { savedAt: number; data: StudyGroup[] }>()

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
