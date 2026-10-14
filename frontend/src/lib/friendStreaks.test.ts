import { describe, expect, it } from 'vitest'
import type { Friend, FriendStreakStatus } from './api'
import { canNudge, firstName, rankFriendStreaks, streakDays, streakStatusLine } from './friendStreaks'

function friend(display_name: string, options: { status?: FriendStreakStatus; streak?: number; me?: boolean; them?: boolean } = {}): Friend {
  return {
    student_id: display_name,
    username: display_name.toLowerCase(),
    display_name,
    avatar_path: '',
    total_xp: 0,
    streak: 0,
    active_today: false,
    weekly_xp: 0,
    friend_streak: options.streak ?? 0,
    best_friend_streak: options.streak ?? 0,
    streak_status: options.status ?? 'none',
    me_today: options.me ?? false,
    friend_today: options.them ?? false,
    streak_days: [],
  }
}

describe('firstName and streakDays', () => {
  it('takes the first word of a display name', () => {
    expect(firstName('  Maya   Chen ')).toBe('Maya')
    expect(firstName('Prince')).toBe('Prince')
  })

  it('falls back to the original text when the name is blank', () => {
    expect(firstName('   ')).toBe('   ')
  })

  it('uses singular and plural day counts', () => {
    expect(streakDays(1)).toBe('1 day')
    expect(streakDays(0)).toBe('0 days')
    expect(streakDays(12)).toBe('12 days')
  })
})

describe('streakStatusLine', () => {
  it('celebrates when both studied today', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'done', me: true, them: true, streak: 4 }))).toBe('You both studied today')
  })

  it('tells you it is your turn when a live streak is waiting on you', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'at_risk', them: true, streak: 4 }))).toBe('Maya studied today. Your turn to keep it')
  })

  it('says you are waiting on the friend when you already studied', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'at_risk', me: true, streak: 4 }))).toBe('Waiting on Maya today')
  })

  it('asks you to study when neither has yet', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'at_risk', streak: 4 }))).toBe('Study today to keep it going')
  })

  it('invites starting a streak when the friend studied and there is none', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'none', them: true }))).toBe('Maya studied today. Study too to start a streak')
    expect(streakStatusLine(friend('Maya Chen', { status: 'broken', them: true }))).toBe('Maya studied today. Study too to start a streak')
  })

  it('explains a broken streak', () => {
    expect(streakStatusLine(friend('Maya Chen', { status: 'broken' }))).toBe('Streak ended. Study on the same day to restart')
  })

  it('explains how to start when there has never been a streak', () => {
    expect(streakStatusLine(friend('Maya Chen'))).toBe('Study on the same day to start a streak')
  })
})

describe('rankFriendStreaks', () => {
  it('puts friends waiting on you first, then live streaks longest first, then the rest by name', () => {
    const ranked = rankFriendStreaks([
      friend('Zoe', { streak: 0 }),
      friend('Ben', { streak: 3 }),
      friend('Ava', { streak: 0 }),
      friend('Cara', { streak: 9 }),
      friend('Dev', { streak: 2, them: true }),
      friend('Eli', { streak: 5, them: true, me: true }),
    ])
    expect(ranked.map((item) => item.display_name)).toEqual(['Dev', 'Cara', 'Eli', 'Ben', 'Ava', 'Zoe'])
  })

  it('orders several friends waiting on you by streak length', () => {
    const ranked = rankFriendStreaks([friend('A', { them: true, streak: 1 }), friend('B', { them: true, streak: 6 })])
    expect(ranked.map((item) => item.display_name)).toEqual(['B', 'A'])
  })

  it('does not change the list it was given', () => {
    const list = [friend('Zoe'), friend('Ava')]
    rankFriendStreaks(list)
    expect(list.map((item) => item.display_name)).toEqual(['Zoe', 'Ava'])
  })
})

describe('canNudge', () => {
  it('only offers a reminder before the friend has studied today', () => {
    expect(canNudge(friend('Maya'))).toBe(true)
    expect(canNudge(friend('Maya', { them: true }))).toBe(false)
  })
})
