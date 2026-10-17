import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { getCachedStudyGroups, getStudyGroups, parseServerTime, type StudyGroup } from '../lib/api'
import { accountDisplayName } from '../lib/accountName'
import type { AuthSession } from '../lib/auth'
import {
  deleteGroupImage, getCachedGroupMessages, listChatUnreads, listGroupMessages,
  listGroupReadReceipts, listGroupTyping, markGroupRead, sendGroupMessage,
  isTypingNow, setGroupTyping, subscribeToAllGroupMessages, subscribeToGroupMessages, CHAT_LOAD_ERROR, type RealtimeStatus,
  uploadGroupImage, type ChatMessage, type ChatReadReceipt, type ChatTypingState,
} from '../lib/chat'
import { buildThread, dayLabel, emojiOnlyCount, listTimeLabel, matchesSearch, previewLine, seenLine } from '../lib/chatView'
import { formatClockTime } from '../lib/time'
import { toneClass, toneForName } from '../lib/tones'
import { useMediaQuery } from '../lib/useDrawer'
import { useAnnounce } from '../lib/announce'
import { GroupAvatar, ImageLightbox, MessageImage, MessageText, PersonAvatar, type OpenImage } from '../components/chat/ChatParts'
import { rememberLocalPreview } from '../components/chat/chatImageCache'
import { ChatIcon } from '../components/chat/chatIcons'
import './Chat.css'

/*
 * Messages: private study-group conversations.
 * The list and the open room render at once from what is already cached; the
 * network refreshes both behind them. Images are signed and fetched only when
 * they scroll near the screen. A sent message appears immediately, uploads show
 * progress, and anything that fails stays put with Retry and Remove.
 * On narrow screens the list and the room are two screens, like a phone's Messages app.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 4
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const ACTIVE_KEY = 'bindit:chat:active'
const VIEW_KEY = 'bindit:chat:view'
const COMPOSER_MAX_HEIGHT = 150
const STARTERS = ['👋 Hi everyone!', 'When should we study this week?', 'Can someone explain today’s homework?']

type Summary = { unread: number; lastAt: string | null; last?: ChatMessage }
type DraftImage = { id: string; file: File; preview: string; error?: string }
type Pending = {
  key: string
  groupId: string
  body: string
  file?: File
  preview?: string
  createdAt: string
  status: 'sending' | 'failed'
  progress?: number
  uploadedPath?: string
  error?: string
}
/* A row in the open thread: a saved message, or one of ours still on its way. */
type ThreadEntry = { id: string; sender_id: string; created_at: string; message?: ChatMessage; pending?: Pending }

/* In memory only (never written to storage): survives switching pages, not a reload. */
const summaryMemory = new Map<string, Record<string, Summary>>()

function readSession(key: string): string {
  try { return sessionStorage.getItem(key) || '' } catch { return '' }
}

function writeSession(key: string, value: string) {
  try { sessionStorage.setItem(key, value) } catch { /* convenience only */ }
}

function time(iso: string | null | undefined) {
  const value = iso ? parseServerTime(iso) : 0
  return Number.isFinite(value) ? value : 0
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

function formatFileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function validateImage(file: File) {
  if (!ACCEPTED.includes(file.type)) return 'Use JPG, PNG, WebP, or GIF'
  if (file.size > MAX_IMAGE_BYTES) return 'Larger than 10 MB'
  return ''
}

function mergeMessages(base: ChatMessage[], extra: ChatMessage[] = []) {
  const byId = new Map<string, ChatMessage>()
  for (const message of base) byId.set(message.id, message)
  for (const message of extra) if (!byId.has(message.id)) byId.set(message.id, message)
  return Array.from(byId.values()).sort((a, b) => time(a.created_at) - time(b.created_at))
}

function withMessage(list: ChatMessage[] | undefined, message: ChatMessage) {
  if (!list) return [message]
  return list.some((item) => item.id === message.id) ? list : mergeMessages(list, [message])
}

/* The wall clock, for event handlers and timers (never read while rendering). */
function clockNow() {
  return Date.now()
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function Chat({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const userId = session?.user.id ?? ''
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => token ? getCachedStudyGroups(token) : [])
  const [groupsError, setGroupsError] = useState(false)
  const [groupsAttempt, setGroupsAttempt] = useState(0)
  const [preferredId, setPreferredId] = useState(() => readSession(ACTIVE_KEY))
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({})
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({})
  const [threadAttempt, setThreadAttempt] = useState(0)
  const [loadingThread, setLoadingThread] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [summaries, setSummaries] = useState<Record<string, Summary>>(() => summaryMemory.get(userId) ?? {})
  const [receipts, setReceipts] = useState<ChatReadReceipt[]>([])
  const [typingUsers, setTypingUsers] = useState<ChatTypingState[]>([])
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [search, setSearch] = useState('')
  const [lightbox, setLightbox] = useState<OpenImage | null>(null)
  const [revealed, setRevealed] = useState('')
  const [unseen, setUnseen] = useState(0)
  const [away, setAway] = useState(false)
  // Messages newer than this slide in; the history already there when the room opened does not.
  const [openedAt, setOpenedAt] = useState(clockNow)
  // "Today", "Yesterday" and list times follow the clock, re-read once a minute.
  const [now, setNow] = useState(clockNow)
  // Under 1000px the list and the conversation are separate screens.
  const narrow = useMediaQuery('(max-width: 1000px)')
  const [phoneView, setPhoneView] = useState<'list' | 'room'>(() => readSession(VIEW_KEY) === 'room' ? 'room' : 'list')
  const roomVisible = !narrow || phoneView === 'room'
  const [notice, setNotice] = useState('')
  const [toast, setToast] = useState<{ groupId: string; groupName: string; preview: string } | null>(null)

  const scroller = useRef<HTMLDivElement>(null)
  const threadNode = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const roomHeading = useRef<HTMLHeadingElement>(null)
  const listNode = useRef<HTMLUListElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)
  const focusAfter = useRef<'room' | 'list' | null>(null)
  const activeIdRef = useRef('')
  const groupsRef = useRef<StudyGroup[]>([])
  const ownNameRef = useRef('You')
  const typingTimer = useRef<number | null>(null)
  const lastTypingSignal = useRef(0)
  const imagesRef = useRef<DraftImage[]>([])
  const pendingRef = useRef<Pending[]>([])
  const counted = useRef({ id: '', count: 0 })

  const groupList = useMemo(() => groups ?? [], [groups])
  const activeGroup = groupList.find((group) => group.id === preferredId) ?? groupList[0] ?? null
  // The room actually on screen. On a phone's list screen no room is open, so nothing is marked read.
  const activeId = roomVisible ? activeGroup?.id ?? '' : ''
  const ownName = activeGroup?.members.find((member) => member.student_id === userId)?.display_name
    || accountDisplayName(session?.user)
    || 'You'

  // Callbacks from sockets and timers read the latest values through these refs.
  useEffect(() => {
    activeIdRef.current = activeId
    groupsRef.current = groupList
    ownNameRef.current = ownName
    imagesRef.current = images
    pendingRef.current = pending
  })

  useEffect(() => { if (userId) summaryMemory.set(userId, summaries) }, [userId, summaries])

  const selectGroup = useCallback((id: string) => {
    setPreferredId(id)
    setPhoneView('room')
    setOpenedAt(clockNow())
    setRevealed('')
    setSummaries((current) => current[id]?.unread ? { ...current, [id]: { ...current[id], unread: 0 } } : current)
    stickToBottom.current = true
    focusAfter.current = 'room'
    writeSession(ACTIVE_KEY, id)
    writeSession(VIEW_KEY, 'room')
  }, [])

  const showList = useCallback(() => {
    setPhoneView('list')
    focusAfter.current = 'list'
    writeSession(VIEW_KEY, 'list')
  }, [])

  // Moving between the two phone screens puts focus where the reader now is.
  useEffect(() => {
    const target = focusAfter.current
    if (!target || !narrow) return
    focusAfter.current = null
    if (target === 'room' && phoneView === 'room') roomHeading.current?.focus({ preventScroll: true })
    if (target === 'list' && phoneView === 'list') listNode.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(preferredId)}"]`)?.focus()
  }, [phoneView, narrow, preferredId])

  // The group list refreshes behind the cached one already on screen.
  useEffect(() => {
    if (!token) return
    let live = true
    void getStudyGroups(token, groupsAttempt > 0)
      .then((next) => { if (live) { setGroups(next); setGroupsError(false) } })
      .catch(() => { if (live) setGroupsError(true) })
    return () => { live = false }
  }, [token, groupsAttempt])

  // Unread counts and last activity for every group, independent of the open room.
  useEffect(() => {
    if (!session) return
    let live = true
    void listChatUnreads(session).then((rows) => {
      if (!live) return
      setSummaries((current) => {
        const next = { ...current }
        for (const row of rows) {
          const isOpen = row.group_id === activeIdRef.current && document.visibilityState === 'visible'
          next[row.group_id] = { ...next[row.group_id], unread: isOpen ? 0 : row.unread_count, lastAt: row.last_message_at ?? next[row.group_id]?.lastAt ?? null }
        }
        return next
      })
    }).catch(() => undefined)
    return () => { live = false }
  }, [session])

  // Opening a room never blocks: cached messages show first, the latest page replaces them.
  useEffect(() => {
    if (!session || !activeId) return
    let live = true
    const timer = window.setTimeout(() => { if (live) setLoadingThread(activeId) }, 150)
    void listGroupMessages(activeId, session)
      .then((rows) => {
        if (!live) return
        const visible = document.visibilityState === 'visible'
        const last = rows[rows.length - 1]
        setThreads((current) => ({ ...current, [activeId]: mergeMessages(rows, current[activeId]) }))
        setThreadErrors((current) => { if (!current[activeId]) return current; const next = { ...current }; delete next[activeId]; return next })
        setSummaries((current) => ({ ...current, [activeId]: { unread: visible ? 0 : current[activeId]?.unread ?? 0, lastAt: last?.created_at ?? current[activeId]?.lastAt ?? null, last: last ?? current[activeId]?.last } }))
        if (visible) void markGroupRead(activeId, session).catch(() => undefined)
      })
      .catch(() => {
        // Whatever went wrong (network, an error object instead of a list, bad config), the room stays usable.
        if (live) setThreadErrors((current) => ({ ...current, [activeId]: CHAT_LOAD_ERROR }))
      })
      .finally(() => { window.clearTimeout(timer); if (live) setLoadingThread((current) => current === activeId ? null : current) })
    return () => { live = false; window.clearTimeout(timer) }
  }, [session, activeId, threadAttempt])

  // Live messages for the open room. If the realtime channel can't be opened or drops,
  // the room falls back to refreshing the latest page every so often until it is back.
  const [realtime, setRealtime] = useState<{ groupId: string; status: RealtimeStatus } | null>(null)
  useEffect(() => {
    if (!session || !activeId) return
    let stop = () => {}
    let live = true
    const onStatus = (status: RealtimeStatus) => { if (live) setRealtime({ groupId: activeId, status }) }
    void subscribeToGroupMessages(activeId, session, (message) => {
      setThreads((current) => ({ ...current, [activeId]: withMessage(current[activeId] ?? getCachedGroupMessages(activeId, session) ?? [], message) }))
      if (document.visibilityState === 'visible') void markGroupRead(activeId, session).catch(() => undefined)
    }, onStatus).then((unsubscribe) => { if (live) stop = unsubscribe; else unsubscribe() }).catch(() => onStatus('offline'))
    return () => {
      live = false
      stop()
      if (typingTimer.current) window.clearTimeout(typingTimer.current)
      void setGroupTyping(activeId, ownNameRef.current, false, session).catch(() => undefined)
    }
  }, [session, activeId])

  const realtimeOffline = realtime?.groupId === activeId && realtime.status === 'offline'
  useEffect(() => {
    if (!realtimeOffline) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setThreadAttempt((value) => value + 1)
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [realtimeOffline])

  // Read receipts and who is typing, refreshed while the room is open.
  useEffect(() => {
    if (!session || !activeId) return
    let live = true
    const refresh = () => {
      // Not in a background tab: it would drain battery and data and run into rate limits.
      if (document.visibilityState === 'hidden') return
      void Promise.all([listGroupReadReceipts(activeId, session), listGroupTyping(activeId, session)])
        .then(([nextReceipts, nextTyping]) => { if (live) { setReceipts(nextReceipts); setTypingUsers(nextTyping) } })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 1800)
    document.addEventListener('visibilitychange', refresh)
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [session, activeId])

  // Every group: unread counts, list previews, and a nudge when another group gets a message.
  useEffect(() => {
    if (!session) return
    let stop = () => {}
    let live = true
    void subscribeToAllGroupMessages(session, (message) => {
      const own = message.sender_id === session.user.id
      const isOpen = message.group_id === activeIdRef.current && document.visibilityState === 'visible'
      setSummaries((current) => {
        const previous = current[message.group_id]
        return { ...current, [message.group_id]: { unread: (previous?.unread ?? 0) + (own || isOpen ? 0 : 1), lastAt: message.created_at, last: message } }
      })
      setThreads((current) => current[message.group_id] ? { ...current, [message.group_id]: withMessage(current[message.group_id], message) } : current)
      // The nudge is for someone in a room; on the phone list screen the list itself shows the new message.
      if (own || isOpen || !activeIdRef.current) return
      const group = groupsRef.current.find((item) => item.id === message.group_id)
      if (!group) return
      const sender = group.members.find((member) => member.student_id === message.sender_id)?.display_name || 'Someone'
      setToast({ groupId: group.id, groupName: group.name, preview: message.body ? `${sender}: ${message.body}` : `${sender} shared an image` })
    }).then((unsubscribe) => { if (live) stop = unsubscribe; else unsubscribe() }).catch(() => undefined)
    return () => { live = false; stop() }
  }, [session])

  useEffect(() => {
    if (!session || !activeId) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setSummaries((current) => current[activeId]?.unread ? { ...current, [activeId]: { ...current[activeId], unread: 0 } } : current)
      void markGroupRead(activeId, session).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [session, activeId])

  useAnnounce(toast ? `New message in ${toast.groupName}. ${toast.preview}` : '')
  useAnnounce(notice)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(clockNow()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // Typing states expire on their own.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setTypingUsers((current) => current.some((item) => !isTypingNow(item, now)) ? current.filter((item) => isTypingNow(item, now)) : current)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  // Release local previews that never became sent messages.
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.preview)
    for (const item of pendingRef.current) if (item.preview) URL.revokeObjectURL(item.preview)
  }, [])

  // The composer grows with the text, up to about six lines.
  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
  }, [draft, roomVisible])

  const serverMessages = useMemo(() => {
    if (!activeId || !session) return []
    const list = threads[activeId] ?? getCachedGroupMessages(activeId, session)
    return Array.isArray(list) ? list : []
  }, [threads, activeId, session])
  // The open room failed to load and nothing is cached: sending would go nowhere useful, so the composer waits for a retry.
  const roomUnavailable = Boolean(threadErrors[activeId]) && !serverMessages.length

  // A message can arrive over the socket before its own send call returns; show it once.
  const roomPending = pending.filter((item) => item.groupId === activeId && !(item.status === 'sending' && serverMessages.some((message) =>
    message.sender_id === userId
    && (item.uploadedPath ? message.attachment_path === item.uploadedPath : !item.file && !message.attachment_path && (message.body ?? '') === item.body)
    && time(message.created_at) >= time(item.createdAt) - 60_000)))

  // Follow new messages unless the reader has scrolled up; a newly opened room starts at the end.
  useEffect(() => {
    const node = scroller.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [serverMessages.length, roomPending.length, activeId, typingUsers.length])

  // Messages from others that arrive while the reader is scrolled up are counted for the "New messages" pill.
  const othersCount = serverMessages.reduce((sum, message) => sum + (message.sender_id === userId ? 0 : 1), 0)
  useEffect(() => {
    const previous = counted.current
    counted.current = { id: activeId, count: othersCount }
    if (previous.id !== activeId) { setUnseen(0); setAway(false); return }
    if (othersCount > previous.count && !stickToBottom.current) setUnseen((value) => value + othersCount - previous.count)
  }, [activeId, othersCount])

  // Late layout changes keep the reader at the end if they were there: an image finishing
  // loading (the thread grows) or the composer growing with text or image chips (the view shrinks).
  const roomMounted = Boolean(session) && roomVisible && !(groups === null && groupsError) && !(groups && !groups.length)
  useEffect(() => {
    const node = scroller.current
    const thread = threadNode.current
    if (!roomMounted || !node || !thread || typeof ResizeObserver === 'undefined') return
    node.scrollTop = node.scrollHeight
    const observer = new ResizeObserver(() => { if (stickToBottom.current) node.scrollTop = node.scrollHeight })
    observer.observe(thread)
    observer.observe(node)
    return () => observer.disconnect()
  }, [roomMounted])

  function onThreadScroll() {
    const node = scroller.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    stickToBottom.current = distance < 80
    const far = distance > 320
    if (far !== away) setAway(far)
    if (stickToBottom.current && unseen) setUnseen(0)
  }

  function jumpToBottom() {
    const node = scroller.current
    if (!node) return
    stickToBottom.current = true
    setUnseen(0)
    setAway(false)
    node.scrollTo({ top: node.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  function addFiles(files: FileList | File[]) {
    if (roomUnavailable) return
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (!list.length) { setNotice('Only images can be shared in group chats.'); return }
    const room = MAX_IMAGES - imagesRef.current.length
    if (room <= 0) { setNotice(`You can attach up to ${MAX_IMAGES} images at a time.`); return }
    const next = list.slice(0, room).map((file): DraftImage => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: URL.createObjectURL(file),
      error: validateImage(file) || undefined,
    }))
    if (list.length > room) setNotice(`Only the first ${room} ${room === 1 ? 'image was' : 'images were'} attached.`)
    imagesRef.current = [...imagesRef.current, ...next]
    setImages((current) => [...current, ...next])
    textarea.current?.focus()
  }

  function removeImage(id: string) {
    setImages((current) => current.filter((item) => { if (item.id === id) { URL.revokeObjectURL(item.preview); return false } return true }))
    textarea.current?.focus()
  }

  function updatePending(key: string, change: Partial<Pending>) {
    setPending((current) => current.map((item) => item.key === key ? { ...item, ...change } : item))
  }

  async function deliver(item: Pending) {
    if (!session) return
    updatePending(item.key, { status: 'sending', progress: item.file ? 0 : undefined, error: undefined })
    let uploadedPath = ''
    try {
      const uploaded = item.file
        ? await uploadGroupImage(item.groupId, item.file, session, (progress) => updatePending(item.key, { progress }))
        : undefined
      uploadedPath = uploaded?.path ?? ''
      if (uploadedPath) updatePending(item.key, { uploadedPath })
      const message = await sendGroupMessage(item.groupId, item.body, session, uploaded)
      if (uploadedPath && item.preview) rememberLocalPreview(uploadedPath, item.preview)
      setThreads((current) => ({ ...current, [item.groupId]: withMessage(current[item.groupId] ?? getCachedGroupMessages(item.groupId, session) ?? [], message) }))
      setSummaries((current) => ({ ...current, [item.groupId]: { unread: current[item.groupId]?.unread ?? 0, lastAt: message.created_at, last: message } }))
      setPending((current) => current.filter((entry) => entry.key !== item.key))
    } catch (error) {
      // An upload whose message could not be saved is removed again, as before.
      if (uploadedPath) void deleteGroupImage(uploadedPath, { group_id: item.groupId, sender_id: session.user.id }, session).catch(() => undefined)
      updatePending(item.key, { status: 'failed', progress: undefined, uploadedPath: undefined, error: error instanceof Error ? error.message : 'Not sent.' })
    }
  }

  function discardPending(item: Pending) {
    if (item.preview) URL.revokeObjectURL(item.preview)
    setPending((current) => current.filter((entry) => entry.key !== item.key))
  }

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!session || !activeGroup || !activeId || roomUnavailable) return
    const body = draft.trim()
    const ready = images.filter((item) => !item.error)
    if (!body && !ready.length) {
      if (images.length) setNotice('These images cannot be sent. Remove them or choose others.')
      return
    }
    const stamp = new Date().toISOString()
    const base = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const items: Pending[] = ready.length
      ? ready.map((image, index) => ({ key: `${base}-${index}`, groupId: activeGroup.id, body: index === 0 ? body : '', file: image.file, preview: image.preview, createdAt: stamp, status: 'sending' }))
      : [{ key: base, groupId: activeGroup.id, body, createdAt: stamp, status: 'sending' }]
    stickToBottom.current = true
    setUnseen(0)
    setPending((current) => [...current, ...items])
    setDraft('')
    setImages((current) => current.filter((item) => item.error))
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    void setGroupTyping(activeGroup.id, ownName, false, session).catch(() => undefined)
    // Deliver in order so a caption stays with its first image.
    void (async () => { for (const item of items) await deliver(item) })()
  }

  function onDraftChange(value: string) {
    setDraft(value)
    if (!session || !activeGroup || !activeId) return
    const now = clockNow()
    if (value && now - lastTypingSignal.current > 1800) {
      lastTypingSignal.current = now
      void setGroupTyping(activeGroup.id, ownName, true, session).catch(() => undefined)
    }
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    const groupId = activeGroup.id
    typingTimer.current = window.setTimeout(() => { void setGroupTyping(groupId, ownNameRef.current, false, session).catch(() => undefined) }, 2500)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (files.some((file) => file.type.startsWith('image/'))) { event.preventDefault(); addFiles(files) }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragActive(false)
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files)
  }

  /* A starter fills the composer; nothing is sent until the student presses Send. */
  function applyStarter(text: string) {
    onDraftChange(text)
    textarea.current?.focus()
  }

  if (!session) {
    return (
      <div className="ui-page chat-state">
        <div className="ui-empty">
          <h1 className="ui-empty__title">Messages</h1>
          <p className="ui-empty__copy">Sign in to message your study groups.</p>
          <a className="ui-button ui-button--primary" href="#settings">Open settings</a>
        </div>
      </div>
    )
  }

  if (groups === null && groupsError) {
    return (
      <div className="ui-page chat-state">
        <div className="ui-empty">
          <h1 className="ui-empty__title">Messages could not load</h1>
          <p className="ui-empty__copy">Your study groups did not load. Check your connection and try again.</p>
          <button type="button" className="ui-button ui-button--primary" onClick={() => { setGroupsError(false); setGroupsAttempt((value) => value + 1) }}>Try again</button>
        </div>
      </div>
    )
  }

  if (groups && !groups.length) {
    return (
      <div className="ui-page chat-state">
        <div className="ui-empty">
          <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
          <h1 className="ui-empty__title">No conversations yet</h1>
          <p className="ui-empty__copy">Create or join a study group and it gets its own private chat, visible only to its members.</p>
          <a className="ui-button ui-button--primary" href="#profile">Go to study groups</a>
        </div>
      </div>
    )
  }

  const signedIn = session
  const lastActivity = (group: StudyGroup) => time(summaries[group.id]?.lastAt ?? getCachedGroupMessages(group.id, signedIn)?.at(-1)?.created_at)
  const sortedGroups = [...groupList].sort((a, b) => lastActivity(b) - lastActivity(a))
  const visibleGroups = sortedGroups.filter((group) => matchesSearch(search, [group.name, ...group.members.map((member) => member.display_name || member.username)]))
  const totalUnread = groupList.reduce((sum, group) => sum + (group.id === activeId ? 0 : summaries[group.id]?.unread ?? 0), 0)
  const members = activeGroup?.members ?? []
  const memberName = (id: string, fallback?: string) => id === userId ? 'You' : fallback || members.find((member) => member.student_id === id)?.display_name || 'Deleted user'
  const activeTyping = typingUsers.filter((item) => item.group_id === activeId && item.student_id !== userId && isTypingNow(item))
  const lastOwn = [...serverMessages].reverse().find((message) => message.sender_id === userId)
  const others = members.filter((member) => member.student_id !== userId)
  const seenNames = lastOwn
    ? receipts
      .filter((receipt) => receipt.group_id === activeId && receipt.student_id !== userId && time(receipt.last_read_at) >= time(lastOwn.created_at))
      .map((receipt) => others.find((member) => member.student_id === receipt.student_id)?.display_name)
      .filter((name): name is string => Boolean(name))
    : []
  const threadError = threadErrors[activeId]
  const memberLine = others.length
    ? `You, ${others.slice(0, 2).map((member) => firstName(member.display_name || member.username)).join(', ')}${others.length > 2 ? ` and ${others.length - 2} more` : ''}`
    : 'Just you so far. Invite classmates from Groups.'
  const canSend = Boolean(draft.trim()) || images.some((item) => !item.error)
  const composerDisabled = !activeGroup || !activeId || roomUnavailable

  const entries: ThreadEntry[] = [
    ...serverMessages.map((message) => ({ id: message.id, sender_id: message.sender_id, created_at: message.created_at, message })),
    ...roomPending.map((item) => ({ id: item.key, sender_id: userId, created_at: item.createdAt, pending: item })),
  ]
  const thread = buildThread(entries, userId, (entry) => time(entry.created_at))
  const typingNames = activeTyping.map((item) => firstName(item.display_name))
  const typingLabel = typingNames.length === 1
    ? `${typingNames[0]} is typing`
    : typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing` : `${typingNames.length} people are typing`

  function renderEntry(entry: ThreadEntry, own: boolean, name: string, position: string) {
    const message = entry.message
    const item = entry.pending
    const body = message ? message.body ?? '' : item?.body ?? ''
    const stamp = formatClockTime(time(entry.created_at))
    const hasImage = Boolean(message?.attachment_path || item?.preview)
    const emoji = hasImage ? 0 : emojiOnlyCount(body)
    // Our own messages already slid in while sending; history from before the room opened stays still.
    const fresh = item ? true : !own && time(entry.created_at) > openedAt
    const showReceipt = Boolean(message && message.id === lastOwn?.id && !roomPending.length)
    const classes = ['chat-msg', `is-${position}`]
    if (emoji) classes.push('is-emoji')
    if (fresh) classes.push('is-fresh')
    if (revealed === entry.id) classes.push('is-revealed')
    if (item) classes.push(`is-${item.status}`)
    const style = emoji ? { '--emoji-size': emoji === 1 ? '48px' : emoji <= 3 ? '40px' : '32px' } as CSSProperties : undefined
    return (
      <article key={entry.id} className={classes.join(' ')} style={style}>
        <span className="sr-only">{`${name}, ${stamp}: ${body ? '' : hasImage ? 'shared an image' : ''}`}</span>
        <div className="chat-msg__line">
          <div className="chat-msg__content">
            {message?.attachment_path ? <MessageImage message={message} session={signedIn} onOpen={setLightbox} /> : null}
            {item?.preview ? (
              <span className="chat-photo is-local">
                <img src={item.preview} alt={item.file?.name || 'Image being sent'} width="280" height="210" decoding="async" />
                {item.status === 'sending' && item.progress !== undefined && item.progress < 100 ? (
                  <span className="chat-photo__progress" role="progressbar" aria-label="Uploading image" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><i style={{ transform: `scaleX(${item.progress / 100})` }} /></span>
                ) : null}
              </span>
            ) : null}
            {body ? (
              <p
                className="chat-msg__bubble"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('a')) return
                  setRevealed((current) => current === entry.id ? '' : entry.id)
                }}
              >
                {emoji ? body.trim() : <MessageText text={body} />}
              </p>
            ) : null}
          </div>
          <time className="chat-msg__time" dateTime={entry.created_at} aria-hidden="true">{stamp}</time>
        </div>
        {showReceipt ? (
          <p className="chat-msg__receipt">
            {seenNames.length ? (
              <span className="chat-msg__seen" aria-hidden="true">
                {seenNames.slice(0, 4).map((seen) => <PersonAvatar key={seen} name={seen} size="xs" />)}
              </span>
            ) : null}
            <span>{seenLine(seenNames, others.length)}</span>
          </p>
        ) : null}
        {item?.status === 'sending' ? <p className="chat-msg__receipt">{item.preview && item.progress !== undefined && item.progress < 100 ? `Uploading ${item.progress}%` : 'Sending…'}</p> : null}
        {item?.status === 'failed' ? (
          <div className="chat-msg__failed" role="alert">
            {ChatIcon.alert}
            <span>{item.error || 'Not sent.'}</span>
            <button type="button" className="ui-link" onClick={() => void deliver(item)}>Retry</button>
            <button type="button" className="ui-link" onClick={() => discardPending(item)}>Remove</button>
          </div>
        ) : null}
      </article>
    )
  }

  return (
    <div className={`chat${narrow ? ` is-narrow is-${phoneView}` : ''}`}>
      <aside className="chat__list" aria-label="Conversations" hidden={narrow && phoneView !== 'list'}>
        <div className="chat__list-head">
          <h1 className="chat__heading">Messages</h1>
          <a className="chat__new" href="#profile">{ChatIcon.plus}<span>New group</span></a>
        </div>
        <label className="chat__search">
          {ChatIcon.search}
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search groups and people" aria-label="Search conversations" autoComplete="off" enterKeyHint="search" />
        </label>
        {groups === null ? (
          <div className="chat__list-skeleton" aria-label="Loading conversations">{[0, 1, 2, 3].map((item) => <span key={item}><i className="ui-skeleton" /><b className="ui-skeleton" /></span>)}</div>
        ) : visibleGroups.length ? (
          <ul ref={listNode}>
            {visibleGroups.map((group) => {
              const summary = summaries[group.id]
              const last = summary?.last ?? threads[group.id]?.at(-1) ?? getCachedGroupMessages(group.id, signedIn)?.at(-1)
              const unread = group.id === activeId ? 0 : summary?.unread ?? 0
              const sender = last ? group.members.find((member) => member.student_id === last.sender_id)?.display_name || last.sender?.display_name || 'Someone' : ''
              const lastAt = last?.created_at ?? summary?.lastAt
              const memberCount = `${group.members.length} member${group.members.length === 1 ? '' : 's'}`
              // Only rooms opened on this device have their last message; others show what the unread counts know.
              const preview = last
                ? previewLine(last, userId, sender)
                : unread ? `${unread} new message${unread === 1 ? '' : 's'}` : lastAt ? memberCount : `${memberCount} · Say hi 👋`
              const current = roomVisible && group.id === activeGroup?.id
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    data-group={group.id}
                    className={`chat-row${current ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
                    onClick={() => selectGroup(group.id)}
                    aria-current={current ? 'true' : undefined}
                  >
                    <GroupAvatar name={group.name} />
                    <span className="chat-row__text">
                      <span className="chat-row__top"><b>{group.name}</b>{lastAt ? <time dateTime={lastAt}>{listTimeLabel(time(lastAt), formatClockTime, now)}</time> : null}</span>
                      <span className="chat-row__bottom">
                        <small>{preview}</small>
                        {unread ? <span className="chat__unread">{unread > 99 ? '99+' : unread}<span className="sr-only"> unread</span></span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="chat__no-results" role="status">
            <span className="chat__no-results-icon">{ChatIcon.search}</span>
            <b>No matches for “{search.trim()}”</b>
            <small>Try a group name or a classmate’s name.</small>
            <button type="button" className="ui-link" onClick={() => setSearch('')}>Clear search</button>
          </div>
        )}
        <div className="chat__privacy">
          {ChatIcon.lock}
          <span>Only members of a group can read its messages and images.</span>
          <a className="chat__groups-link" href="#profile">Groups</a>
        </div>
      </aside>

      <section
        className={`chat__room${activeGroup ? ` ${toneClass(toneForName(activeGroup.name))}` : ''}`}
        aria-label={activeGroup ? `Conversation with ${activeGroup.name}` : 'Conversation'}
        hidden={!roomVisible}
        onDragOver={(event) => { if (!composerDisabled && Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragActive(true) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }}
        onDrop={onDrop}
      >
        <header className="chat__head">
          {narrow ? (
            <button type="button" className="chat__icon-button chat__back" onClick={showList} aria-label={totalUnread ? `Back to conversations, ${totalUnread} unread` : 'Back to conversations'}>
              {ChatIcon.back}
              {totalUnread ? <span className="chat__unread" aria-hidden="true">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
            </button>
          ) : null}
          {activeGroup ? (
            <>
              <GroupAvatar name={activeGroup.name} size="lg" />
              <div className="chat__title">
                <h2 ref={roomHeading} tabIndex={-1}>{activeGroup.name}</h2>
                <p>{activeTyping.length ? <span className="chat__title-typing">{typingLabel}…</span> : memberLine}</p>
              </div>
              <div className="chat__members" role="img" aria-label={`${members.length} member${members.length === 1 ? '' : 's'}`}>
                {members.slice(0, 4).map((member) => <PersonAvatar key={member.student_id} name={member.display_name || member.username} size="sm" />)}
                {members.length > 4 ? <span className="chat-avatar chat-avatar--sm chat-avatar--more" aria-hidden="true">+{members.length - 4}</span> : null}
              </div>
              <a className="chat__icon-button chat__details" href="#profile" aria-label="Details" title="Group details">{ChatIcon.info}</a>
            </>
          ) : (
            <div className="chat__title"><span className="ui-skeleton chat__title-skeleton" /></div>
          )}
        </header>

        <div className="chat__stage">
          <div className="chat__scroll" ref={scroller} onScroll={onThreadScroll}>
            <div className="chat__thread" ref={threadNode}>
              {threadError ? (
                <div className="ui-alert chat__alert" role="alert">
                  <span>{serverMessages.length ? 'Newer messages could not be loaded.' : threadError}</span>
                  <button type="button" className="ui-button ui-button--sm" onClick={() => setThreadAttempt((value) => value + 1)}>Try again</button>
                </div>
              ) : null}
              {!entries.length && !threadError ? (
                groups === null || loadingThread === activeId ? (
                  <div className="chat__skeleton" aria-label="Loading conversation"><span className="ui-skeleton" /><span className="ui-skeleton is-short" /><span className="ui-skeleton is-own" /><span className="ui-skeleton" /></div>
                ) : (
                  <div className="chat__first">
                    {activeGroup ? <GroupAvatar name={activeGroup.name} size="xl" /> : null}
                    <h3>Start the conversation</h3>
                    <p>Ask a question, share a photo of a problem, or plan your next study session. Only members of {activeGroup?.name ?? 'this group'} can see it.</p>
                    <div className="chat__starters">
                      {STARTERS.map((starter) => <button key={starter} type="button" className="chat__starter" onClick={() => applyStarter(starter)} disabled={composerDisabled}>{starter}</button>)}
                      <button type="button" className="chat__starter" onClick={() => fileInput.current?.click()} disabled={composerDisabled}>{ChatIcon.attach}Share an image</button>
                    </div>
                  </div>
                )
              ) : null}

              <div key={activeId} className="chat__log" role="log" aria-live="polite" aria-relevant="additions" aria-label={activeGroup ? `Messages in ${activeGroup.name}` : 'Messages'}>
                {thread.map((item) => {
                  if (item.kind === 'day') return <p key={item.key} className="chat__chip"><span>{dayLabel(item.at, now)}</span></p>
                  if (item.kind === 'time') return <p key={item.key} className="chat__chip is-time"><span>{formatClockTime(item.at)}</span></p>
                  const name = memberName(item.senderId, item.messages[0].message?.sender?.display_name)
                  return (
                    <div key={item.key} className={`chat-run${item.own ? ' is-own' : ` ${toneClass(toneForName(name))}`}`}>
                      {item.own ? null : <PersonAvatar name={name} className="chat-run__avatar" />}
                      <div className="chat-run__body">
                        {item.own ? null : <p className="chat-run__name" aria-hidden="true">{name}</p>}
                        {item.messages.map((entry, index) => {
                          const count = item.messages.length
                          const position = count === 1 ? 'single' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle'
                          return renderEntry(entry, item.own, name, position)
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              {activeTyping.length ? (
                <div className="chat-typing">
                  <span className="chat-typing__avatars" aria-hidden="true">
                    {activeTyping.slice(0, 2).map((item) => <PersonAvatar key={item.student_id} name={item.display_name} size="sm" />)}
                  </span>
                  <span className="chat-typing__bubble" aria-hidden="true"><i /><i /><i /></span>
                  <span className="chat-typing__label" role="status">{typingLabel}</span>
                </div>
              ) : null}
            </div>
          </div>

          {unseen || away ? (
            <button type="button" className={`chat__jump${unseen ? ' has-new' : ''}`} onClick={jumpToBottom} aria-label={unseen ? `${unseen} new message${unseen === 1 ? '' : 's'}, jump to latest` : 'Jump to latest message'}>
              {unseen ? <span aria-hidden="true">{unseen === 1 ? 'New message' : `${unseen} new messages`}</span> : null}
              {ChatIcon.down}
            </button>
          ) : null}
        </div>

        <form className="chat__composer" onSubmit={submit}>
          {images.length ? (
            <ul className="chat__attachments" aria-label="Images to send">
              {images.map((item) => (
                <li key={item.id} className={item.error ? 'is-failed' : undefined}>
                  <img src={item.preview} alt={item.file.name || 'Image'} width="64" height="64" />
                  <small>{item.error ?? formatFileSize(item.file.size)}</small>
                  <button type="button" onClick={() => removeImage(item.id)} aria-label={`Remove ${item.file.name || 'image'}`}>{ChatIcon.close}</button>
                </li>
              ))}
            </ul>
          ) : null}
          {roomUnavailable ? <p className="chat__composer-note" id="chat-composer-note" role="status">Messages can’t be sent until this chat loads.</p> : null}
          <div className="chat__input">
            <button type="button" className="chat__tool" onClick={() => fileInput.current?.click()} aria-label="Attach images" title="Attach images" disabled={composerDisabled || images.length >= MAX_IMAGES}>{ChatIcon.attach}</button>
            <button type="button" className="chat__tool chat__camera" onClick={() => cameraInput.current?.click()} aria-label="Take a photo" disabled={composerDisabled || images.length >= MAX_IMAGES}>{ChatIcon.camera}</button>
            <textarea
              ref={textarea}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={roomUnavailable ? 'Chat unavailable' : activeGroup ? `Message ${activeGroup.name}` : 'Message'}
              aria-describedby={roomUnavailable ? 'chat-composer-note chat-hint' : 'chat-hint'}
              aria-label={activeGroup ? `Message ${activeGroup.name}` : 'Message'}
              enterKeyHint="send"
              autoCapitalize="sentences"
              rows={1}
              maxLength={2000}
              disabled={composerDisabled}
            />
            <button type="submit" className={`chat__send${canSend && !composerDisabled ? ' is-ready' : ''}`} disabled={composerDisabled || !canSend} aria-label="Send message">{ChatIcon.send}</button>
          </div>
          <p className="chat__hint" id="chat-hint">Enter to send · Shift+Enter for a new line · paste or drop images</p>
          <input ref={fileInput} className="ui-file-input" type="file" accept={ACCEPTED.join(',')} multiple onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
          <input ref={cameraInput} className="ui-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
        </form>

        {dragActive ? <div className="chat__drop" aria-hidden="true">{ChatIcon.image}<span>Drop images to share with {activeGroup?.name ?? 'the group'}</span><small>JPG, PNG, WebP, or GIF · up to 10 MB each</small></div> : null}
        {toast ? (
          <button type="button" className="chat__toast" onClick={() => { selectGroup(toast.groupId); setToast(null) }}>
            <GroupAvatar name={toast.groupName} size="sm" />
            <span className="chat__toast-text"><b>{toast.groupName}</b><small>{toast.preview}</small></span>
            <span className="chat__toast-open">Open</span>
          </button>
        ) : null}
        {notice ? <p className="app-toast">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      </section>
      {lightbox ? <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} /> : null}
    </div>
  )
}
