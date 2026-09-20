import type { AuthSession } from './auth'

export type ChatMessage = {
  id: string
  group_id: string
  sender_id: string
  body: string
  created_at: string
  sender?: {
    username: string
    display_name: string
    avatar_path: string
  }
}

type SupabaseConfig = { supabase_url: string; supabase_anon_key: string }

const API_URL = import.meta.env.VITE_API_URL ?? ''
let configPromise: Promise<SupabaseConfig> | null = null

function getConfig() {
  configPromise ??= fetch(`${API_URL}/api/auth/config`).then(async (response) => {
    if (!response.ok) throw new Error('Chat is not configured yet.')
    return response.json() as Promise<SupabaseConfig>
  })
  return configPromise
}

export async function listGroupMessages(groupId: string, session: AuthSession): Promise<ChatMessage[]> {
  const config = await getConfig()
  const url = new URL(`${config.supabase_url}/rest/v1/study_group_messages`)
  url.searchParams.set('select', 'id,group_id,sender_id,body,created_at,sender:profiles!study_group_messages_sender_id_fkey(username,display_name,avatar_path)')
  url.searchParams.set('group_id', `eq.${groupId}`)
  url.searchParams.set('order', 'created_at.asc')
  url.searchParams.set('limit', '200')
  const response = await fetch(url, {
    headers: {
      apikey: config.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
    },
  })
  if (!response.ok) throw new Error('Could not load this chat.')
  return response.json() as Promise<ChatMessage[]>
}

export async function sendGroupMessage(groupId: string, body: string, session: AuthSession): Promise<ChatMessage> {
  const config = await getConfig()
  const response = await fetch(`${config.supabase_url}/rest/v1/study_group_messages?select=id,group_id,sender_id,body,created_at`, {
    method: 'POST',
    headers: {
      apikey: config.supabase_anon_key,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ group_id: groupId, sender_id: session.user.id, body: body.trim() }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(error?.message ?? 'Could not send that message.')
  }
  const rows = await response.json() as ChatMessage[]
  return rows[0]
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
