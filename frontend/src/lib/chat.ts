import type { AuthSession } from './auth'

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
  configPromise ??= fetch(`${API_URL}/api/auth/config`).then(async (response) => {
    if (!response.ok) throw new Error('Chat is not configured yet.')
    return response.json() as Promise<SupabaseConfig>
  })
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
    const error = await response.json().catch(() => null) as { message?: string } | null
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

export function uploadGroupImage(
  groupId: string,
  file: File,
  session: AuthSession,
  onProgress: (progress: number) => void,
): Promise<ChatAttachment> {
  return getConfig().then((config) => new Promise((resolve, reject) => {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
    const path = `${groupId}/${session.user.id}/${crypto.randomUUID()}-${safeName}`
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

export async function getGroupImageUrl(path: string, session: AuthSession) {
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

export async function deleteGroupImage(path: string, session: AuthSession) {
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

export async function listGroupTyping(groupId: string, session: AuthSession): Promise<ChatTypingState[]> {
  const config = await getConfig()
  const url = new URL(`${config.supabase_url}/rest/v1/study_group_chat_typing`)
  url.searchParams.set('select', 'group_id,student_id,display_name,typing_until')
  url.searchParams.set('group_id', `eq.${groupId}`)
  url.searchParams.set('typing_until', `gt.${new Date().toISOString()}`)
  const response = await fetch(url, { headers: authHeaders(config, session) })
  if (!response.ok) return []
  return response.json() as Promise<ChatTypingState[]>
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

export async function subscribeToGroupMessages(
  groupId: string,
  session: AuthSession,
  onMessage: (message: ChatMessage) => void,
) {
  const config = await getConfig()
  let closed = false
  let socket: WebSocket | null = null
  let heartbeat: number | null = null
  const topic = `realtime:public:study_group_messages:group_id=eq.${groupId}`

  const open = () => {
    if (closed) return
    const wsUrl = config.supabase_url.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.supabase_anon_key)}&vsn=1.0.0`
    socket = new WebSocket(wsUrl)

    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: '' },
            postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'study_group_messages', filter: `group_id=eq.${groupId}` }],
          },
          access_token: session.access_token,
        },
        ref: '1',
      }))
      heartbeat = window.setInterval(() => {
        socket?.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(Date.now()) }))
      }, 25_000)
    })

    socket.addEventListener('message', (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as {
          event?: string
          payload?: { data?: { record?: ChatMessage } }
        }
        const record = packet.payload?.data?.record
        if (packet.event === 'postgres_changes' && record?.group_id === groupId) onMessage(record)
      } catch {
        // Ignore malformed realtime frames.
      }
    })

    socket.addEventListener('close', () => {
      if (heartbeat) window.clearInterval(heartbeat)
      heartbeat = null
      if (!closed) window.setTimeout(open, 1200)
    })
  }

  open()
  return () => {
    closed = true
    if (heartbeat) window.clearInterval(heartbeat)
    socket?.close()
  }
}

export async function subscribeToAllGroupMessages(
  session: AuthSession,
  onMessage: (message: ChatMessage) => void,
) {
  const config = await getConfig()
  let closed = false
  let socket: WebSocket | null = null
  let heartbeat: number | null = null
  const topic = 'realtime:public:study_group_messages'
  const open = () => {
    if (closed) return
    const wsUrl = config.supabase_url.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.supabase_anon_key)}&vsn=1.0.0`
    socket = new WebSocket(wsUrl)
    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { self: false },
            presence: { key: '' },
            postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'study_group_messages' }],
          },
          access_token: session.access_token,
        },
        ref: '1',
      }))
      heartbeat = window.setInterval(() => socket?.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(Date.now()) })), 25_000)
    })
    socket.addEventListener('message', (event) => {
      try {
        const packet = JSON.parse(String(event.data)) as { event?: string; payload?: { data?: { record?: ChatMessage } } }
        const record = packet.payload?.data?.record
        if (packet.event === 'postgres_changes' && record) onMessage(record)
      } catch {
        // Ignore malformed realtime frames.
      }
    })
    socket.addEventListener('close', () => {
      if (heartbeat) window.clearInterval(heartbeat)
      heartbeat = null
      if (!closed) window.setTimeout(open, 1200)
    })
  }
  open()
  return () => {
    closed = true
    if (heartbeat) window.clearInterval(heartbeat)
    socket?.close()
  }
}
