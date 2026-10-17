import { parseServerTime, type TutorMessage } from './api'

/* A question this recent with no reply may still be being answered (the page was reloaded
   mid-reply): Otto's page reads the thread again after these pauses before showing
   "Otto didn't answer". */
export const REPLY_GRACE_MS = 60_000
export const REPLY_RECHECKS_MS = [4_000, 12_000]

type ThreadItem = Pick<TutorMessage, 'id' | 'role' | 'created_at' | 'attachments'>

/* True when the thread ends with a question sent less than REPLY_GRACE_MS ago. */
export function awaitingReply(items: readonly ThreadItem[], now: number) {
  const last = items[items.length - 1]
  if (!last || last.role !== 'user' || last.attachments?.length) return false
  const sent = parseServerTime(last.created_at)
  return Boolean(sent) && now - sent < REPLY_GRACE_MS
}

/* True when the server already has a reply after this saved question, so Retry must not resend it. */
export function replyArrivedAfter(items: readonly ThreadItem[], questionId: number) {
  return Boolean(questionId) && items.some((item) => item.role === 'assistant' && item.id > questionId)
}
