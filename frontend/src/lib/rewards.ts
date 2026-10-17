import { REWARDS_EVENT, type QuestState, type RewardEvents } from './api'
import { TONES, type Tone } from './tones'

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
export function onRewards(listener: (detail: RewardEvents) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<RewardEvents>).detail ?? {})
  window.addEventListener(REWARDS_EVENT, handle)
  return () => window.removeEventListener(REWARDS_EVENT, handle)
}
