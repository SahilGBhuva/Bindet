import { afterEach, describe, expect, it, vi } from 'vitest'

// Unit tests run in plain Node: give lib/api.ts the window it registers listeners on.
vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') Object.assign(globalThis, { window: new EventTarget() })
})

import { REWARDS_EVENT, emitRewards, type RewardEvents } from './api'
import { badgePercent, freezeLabel, onServerRewards, questCount, questPercent, questTones, recapRange } from './rewards'

describe('the rewards event', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dispatches bindet:rewards with the rewards object as detail', () => {
    const seen: RewardEvents[] = []
    const stop = onServerRewards((detail) => seen.push(detail))
    const rewards: RewardEvents = { xp: 20, quests_completed: [{ id: 'quiz_answers', title: 'Answer 5 quiz questions' }], chest: { xp: 15 } }
    emitRewards(rewards)
    stop()
    emitRewards({ xp: 5 })
    expect(REWARDS_EVENT).toBe('bindet:rewards')
    expect(seen).toEqual([rewards])
  })

  it('dispatches nothing for a missing or empty rewards object', () => {
    const spy = vi.spyOn(window, 'dispatchEvent')
    emitRewards(undefined)
    emitRewards(null)
    emitRewards({})
    emitRewards([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('quest wording and colors', () => {
  it('gives each of the day\'s quests its own hue', () => {
    expect(questTones(['review_cards', 'quiz_answers', 'ask_otto'])).toEqual(['violet', 'green', 'teal'])
    const shared = questTones(['right_in_a_row', 'friend_day', 'daily_goal'])
    expect(new Set(shared).size).toBe(3)
    expect(shared[0]).toBe('pink')
  })

  it('counts progress, with a unit for the daily goal', () => {
    expect(questCount({ progress: 4, target: 10, unit: '' })).toBe('4 / 10')
    expect(questCount({ progress: 26, target: 20, unit: 'XP' })).toBe('20 / 20 XP')
    expect(questPercent({ progress: 4, target: 10, done: false })).toBe(40)
    expect(questPercent({ progress: 0, target: 3, done: true })).toBe(100)
  })

  it('words freezes, badge progress and the recap week', () => {
    expect(freezeLabel(0)).toBe('No streak freezes yet')
    expect(freezeLabel(1)).toBe('1 streak freeze')
    expect(freezeLabel(2)).toBe('2 streak freezes')
    expect(badgePercent(40, 100)).toBe(40)
    expect(badgePercent(null, 100)).toBe(0)
    expect(recapRange('2026-10-05', '2026-10-11')).toBe('Oct 5 – 11')
    expect(recapRange('2026-09-28', '2026-10-04')).toBe('Sep 28 – Oct 4')
  })
})

describe('reward notes', () => {
  it('names each quest, the chest, badges and a saved streak once each', async () => {
    const { rewardNotes } = await import('./rewards')
    const notes = rewardNotes({
      xp: 25,
      quests_completed: [{ id: 'quiz_answers', title: 'Answer 10 questions' }],
      chest: { xp: 15 },
      badges_earned: [{ id: 'first_steps', title: 'First steps', icon: '👣' }],
      streak_saved: true,
      streak_saved_days: 12,
    })
    expect(notes.map((note) => note.key)).toEqual(['quest:quiz_answers', 'chest', 'badge:first_steps', 'streak-saved'])
    expect(notes[1].text).toBe('Chest opened! +15 XP')
    expect(notes[3].text).toBe('A freeze saved your 12-day streak')
  })

  it('has nothing to say about plain XP', async () => {
    const { rewardNotes } = await import('./rewards')
    expect(rewardNotes({ xp: 10 })).toEqual([])
  })
})
