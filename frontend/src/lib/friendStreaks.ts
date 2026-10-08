import type { Friend } from './api'

/* Words for friend streaks, shared by Home and Friends so both say the same thing. */

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

export function streakDays(count: number) {
  return `${count} ${count === 1 ? 'day' : 'days'}`
}

/* What to do next with this friend's streak, from the viewer's side. */
export function streakStatusLine(friend: Friend) {
  const name = firstName(friend.display_name)
  if (friend.streak_status === 'done') return 'You both studied today'
  if (friend.streak_status === 'at_risk') {
    if (friend.friend_today) return `${name} studied today. Your turn to keep it`
    if (friend.me_today) return `Waiting on ${name} today`
    return 'Study today to keep it going'
  }
  if (friend.friend_today) return `${name} studied today. Study too to start a streak`
  if (friend.streak_status === 'broken') return 'Streak ended. Study on the same day to restart'
  return 'Study on the same day to start a streak'
}

/* Your move first (a friend waiting on you), then live streaks longest first, then the rest by name. */
export function rankFriendStreaks(friends: Friend[]) {
  const urgency = (friend: Friend) => friend.friend_today && !friend.me_today ? 0 : friend.friend_streak > 0 ? 1 : 2
  return friends.toSorted((a, b) =>
    urgency(a) - urgency(b) || b.friend_streak - a.friend_streak || a.display_name.localeCompare(b.display_name))
}

/* A reminder only makes sense while the friend hasn't studied today. */
export function canNudge(friend: Friend) {
  return !friend.friend_today
}
