/*
 * Pure helpers for laying out a group chat: day chips, runs of messages from the same
 * person, quiet time breaks, big emoji, links, list previews and "Seen by" lines.
 * Nothing here touches the network, storage or the DOM, so it is unit tested.
 */

/* Messages from the same person this close together read as one run. */
export const RUN_WINDOW_MS = 3 * 60_000
/* A gap this long inside one day gets a small centered time. */
export const TIME_BREAK_MS = 60 * 60_000

export type ThreadMessage = { id: string; sender_id: string; created_at: string }

export type ThreadItem<M extends ThreadMessage> =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'time'; key: string; at: number }
  | { kind: 'run'; key: string; senderId: string; own: boolean; at: number; messages: M[] }

function startOfDay(value: number) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Days between two moments on this device's calendar (not 24-hour blocks). */
export function calendarDaysBetween(earlier: number, later: number) {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000)
}

/**
 * Splits a sorted message list into day chips, time breaks and runs. A run is
 * consecutive messages from one sender, each within RUN_WINDOW_MS of the one before,
 * on the same day.
 */
export function buildThread<M extends ThreadMessage>(messages: M[], userId: string, timeOf: (message: M) => number): ThreadItem<M>[] {
  const items: ThreadItem<M>[] = []
  let run: Extract<ThreadItem<M>, { kind: 'run' }> | null = null
  let previousAt = Number.NaN
  for (const message of messages) {
    const at = timeOf(message)
    const newDay = !Number.isFinite(previousAt) || calendarDaysBetween(previousAt, at) !== 0
    if (newDay) {
      items.push({ kind: 'day', key: `day-${message.id}`, at })
      run = null
    } else if (at - previousAt >= TIME_BREAK_MS) {
      items.push({ kind: 'time', key: `time-${message.id}`, at })
      run = null
    }
    const joins = run && run.senderId === message.sender_id && at - previousAt < RUN_WINDOW_MS
    if (run && joins) {
      run.messages.push(message)
    } else {
      run = { kind: 'run', key: `run-${message.id}`, senderId: message.sender_id, own: message.sender_id === userId, at, messages: [message] }
      items.push(run)
    }
    previousAt = at
  }
  return items
}

/** "Today", "Yesterday", "Monday" (this week), "Mon, Oct 12", or "Mon, Oct 12, 2025" for another year. */
export function dayLabel(at: number, now = Date.now(), locale?: string) {
  const days = calendarDaysBetween(at, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at)
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(at)
}

/** The time column of the conversation list: a clock time today, "Yesterday", a weekday, then a date. */
export function listTimeLabel(at: number, clock: (at: number) => string, now = Date.now(), locale?: string) {
  const days = calendarDaysBetween(at, now)
  if (days <= 0) return clock(at)
  if (days === 1) return 'Yesterday'
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at)
}

/* One emoji: a pictograph with its modifiers and joined parts, a flag, or a keycap. */
const EMOJI = String.raw`(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*)`
const EMOJI_ONLY = new RegExp(`^(?:\\s*${EMOJI})+\\s*$`, 'u')
const EMOJI_ONE = new RegExp(EMOJI, 'gu')

/** How many emoji a message is made of when it is only emoji (up to 6), otherwise 0. */
export function emojiOnlyCount(text: string | null | undefined) {
  const value = (text ?? '').trim()
  if (!value || value.length > 64 || !EMOJI_ONLY.test(value)) return 0
  const count = value.match(EMOJI_ONE)?.length ?? 0
  return count <= 6 ? count : 0
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

/* http(s) links and bare www. links; trailing punctuation stays outside the link. */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi
const TRAILING = /[.,:;!?)\]}'"]+$/

/** Splits message text into plain text and safe http(s) links. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  let cursor = 0
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0
    let raw = match[0]
    // Keep a closing bracket that belongs to the link, e.g. a Wikipedia URL with "(biology)".
    const trailing = raw.match(TRAILING)?.[0] ?? ''
    let cut = trailing.length
    if (trailing.startsWith(')') && (raw.match(/\(/g)?.length ?? 0) >= (raw.match(/\)/g)?.length ?? 0)) cut = 0
    raw = cut ? raw.slice(0, -cut) : raw
    if (!raw || /^(?:https?:\/\/|www\.)$/i.test(raw)) continue
    const href = /^www\./i.test(raw) ? `https://${raw}` : raw
    let valid = false
    try { valid = ['http:', 'https:'].includes(new URL(href).protocol) } catch { valid = false }
    if (!valid) continue
    if (start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, start) })
    parts.push({ kind: 'link', text: raw, href })
    cursor = start + raw.length
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) })
  return parts
}

/** "You: see you at 4", "Milan: 📷 Photo", or the body alone in a one-person list. */
export function previewLine(message: { sender_id: string; body?: string | null; attachment_path?: string | null }, userId: string, senderName: string) {
  const body = (message.body ?? '').replace(/\s+/g, ' ').trim()
  const text = body || (message.attachment_path ? '📷 Photo' : 'Message')
  const who = message.sender_id === userId ? 'You' : senderName.split(/\s+/)[0] || 'Someone'
  return `${who}: ${text}`
}

/** "Seen by Milan", "Seen by Milan and Ava", "Seen by Milan, Ava and 2 others", or "Seen by everyone". */
export function seenLine(names: string[], otherMembers: number) {
  if (!names.length) return 'Delivered'
  if (otherMembers > 2 && names.length >= otherMembers) return 'Seen by everyone'
  const first = names.map((name) => name.split(/\s+/)[0] || name)
  if (first.length === 1) return `Seen by ${first[0]}`
  if (first.length === 2) return `Seen by ${first[0]} and ${first[1]}`
  const rest = first.length - 2
  return `Seen by ${first[0]}, ${first[1]} and ${rest} other${rest === 1 ? '' : 's'}`
}

/** Case- and accent-insensitive match of a search against a group's name and members. */
export function matchesSearch(query: string, fields: string[]) {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const needle = fold(query.trim())
  if (!needle) return true
  return fields.some((field) => fold(field).includes(needle))
}
