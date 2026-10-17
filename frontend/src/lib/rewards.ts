import type { QuestState, RewardEvents } from './api'
import { TONES, type Tone } from './tones'

/*
 * In-the-moment reward feedback: the small emitter pages call after a successful action,
 * and the pure rules components/rewards/RewardLayer.tsx uses to show it (XP chips, combo
 * chips, the level-up celebration, sounds). Healthy by design: it only ever celebrates.
 * Nothing here scolds, counts down or asks the student to keep going.
 *
 * Two sources reach the layer:
 *  - 'app': pages call emitRewards() / reportAnswer() with what a response already says
 *    (xp_earned and total_xp), so feedback works with today's server;
 *  - 'server': window events named REWARDS_EVENT (detail: RewardEvents), dispatched once the
 *    server reports rewards itself. The same XP reported both ways within a moment shows once.
 *
 * XP rules stay on the server. Nothing in this file awards or changes XP.
 */

// Same name lib/api.ts dispatches; kept here so this file stays free of api.ts at runtime.
export const REWARDS_EVENT = 'bindet:rewards'

/* Levels: every 100 XP is a level, starting at level 1 (same rule as the Profile page). */
export const XP_PER_LEVEL = 100

export function levelForXp(totalXp: number) {
  return Math.floor(Math.max(0, totalXp) / XP_PER_LEVEL) + 1
}

/* What one response earned, derived from fields the server already returns. */
export function rewardsFromXp(xpEarned: number | null | undefined, totalXp?: number | null): RewardEvents | null {
  const xp = Math.max(0, Math.round(xpEarned ?? 0))
  if (!xp) return null
  const rewards: RewardEvents = { xp }
  if (typeof totalXp === 'number' && Number.isFinite(totalXp)) {
    const from = levelForXp(totalXp - xp)
    const to = levelForXp(totalXp)
    if (to > from) rewards.level_up = { from, to }
  }
  return rewards
}

/* A response that may already carry the server's own rewards (newer servers); otherwise derived. */
export function rewardsFromResponse(response: { xp_earned?: number | null; total_xp?: number | null; rewards?: RewardEvents | null } | null | undefined) {
  if (!response) return null
  if (response.rewards) return response.rewards
  return rewardsFromXp(response.xp_earned, response.total_xp)
}

/* ---------- Emitter ---------- */

/* A point in the viewport the feedback should rise from (CSS pixels). */
export type Anchor = { x: number; y: number }
export type RewardSource = 'app' | 'server'

export type RewardSignal =
  | { kind: 'rewards'; rewards: RewardEvents; source: RewardSource; anchor?: Anchor | null }
  | { kind: 'answer'; correct: boolean; combo: number; anchor?: Anchor | null }
  | { kind: 'goal' }

type Listener = (signal: RewardSignal) => void
const listeners = new Set<Listener>()

/* Subscribes to app signals and to the window's REWARDS_EVENT. Returns the unsubscribe. */
export function onRewards(listener: Listener) {
  listeners.add(listener)
  const fromWindow = (event: Event) => {
    const detail = (event as CustomEvent<RewardEvents | null>).detail
    if (detail && typeof detail === 'object') listener({ kind: 'rewards', rewards: detail, source: 'server' })
  }
  const target = typeof window === 'undefined' ? null : window
  target?.addEventListener(REWARDS_EVENT, fromWindow)
  return () => {
    listeners.delete(listener)
    target?.removeEventListener(REWARDS_EVENT, fromWindow)
  }
}

function send(signal: RewardSignal) {
  for (const listener of [...listeners]) {
    try {
      listener(signal)
    } catch {
      // A broken listener never breaks the action that earned the reward.
    }
  }
}

/* Called by pages after a successful action. A null or empty reward does nothing. */
export function emitRewards(rewards: RewardEvents | null | undefined, options: { anchor?: Anchor | null } = {}) {
  if (!rewards) return
  const hasSomething = Boolean(rewards.xp || rewards.level_up || rewards.chest?.xp)
  if (!hasSomething) return
  send({ kind: 'rewards', rewards, source: 'app', anchor: options.anchor ?? null })
}

/* The daily goal was reached (Home, once a day): a sound and an announcement. */
export function emitGoalReached() {
  send({ kind: 'goal' })
}

/* ---------- Combos ---------- */

/*
 * Consecutive right answers in one session. Visual only: a combo never earns extra XP.
 * A wrong answer quietly sets it back to zero (no message, no sound).
 */
export const COMBO_FROM = 3

export function nextCombo(count: number, correct: boolean) {
  return correct ? count + 1 : 0
}

/* 0: no chip; 1: "3 in a row"; 2: bigger from 5; 3: biggest from 10. */
export function comboTier(count: number): 0 | 1 | 2 | 3 {
  if (count >= 10) return 3
  if (count >= 5) return 2
  if (count >= COMBO_FROM) return 1
  return 0
}

/* Counts where the combo grows: these get the combo sound instead of the plain one. */
export function isComboMilestone(count: number) {
  return count === COMBO_FROM || count === 5 || count === 10 || (count > 10 && count % 5 === 0)
}

export function comboLabel(count: number) {
  return `${count} in a row!`
}

/* One session's combo: create one per quiz session and report every graded answer. */
export function createCombo() {
  let count = 0
  return {
    get count() { return count },
    report(correct: boolean, options: { anchor?: Anchor | null } = {}) {
      count = nextCombo(count, correct)
      send({ kind: 'answer', correct, combo: count, anchor: options.anchor ?? null })
      return count
    },
    reset() { count = 0 },
  }
}
export type Combo = ReturnType<typeof createCombo>

/* ---------- Batching and de-duplication (pure, used by the layer) ---------- */

/* Rewards closer together than this join one chip (+10 then +5 shows +15). */
export const BATCH_MS = 900
/* The same XP from the app and from a server event within this window is one reward. */
export const DEDUPE_MS = 2500

export type Burst = { id: number; at: number; anchor: Anchor | null; xp: number; combo: number }

/* Adds XP and/or a combo to the newest burst when it is recent enough, or starts a new one. */
export function addToBursts(bursts: Burst[], add: { xp?: number; combo?: number; anchor?: Anchor | null }, now: number, nextId: number): Burst[] {
  const xp = Math.max(0, add.xp ?? 0)
  const combo = add.combo ?? 0
  if (!xp && !combo) return bursts
  const last = bursts[bursts.length - 1]
  if (last && now - last.at < BATCH_MS) {
    const merged: Burst = { ...last, at: now, xp: last.xp + xp, combo: Math.max(last.combo, combo) }
    return [...bursts.slice(0, -1), merged]
  }
  return [...bursts, { id: nextId, at: now, anchor: add.anchor ?? null, xp, combo }].slice(-3)
}

export type SeenXp = { xp: number; at: number; source: RewardSource }

/* True when this XP was already shown from the other source a moment ago. */
export function isDuplicateXp(seen: SeenXp[], xp: number, source: RewardSource, now: number) {
  return seen.some((entry) => entry.source !== source && entry.xp === xp && now - entry.at < DEDUPE_MS)
}

/* ---------- Daily goal ---------- */

/* Share of today's goal done, 0 to 100 (whole numbers). */
export function goalPercent(todayXp: number, goal: number) {
  if (!Number.isFinite(todayXp) || todayXp <= 0) return 0
  return Math.min(100, Math.round((todayXp / Math.max(goal, 1)) * 100))
}

type DayStore = Pick<Storage, 'getItem' | 'setItem'>
export const GOAL_BURST_KEY = 'bindit:goal-burst-day'

/*
 * The "Goal done!" burst plays once per day: true the first time it is claimed for `day`.
 * Without storage it returns false (no burst rather than one on every visit).
 */
export function claimGoalBurst(day: string, store: DayStore | null) {
  if (!store) return false
  try {
    if (store.getItem(GOAL_BURST_KEY) === day) return false
    store.setItem(GOAL_BURST_KEY, day)
    return true
  } catch {
    return false
  }
}

export function browserStore(): DayStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/* ---------- Sound effects preference (off by default; this device, cleared on sign-out) ---------- */

export const SOUND_KEY = 'bindit:sound-effects'
export const SOUND_CHANGED_EVENT = 'bindit:sound-effects-changed'

// The choice made in this page, for when storage can't keep it.
let soundThisPage: boolean | null = null

export function loadSoundOn(store: DayStore | null = browserStore()) {
  if (soundThisPage !== null) return soundThisPage
  try {
    return store?.getItem(SOUND_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveSoundOn(on: boolean, store: (DayStore & Pick<Storage, 'removeItem'>) | null = browserStore() as Storage | null) {
  soundThisPage = on
  try {
    if (on) store?.setItem(SOUND_KEY, 'on')
    else store?.removeItem(SOUND_KEY)
  } catch {
    // Not saved; the choice still applies until the page is closed.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SOUND_CHANGED_EVENT))
}

/* ---------- Quests, badges, freezes and the recap (server-owned; this only names and colors) ---------- */
/*
 * Small pure rules for the reward views (Home's quests and recap, the Badges section).
 * The server owns what counts; this file only names, colors and words things.
 */

/* Each quest's own hue, so the three on a card are easy to tell apart. */
export const QUEST_TONE: Record<string, Tone> = {
  review_cards: 'violet',
  quiz_answers: 'green',
  ask_otto: 'teal',
  instant_round: 'orange',
  add_notes: 'amber',
  right_in_a_row: 'pink',
  daily_goal: 'blue',
  friend_day: 'pink',
}

export const QUEST_ICON: Record<string, string> = {
  review_cards: 'cards',
  quiz_answers: 'check',
  ask_otto: 'chat',
  instant_round: 'bolt',
  add_notes: 'note',
  right_in_a_row: 'sparkle',
  daily_goal: 'target',
  friend_day: 'people',
}

/* Tones for today's quests, in order: each quest's own hue, or the next free one when two share it. */
export function questTones(ids: readonly string[]): Tone[] {
  const used = new Set<Tone>()
  return ids.map((id) => {
    const preferred = QUEST_TONE[id] ?? 'blue'
    const tone = used.has(preferred) ? TONES.find((candidate) => !used.has(candidate)) ?? preferred : preferred
    used.add(tone)
    return tone
  })
}

export function questPercent(quest: Pick<QuestState, 'progress' | 'target' | 'done'>) {
  if (quest.done) return 100
  return quest.target > 0 ? Math.min(100, Math.round((quest.progress / quest.target) * 100)) : 0
}

/* "4 / 10", "12 / 20 XP" */
export function questCount(quest: Pick<QuestState, 'progress' | 'target' | 'unit'>) {
  return `${Math.min(quest.progress, quest.target)} / ${quest.target}${quest.unit ? ` ${quest.unit}` : ''}`
}

export function freezeLabel(count: number) {
  if (count <= 0) return 'No streak freezes yet'
  return `${count} streak ${count === 1 ? 'freeze' : 'freezes'}`
}

/* "Oct 5 – 11", or "Sep 29 – Oct 5" across a month. */
export function recapRange(start: string, end: string) {
  const from = new Date(`${start}T00:00:00Z`)
  const to = new Date(`${end}T00:00:00Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Last week'
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
  const sameMonth = from.getUTCMonth() === to.getUTCMonth()
  return `${month.format(from)} ${from.getUTCDate()} – ${sameMonth ? '' : `${month.format(to)} `}${to.getUTCDate()}`
}

/* A badge's progress toward its target, 0-100. */
export function badgePercent(progress: number | null, target: number | null) {
  if (!target || progress === null) return 0
  return Math.min(100, Math.round((progress / target) * 100))
}

/* Call `listener` whenever an API response carried rewards. Returns the unsubscribe function. */
export function onServerRewards(listener: (detail: RewardEvents) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<RewardEvents>).detail ?? {})
  window.addEventListener(REWARDS_EVENT, handle)
  return () => window.removeEventListener(REWARDS_EVENT, handle)
}

/* ---------- Reward notes: the short toasts for quests, chests, badges and saved streaks ---------- */

export type RewardNote = { key: string; tone: Tone; icon: string; text: string }

/* One note per thing the server reported. Keys let the layer show each one once. */
export function rewardNotes(rewards: RewardEvents): RewardNote[] {
  const notes: RewardNote[] = []
  for (const quest of rewards.quests_completed ?? []) {
    notes.push({ key: `quest:${quest.id}`, tone: QUEST_TONE[quest.id] ?? 'green', icon: QUEST_ICON[quest.id] ?? 'check', text: `Quest done: ${quest.title}` })
  }
  if (rewards.chest) {
    notes.push({ key: 'chest', tone: 'amber', icon: 'chestOpen', text: rewards.chest.xp ? `Chest opened! +${rewards.chest.xp} XP` : 'Chest opened!' })
  }
  for (const badge of rewards.badges_earned ?? []) {
    notes.push({ key: `badge:${badge.id}`, tone: 'violet', icon: badge.icon || 'trophy', text: `New badge: ${badge.title}` })
  }
  if (rewards.streak_saved) {
    const days = rewards.streak_saved_days
    notes.push({ key: 'streak-saved', tone: 'blue', icon: 'freeze', text: days ? `A freeze saved your ${days}-day streak` : 'A freeze saved your streak' })
  }
  return notes
}
