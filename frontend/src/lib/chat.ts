import { ACCOUNT_DATA_CLEARED_EVENT, loadAuthSession, subscribeToAuthSession, type AuthSession } from './auth'

export type ChatMessage = {
  id: string
  group_id: string
  sender_id: string
  body: string | null
  created_at: string
  attachment_path?: string | null
  attachment_name?: string | null
  attachment_type?: string | null
  attachment_size?: number | null
  sender?: {
    username: string
    display_name: string
    avatar_path: string
  }
}

export type ChatAttachment = {
  path: string
  name: string
  type: string
  size: number
}

export type ChatReadReceipt = {
  group_id: string
  student_id: string
  last_read_at: string
}

export type ChatTypingState = {
  group_id: string
  student_id: string
  display_name: string
  typing_until: string
}

export type ChatUnread = {
  group_id: string
  unread_count: number
  last_message_at: string | null
}

type SupabaseConfig = { supabase_url: string; supabase_anon_key: string }

const API_URL = import.meta.env.VITE_API_URL ?? ''
const CHAT_BUCKET = 'study-group-images'
let configPromise: Promise<SupabaseConfig> | null = null
const messageCache = new Map<string, ChatMessage[]>()
window.addEventListener(ACCOUNT_DATA_CLEARED_EVENT, () => messageCache.clear())

function messageCacheKey(groupId: string, session: AuthSession) {
  return `${session.user.id}:${groupId}`
}

export function getCachedGroupMessages(groupId: string, session: AuthSession) {
  return messageCache.get(messageCacheKey(groupId, session)) ?? null
}

function cacheGroupMessages(groupId: string, session: AuthSession, messages: ChatMessage[]) {
  messageCache.set(messageCacheKey(groupId, session), messages)
}

function getConfig() {
  if (!configPromise) {
    const pending: Promise<SupabaseConfig> = fetch(`${API_URL}/api/auth/config`).then(async (response) => {
      if (!response.ok) throw new Error('Chat is not configured yet.')
      return response.json() as Promise<SupabaseConfig>
    })
    configPromise = pending
    // Forget a failed fetch so the next call tries again instead of failing until reload.
    pending.catch(() => {
      if (configPromise === pending) configPromise = null
    })
  }
  return configPromise
}

export async function listGroupMessages(groupId: string, session: AuthSession): Promise<ChatMessage[]> {
  const config = await getConfig()
  const request = (select: string) => {
    const url = new URL(`${config.supabase_url}/rest/v1/study_group_messages`)
    url.searchParams.set('select', select)
    url.searchParams.set('group_id', `eq.${groupId}`)
    url.searchParams.set('order', 'created_at.asc')
    url.searchParams.set('limit', '200')
    return fetch(url, {
      headers: {
        apikey: config.supabase_anon_key,
        Authorization: `Bearer ${session.access_token}`,
      },
    })
  }
  let response = await request('id,group_id,sender_id,body,created_at,attachment_path,attachment_name,attachment_type,attachment_size,sender:profiles!study_group_messages_sender_id_fkey(username,display_name,avatar_path)')
  if (!response.ok && response.status === 400) {
    response = await request('id,group_id,sender_id,body,created_at,sender:profiles!study_group_messages_sender_id_fkey(username,display_name,avatar_path)')
  }
  if (!response.ok) throw new Error('Could not load this chat.')
  const messages = await response.json() as ChatMessage[]
  cacheGroupMessages(groupId, session, messages)
  return messages
}

export const CHAT_RATE_LIMITED_MESSAGE = 'You’re sending messages too fast. Wait a moment.'

export async function sendGroupMessage(groupId: string, body: string, session: AuthSession, attachment?: ChatAttachment): Promise<ChatMessage> {
  const config = await getConfig()
  const select = attachment
    ? 'id,group_id,sender_id,body,created_at,attachment_path,attachment_name,attachment_type,attachment_size'
    : 'id,group_id,sender_id,body,created_at'
  const payload: Record<string, string | number | null> = {
    group_id: groupId,
    sender_id: session.user.id,
    body: body.trim() || null,
  }
  if (attachment) {
    payload.attachment_path = attachment.path
    payload.attachment_name = attachment.name
    payload.attachment_type = attachment.type
    payload.attachment_size = attachment.size
  }
  const response = await fetch(`${config.supabase_url}/rest/v1/study_group_messages?select=${select}`, {
    method: 'POST',
    headers: {
      apikey: config.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; details?: string; hint?: string; code?: string } | null
    const text = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ')
    if (response.status === 429 || /chat_rate_limited/i.test(text)) throw new Error(CHAT_RATE_LIMITED_MESSAGE)
    throw new Error(error?.message ?? 'Could not send that message.')
  }
  const rows = await response.json() as ChatMessage[]
  const cached = getCachedGroupMessages(groupId, session) ?? []
  if (rows[0] && !cached.some((message) => message.id === rows[0].id)) cacheGroupMessages(groupId, session, [...cached, rows[0]])
  return rows[0]
}

function storagePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/')
}

// Chat images live at <group id>/<sender id>/<file name>. A message row is data
// another member wrote, so its attachment path is checked before anything is
// signed, fetched or deleted with it: it must sit in the sender's own folder of
// that group and the file name must be a single plain segment.
const ATTACHMENT_PATH_PATTERN = /^[^/]+\/[^/]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export type AttachmentOwner = { group_id: string; sender_id: string }

export function isSafeAttachmentPath(path: string | null | undefined, owner: AttachmentOwner): path is string {
  if (!path || !owner.group_id || !owner.sender_id) return false
  if (!path.startsWith(`${owner.group_id}/${owner.sender_id}/`)) return false
  if (!ATTACHMENT_PATH_PATTERN.test(path)) return false
  return path.split('/').every((segment) => segment !== '.' && segment !== '..' && segment !== '')
}

/** A file name part that keeps the stored path inside ATTACHMENT_PATH_PATTERN. */
function safeAttachmentName(name: string) {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 80)
  return cleaned || 'image'
}

export function uploadGroupImage(
  groupId: string,
  file: File,
  session: AuthSession,
  onProgress: (progress: number) => void,
): Promise<ChatAttachment> {
  return getConfig().then((config) => new Promise((resolve, reject) => {
    const path = `${groupId}/${session.user.id}/${crypto.randomUUID()}-${safeAttachmentName(file.name)}`
    if (!isSafeAttachmentPath(path, { group_id: groupId, sender_id: session.user.id })) {
      reject(new Error('The image could not be uploaded.'))
      return
    }
    const request = new XMLHttpRequest()
    request.open('POST', `${config.supabase_url}/storage/v1/object/${CHAT_BUCKET}/${storagePath(path)}`)
    request.setRequestHeader('apikey', config.supabase_anon_key)
    request.setRequestHeader('Authorization', `Bearer ${session.access_token}`)
    request.setRequestHeader('Content-Type', file.type)
    request.setRequestHeader('x-upsert', 'false')
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    })
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        resolve({ path, name: file.name, type: file.type, size: file.size })
        return
      }
      let message = 'The image could not be uploaded.'
      try {
        const payload = JSON.parse(request.responseText) as { message?: string; error?: string }
        message = payload.message || payload.error || message
      } catch {
        // Keep the friendly fallback for non-JSON storage errors.
      }
      reject(new Error(message))
    })
    request.addEventListener('error', () => reject(new Error('The upload was interrupted. Check your connection and try again.')))
    request.send(file)
  }))
}

export async function getGroupImageUrl(path: string, owner: AttachmentOwner, session: AuthSession) {
  if (!isSafeAttachmentPath(path, owner)) throw new Error('Image unavailable')
  const config = await getConfig()
  const response = await fetch(`${config.supabase_url}/storage/v1/object/sign/${CHAT_BUCKET}/${storagePath(path)}`, {
    method: 'POST',
    headers: {
      apikey: config.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  })
  if (!response.ok) throw new Error('Image unavailable')
  const payload = await response.json() as { signedURL?: string; signedUrl?: string }
  const signedPath = payload.signedURL || payload.signedUrl
  if (!signedPath) throw new Error('Image unavailable')
  return signedPath.startsWith('http') ? signedPath : `${config.supabase_url}/storage/v1${signedPath}`
}

export async function deleteGroupImage(path: string, owner: AttachmentOwner, session: AuthSession) {
  if (!isSafeAttachmentPath(path, owner)) return
  const config = await getConfig()
  await fetch(`${config.supabase_url}/storage/v1/object/${CHAT_BUCKET}/${storagePath(path)}`, {
    method: 'DELETE',
    headers: {
      apikey: config.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
    },
  })
}

function authHeaders(config: SupabaseConfig, session: AuthSession) {
  return { apikey: config.supabase_anon_key, Authorization: `Bearer ${session.access_token}` }
}

export async function listChatUnreads(session: AuthSession): Promise<ChatUnread[]> {
  const config = await getConfig()
  const response = await fetch(`${config.supabase_url}/rest/v1/rpc/get_group_chat_unread_counts`, {
    method: 'POST',
    headers: { ...authHeaders(config, session), 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) return []
  const rows = await response.json() as Array<ChatUnread & { unread_count: number | string }>
  return rows.map((row) => ({ ...row, unread_count: Number(row.unread_count) || 0 }))
}

export async function markGroupRead(groupId: string, session: AuthSession) {
  const config = await getConfig()
  await fetch(`${config.supabase_url}/rest/v1/study_group_chat_reads?on_conflict=group_id,student_id`, {
    method: 'POST',
    headers: {
      ...authHeaders(config, session),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ group_id: groupId, student_id: session.user.id, last_read_at: new Date().toISOString() }),
  })
}

export async function listGroupReadReceipts(groupId: string, session: AuthSession): Promise<ChatReadReceipt[]> {
  const config = await getConfig()
  const url = new URL(`${config.supabase_url}/rest/v1/study_group_chat_reads`)
  url.searchParams.set('select', 'group_id,student_id,last_read_at')
  url.searchParams.set('group_id', `eq.${groupId}`)
  const response = await fetch(url, { headers: authHeaders(config, session) })
  if (!response.ok) return []
  return response.json() as Promise<ChatReadReceipt[]>
}

// Typing signals last 5 seconds. Anything further out than this is not a real
// typing signal (a bad clock or a crafted row), so it is treated as not typing.
const MAX_TYPING_AHEAD_MS = 15_000

export function isTypingNow(state: ChatTypingState, now = Date.now()) {
  const until = new Date(state.typing_until).getTime()
  return Number.isFinite(until) && until > now && until - now <= MAX_TYPING_AHEAD_MS
}

export async function listGroupTyping(groupId: string, session: AuthSession): Promise<ChatTypingState[]> {
  const config = await getConfig()
  const url = new URL(`${config.supabase_url}/rest/v1/study_group_chat_typing`)
  url.searchParams.set('select', 'group_id,student_id,display_name,typing_until')
  url.searchParams.set('group_id', `eq.${groupId}`)
  url.searchParams.set('typing_until', `gt.${new Date().toISOString()}`)
  const response = await fetch(url, { headers: authHeaders(config, session) })
  if (!response.ok) return []
  const rows = await response.json() as ChatTypingState[]
  const now = Date.now()
  return rows.filter((row) => isTypingNow(row, now))
}

export async function setGroupTyping(groupId: string, displayName: string, typing: boolean, session: AuthSession) {
  const config = await getConfig()
  const typingUntil = new Date(Date.now() + (typing ? 5000 : -1000)).toISOString()
  await fetch(`${config.supabase_url}/rest/v1/study_group_chat_typing?on_conflict=group_id,student_id`, {
    method: 'POST',
    headers: {
      ...authHeaders(config, session),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ group_id: groupId, student_id: session.user.id, display_name: displayName, typing_until: typingUntil }),
  })
}

const RECONNECT_MIN_MS = 1200
const RECONNECT_MAX_MS = 30_000

type RealtimeChange = { event: 'INSERT'; schema: 'public'; table: string; filter?: string }

type RealtimePacket = {
  topic?: string
  event?: string
  ref?: string | null
  payload?: {
    status?: string
    message?: string
    data?: { record?: ChatMessage }
  }
}

/**
 * Opens a realtime channel and keeps it open. Reconnects back off from 1.2s
 * up to 30s (reset after a successful join) and always join with the
 * account's current access token. When the token is refreshed, the new one is
 * sent on the open channel; a rejected join, a closed or errored channel, or a
 * token-expiry notice closes the socket and reconnects with the fresh token.
 */
function openRealtimeChannel(
  config: SupabaseConfig,
  session: AuthSession,
  topic: string,
  change: RealtimeChange,
  onRecord: (record: ChatMessage) => void,
) {
  let closed = false
  let socket: WebSocket | null = null
  let heartbeat: number | null = null
  let retryTimer: number | null = null
  let retryDelay = RECONNECT_MIN_MS
  let joined = false
  let sentToken = ''
  let ref = 1

  const nextRef = () => String((ref += 1))

  const currentToken = () => {
    const stored = loadAuthSession()
    return stored && stored.user.id === session.user.id ? stored.access_token : session.access_token
  }

  const reconnect = (current: WebSocket) => {
    if (socket !== current) return
    // The close handler schedules the next attempt with the current backoff.
    current.close()
  }

  const pushToken = () => {
    const current = socket
    if (!current || !joined || current.readyState !== WebSocket.OPEN) return
    const token = currentToken()
    if (!token || token === sentToken) return
    sentToken = token
    current.send(JSON.stringify({ topic, event: 'access_token', payload: { access_token: token }, ref: nextRef() }))
  }

  const open = () => {
    retryTimer = null
    if (closed) return
    const wsUrl = config.supabase_url.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.supabase_anon_key)}&vsn=1.0.0`
    const current = new WebSocket(wsUrl)
    socket = current
    joined = false
    const joinRef = nextRef()

    current.addEventListener('open', () => {
      sentToken = currentToken()
      current.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: '' },
            postgres_changes: [change],
          },
          access_token: sentToken,
        },
        ref: joinRef,
      }))
      heartbeat = window.setInterval(() => {
        current.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() }))
      }, 25_000)
    })

    current.addEventListener('message', (event) => {
      let packet: RealtimePacket
      try {
        packet = JSON.parse(String(event.data)) as RealtimePacket
      } catch {
        return // Ignore malformed realtime frames.
      }
      if (packet.topic !== topic) return
      const status = packet.payload?.status
      if (packet.event === 'phx_reply') {
        if (status !== 'ok') {
          reconnect(current)
          return
        }
        if (packet.ref === joinRef) {
          joined = true
          retryDelay = RECONNECT_MIN_MS
          // The token may have been refreshed while the join was in flight.
          pushToken()
        }
        return
      }
      if (packet.event === 'phx_close' || packet.event === 'phx_error') {
        reconnect(current)
        return
      }
      if (packet.event === 'system' && (status === 'error' || (status !== 'ok' && /token|expired|jwt/i.test(packet.payload?.message ?? '')))) {
        reconnect(current)
        return
      }
      const record = packet.payload?.data?.record
      if (packet.event === 'postgres_changes' && record) onRecord(record)
    })

    current.addEventListener('close', () => {
      if (heartbeat) window.clearInterval(heartbeat)
      heartbeat = null
      joined = false
      if (closed || socket !== current) return
      retryTimer = window.setTimeout(open, retryDelay)
      retryDelay = Math.min(RECONNECT_MAX_MS, retryDelay * 2)
    })
  }

  const unsubscribeAuth = subscribeToAuthSession(pushToken)
  open()
  return () => {
    closed = true
    unsubscribeAuth()
    if (heartbeat) window.clearInterval(heartbeat)
    if (retryTimer) window.clearTimeout(retryTimer)
    socket?.close()
  }
}

export async function subscribeToGroupMessages(
  groupId: string,
  session: AuthSession,
  onMessage: (message: ChatMessage) => void,
) {
  const config = await getConfig()
  return openRealtimeChannel(
    config,
    session,
    `realtime:public:study_group_messages:group_id=eq.${groupId}`,
    { event: 'INSERT', schema: 'public', table: 'study_group_messages', filter: `group_id=eq.${groupId}` },
    (record) => {
      if (record.group_id === groupId) onMessage(record)
    },
  )
}

export async function subscribeToAllGroupMessages(
  session: AuthSession,
  onMessage: (message: ChatMessage) => void,
) {
  const config = await getConfig()
  return openRealtimeChannel(
    config,
    session,
    'realtime:public:study_group_messages',
    { event: 'INSERT', schema: 'public', table: 'study_group_messages' },
    onMessage,
  )
}
