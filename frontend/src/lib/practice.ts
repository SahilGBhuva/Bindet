import { request } from './api'

/*
 * Practice lab: timed rounds on the student's saved flashcards, personal bests and
 * asynchronous challenges with friends. No AI is involved anywhere here.
 */

export type RoundLength = 60 | 120 | 300
export type RoundMode = 'self' | 'choice'
export const ROUND_LENGTHS: { value: RoundLength; label: string }[] = [
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
]
export const CHOICE_MIN_CARDS = 4
export const CHALLENGE_MAX_CARDS = 30
export const STREAK_BONUS_FROM = 5

export type PracticeScope = { course: string; unit: string; card_count: number }
export type PracticeCard = { id: string; unit: string; front: string; back: string }
export type PracticeRound = {
  id: string
  course: string
  unit: string
  length_s: RoundLength
  mode: RoundMode
  score: number
  correct: number
  total: number
  accuracy: number
  best_streak: number
  xp: number
  challenge_id: string | null
  created_at: string
}
export type PracticeBest = { course: string; unit: string; length_s: RoundLength; mode: RoundMode; best_score: number; best_accuracy: number; achieved_at: string }
export type RoundResult = {
  round: PracticeRound
  xp_earned: number
  total_xp: number
  streak: number
  new_best: boolean
  previous_best: PracticeBest | null
  best: PracticeBest | null
}
export type ChallengePerson = { student_id: string; username: string; display_name: string; avatar_path: string }
export type ChallengeStatus = 'pending' | 'completed' | 'expired' | 'declined'
export type Challenge = {
  id: string
  role: 'sent' | 'received'
  opponent: ChallengePerson
  course: string
  unit: string
  length_s: RoundLength
  mode: RoundMode
  card_count: number
  status: ChallengeStatus
  my_score: number | null
  my_correct: number | null
  my_total: number | null
  their_score: number | null
  their_correct: number | null
  their_total: number | null
  my_turn: boolean
  winner: 'me' | 'them' | 'tie' | null
  created_at: string
  expires_at: string
  completed_at: string | null
  cards?: { index: number; front: string; back: string; unit: string }[]
}

/* Score for a run of right/wrong answers: one point each, two from the 5th right answer in a row. Matches the server. */
export function scoreAnswers(results: boolean[]) {
  let score = 0
  let correct = 0
  let streak = 0
  let best = 0
  for (const right of results) {
    if (right) {
      correct += 1
      streak += 1
      best = Math.max(best, streak)
      score += streak >= STREAK_BONUS_FROM ? 2 : 1
    } else {
      streak = 0
    }
  }
  return { score, correct, total: results.length, bestStreak: best }
}

export function lengthLabel(seconds: number) {
  return seconds === 60 ? '1 min' : `${Math.round(seconds / 60)} min`
}

export function modeLabel(mode: RoundMode) {
  return mode === 'choice' ? 'Multiple choice' : 'Self-check'
}

export function scopeLabel(course: string, unit: string) {
  return unit ? `${course} · ${unit}` : `${course} · All units`
}

export function getPracticeScopes(accessToken?: string) {
  return request<{ scopes: PracticeScope[] }>('/api/practice/scopes', undefined, accessToken).then((data) => data.scopes)
}

export function getPracticeCards(course: string, unit: string, accessToken?: string) {
  const query = new URLSearchParams({ course, unit })
  return request<{ cards: PracticeCard[] }>(`/api/practice/cards?${query}`, undefined, accessToken).then((data) => data.cards)
}

export function submitRound(round: { course: string; unit: string; length_s: RoundLength; mode: RoundMode; answers: { card_id: string; correct: boolean }[] }, accessToken?: string) {
  return request<RoundResult>('/api/practice/rounds', { method: 'POST', body: JSON.stringify(round) }, accessToken)
}

export function getBests(accessToken?: string) {
  return request<{ bests: PracticeBest[] }>('/api/practice/bests', undefined, accessToken).then((data) => data.bests)
}

export function getRecentRounds(limit = 5, accessToken?: string) {
  return request<{ rounds: PracticeRound[] }>(`/api/practice/rounds?limit=${limit}`, undefined, accessToken).then((data) => data.rounds)
}

export function getChallenges(accessToken?: string) {
  return request<{ challenges: Challenge[] }>('/api/practice/challenges', undefined, accessToken).then((data) => data.challenges)
}

export function getChallenge(id: string, accessToken?: string) {
  return request<Challenge>(`/api/practice/challenges/${encodeURIComponent(id)}`, undefined, accessToken)
}

export function createChallenge(challenge: { to_id: string; course: string; unit: string; length_s: RoundLength; mode: RoundMode; card_ids: string[]; answers?: boolean[] }, accessToken?: string) {
  return request<Challenge>('/api/practice/challenges', { method: 'POST', body: JSON.stringify(challenge) }, accessToken)
}

export function submitChallengeResult(id: string, answers: boolean[], accessToken?: string) {
  return request<{ challenge: Challenge; xp_earned: number; total_xp: number; streak: number }>(
    `/api/practice/challenges/${encodeURIComponent(id)}/result`, { method: 'POST', body: JSON.stringify({ answers }) }, accessToken)
}

export function declineChallenge(id: string, accessToken?: string) {
  return request<Challenge>(`/api/practice/challenges/${encodeURIComponent(id)}/decline`, { method: 'POST' }, accessToken)
}

/* ---- Feedback ---------------------------------------------------------------- */

export type FeedbackCategory = 'bug' | 'idea' | 'other'
export type FeedbackDevice = { browser: string; os: string; screen: string; viewport: string }
export type FeedbackEntry = {
  id: string
  student_id: string
  username: string
  display_name: string
  category: FeedbackCategory
  message: string
  device: Partial<FeedbackDevice> | null
  page: string
  created_at: string
}

/* Browser and OS names (no version beyond the major one), screen and window size. Nothing else. */
export function describeDevice(): FeedbackDevice {
  const agent = navigator.userAgent
  const pick = (pairs: [RegExp, string][]) => {
    for (const [pattern, name] of pairs) {
      const match = agent.match(pattern)
      if (match) return match[1] ? `${name} ${match[1]}` : name
    }
    return 'Other'
  }
  const browser = pick([
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+).*Safari/, 'Safari'],
  ])
  const os = pick([
    [/iPhone OS (\d+)/, 'iOS'],
    [/iPad.*OS (\d+)/, 'iPadOS'],
    [/Android (\d+)/, 'Android'],
    [/CrOS/, 'ChromeOS'],
    [/Windows NT/, 'Windows'],
    [/Mac OS X/, 'macOS'],
    [/Linux/, 'Linux'],
  ])
  return {
    browser: browser.slice(0, 60),
    os: os.slice(0, 60),
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  }
}

export function sendFeedback(entry: { category: FeedbackCategory; message: string; device?: FeedbackDevice; page?: string }, accessToken?: string) {
  return request<{ id: string; received: boolean }>('/api/feedback', { method: 'POST', body: JSON.stringify(entry) }, accessToken)
}

export function getAdminFeedback(accessToken?: string) {
  return request<{ feedback: FeedbackEntry[] }>('/api/admin/feedback', undefined, accessToken).then((data) => data.feedback)
}
