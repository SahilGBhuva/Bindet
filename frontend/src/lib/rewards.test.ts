import { describe, expect, it, vi } from 'vitest'
import {
  addToBursts, BATCH_MS, claimGoalBurst, comboLabel, comboTier, createCombo, DEDUPE_MS, emitGoalReached, emitRewards,
  GOAL_BURST_KEY, goalPercent, isComboMilestone, isDuplicateXp, levelForXp, nextCombo, onRewards, rewardsFromResponse,
  rewardsFromXp, type Burst, type RewardSignal,
} from './rewards'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    data,
  }
}

describe('levels and derived rewards', () => {
  it('counts a level per 100 XP, starting at 1', () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(99)).toBe(1)
    expect(levelForXp(100)).toBe(2)
    expect(levelForXp(650)).toBe(7)
    expect(levelForXp(-5)).toBe(1)
  })

  it('derives XP and a level-up from an answer response', () => {
    expect(rewardsFromXp(10, 95)).toEqual({ xp: 10 })
    expect(rewardsFromXp(10, 605)).toEqual({ xp: 10, level_up: { from: 6, to: 7 } })
    expect(rewardsFromXp(10)).toEqual({ xp: 10 })
    expect(rewardsFromXp(0, 600)).toBeNull()
    expect(rewardsFromXp(undefined, 600)).toBeNull()
  })

  it("prefers the server's own rewards when a response carries them", () => {
    const rewards = { xp: 15, level_up: { from: 2, to: 3 } }
    expect(rewardsFromResponse({ xp_earned: 10, total_xp: 300, rewards })).toBe(rewards)
    expect(rewardsFromResponse({ xp_earned: 10, total_xp: 300 })).toEqual({ xp: 10, level_up: { from: 3, to: 4 } })
    expect(rewardsFromResponse(null)).toBeNull()
  })
})

describe('emitter', () => {
  it('delivers app rewards, combos and the goal to listeners until they unsubscribe', () => {
    const seen: RewardSignal[] = []
    const stop = onRewards((signal) => seen.push(signal))
    emitRewards({ xp: 10 })
    emitGoalReached()
    const combo = createCombo()
    combo.report(true)
    stop()
    emitRewards({ xp: 5 })
    expect(seen).toEqual([
      { kind: 'rewards', rewards: { xp: 10 }, source: 'app', anchor: null },
      { kind: 'goal' },
      { kind: 'answer', correct: true, combo: 1, anchor: null },
    ])
  })

  it('ignores empty rewards', () => {
    const listener = vi.fn()
    const stop = onRewards(listener)
    emitRewards(null)
    emitRewards({})
    emitRewards({ xp: 0, quests_completed: [] })
    stop()
    expect(listener).not.toHaveBeenCalled()
  })

  it("passes the window's bindet:rewards events through as server rewards", () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    try {
      const listener = vi.fn()
      const stop = onRewards(listener)
      target.dispatchEvent(new CustomEvent('bindet:rewards', { detail: { xp: 20, streak_saved: true } }))
      target.dispatchEvent(new CustomEvent('bindet:rewards', { detail: null }))
      stop()
      target.dispatchEvent(new CustomEvent('bindet:rewards', { detail: { xp: 5 } }))
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ kind: 'rewards', rewards: { xp: 20, streak_saved: true }, source: 'server' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps going when one listener throws', () => {
    const good = vi.fn()
    const stopBad = onRewards(() => { throw new Error('broken') })
    const stopGood = onRewards(good)
    expect(() => emitRewards({ xp: 10 })).not.toThrow()
    stopBad()
    stopGood()
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('combos', () => {
  it('counts right answers in a row and resets on a wrong one', () => {
    let count = 0
    for (const right of [true, true, true]) count = nextCombo(count, right)
    expect(count).toBe(3)
    expect(nextCombo(count, false)).toBe(0)
    const combo = createCombo()
    expect([true, true, false, true].map((right) => combo.report(right))).toEqual([1, 2, 0, 1])
    combo.reset()
    expect(combo.count).toBe(0)
  })

  it('shows from 3 in a row and grows at 5 and 10', () => {
    expect([0, 2, 3, 4, 5, 9, 10, 25].map(comboTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
    expect([3, 4, 5, 6, 10, 11, 15].map(isComboMilestone)).toEqual([true, false, true, false, true, false, true])
    expect(comboLabel(3)).toBe('3 in a row!')
  })
})

describe('batching and de-duplication', () => {
  it('joins rewards that arrive together into one chip', () => {
    let bursts: Burst[] = []
    bursts = addToBursts(bursts, { xp: 10, anchor: { x: 5, y: 5 } }, 1000, 1)
    bursts = addToBursts(bursts, { combo: 3 }, 1200, 2)
    bursts = addToBursts(bursts, { xp: 5 }, 1300, 3)
    expect(bursts).toEqual([{ id: 1, at: 1300, anchor: { x: 5, y: 5 }, xp: 15, combo: 3 }])
    bursts = addToBursts(bursts, { xp: 10 }, 1300 + BATCH_MS, 4)
    expect(bursts.map((burst) => burst.xp)).toEqual([15, 10])
    expect(addToBursts(bursts, {}, 5000, 5)).toBe(bursts)
  })

  it('keeps at most three chips on screen', () => {
    let bursts: Burst[] = []
    for (let index = 0; index < 5; index += 1) bursts = addToBursts(bursts, { xp: index + 1 }, index * 10_000, index)
    expect(bursts.map((burst) => burst.xp)).toEqual([3, 4, 5])
  })

  it('shows the same XP from the app and the server once', () => {
    const seen = [{ xp: 10, at: 1000, source: 'app' as const }]
    expect(isDuplicateXp(seen, 10, 'server', 1500)).toBe(true)
    expect(isDuplicateXp(seen, 10, 'server', 1000 + DEDUPE_MS)).toBe(false)
    expect(isDuplicateXp(seen, 15, 'server', 1500)).toBe(false)
    // Two answers from the app in a row are two rewards.
    expect(isDuplicateXp(seen, 10, 'app', 1500)).toBe(false)
  })
})

describe('daily goal', () => {
  it('turns today’s XP into a ring percent', () => {
    expect(goalPercent(0, 20)).toBe(0)
    expect(goalPercent(5, 20)).toBe(25)
    expect(goalPercent(13, 30)).toBe(43)
    expect(goalPercent(45, 20)).toBe(100)
    expect(goalPercent(10, 0)).toBe(100)
    expect(goalPercent(Number.NaN, 20)).toBe(0)
  })

  it('plays the goal burst once per day', () => {
    const store = memoryStore()
    expect(claimGoalBurst('2026-10-16', store)).toBe(true)
    expect(claimGoalBurst('2026-10-16', store)).toBe(false)
    expect(store.data.get(GOAL_BURST_KEY)).toBe('2026-10-16')
    expect(claimGoalBurst('2026-10-17', store)).toBe(true)
    expect(claimGoalBurst('2026-10-17', store)).toBe(false)
  })

  it('plays no burst without working storage', () => {
    expect(claimGoalBurst('2026-10-16', null)).toBe(false)
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => undefined }
    expect(claimGoalBurst('2026-10-16', broken)).toBe(false)
  })
})
