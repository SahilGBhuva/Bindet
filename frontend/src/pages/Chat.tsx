import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import { getCachedStudyGroups, getStudyGroups, parseServerTime, type StudyGroup } from '../lib/api'
import { accountDisplayName } from '../lib/accountName'
import type { AuthSession } from '../lib/auth'
import {
  deleteGroupImage, getCachedGroupMessages, getGroupImageUrl, isSafeAttachmentPath, listChatUnreads, listGroupMessages,
  listGroupReadReceipts, listGroupTyping, markGroupRead, sendGroupMessage,
  isTypingNow, setGroupTyping, subscribeToAllGroupMessages, subscribeToGroupMessages,
  uploadGroupImage, type ChatMessage, type ChatReadReceipt, type ChatTypingState,
} from '../lib/chat'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import { useDrawer, useMediaQuery } from '../lib/useDrawer'
import './Chat.css'

/*
 * Messages: private study-group conversations, the tutor's sibling.
 * The list and the open room render at once from what is already cached; the
 * network refreshes both behind them. Images are signed and fetched only when
 * they scroll near the screen. A sent message appears immediately, uploads show
 * progress, and anything that fails stays put with Retry and Remove.
 */

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 4
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const GROUPING_WINDOW = 5 * 60 * 1000
const ACTIVE_KEY = 'bindit:chat:active'

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

/* In memory only (never written to storage): survives switching pages, not a reload. */
const summaryMemory = new Map<string, Record<string, Summary>>()
const signedUrls = new Map<string, { url: string; expires: number }>()
/* Images this device just sent, shown from the local copy instead of being downloaded again. */
const localPreviews = new Map<string, string>()

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const shortDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function readActiveGroup(): string {
  try { return sessionStorage.getItem(ACTIVE_KEY) || '' } catch { return '' }
}

function time(iso: string | null | undefined) {
  const value = iso ? parseServerTime(iso) : 0
  return Number.isFinite(value) ? value : 0
}

function startOfDay(value: number) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayLabel(iso: string) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(time(iso))) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return dayFormat.format(new Date(time(iso)))
}

function listTime(iso: string) {
  const value = time(iso)
  return startOfDay(value) === startOfDay(Date.now()) ? timeFormat.format(value) : shortDayFormat.format(value)
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

function cachedImageUrl(path: string) {
  const local = localPreviews.get(path)
  if (local) return local
  const signed = signedUrls.get(path)
  return signed && signed.expires > Date.now() + 60_000 ? signed.url : ''
}

const Icon = {
  attach: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11-7.5 7.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L10.2 16a1.7 1.7 0 0 1-2.4-2.4L14.5 7" /></svg>,
  camera: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
  send: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  list: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" /></svg>,
  image: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /></svg>,
  lock: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
}

/* Signs and loads a shared image only when it comes near the screen, and remembers the link. */
function MessageImage({ message, session }: { message: ChatMessage; session: AuthSession }) {
  // A path outside the sender's folder is never signed or fetched.
  const { group_id: groupId, sender_id: senderId } = message
  const safe = isSafeAttachmentPath(message.attachment_path, { group_id: groupId, sender_id: senderId })
  const path = safe ? message.attachment_path ?? '' : ''
  const name = message.attachment_name || 'Shared image'
  const [url, setUrl] = useState(() => path ? cachedImageUrl(path) : '')
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [near, setNear] = useState(() => Boolean(cachedImageUrl(path)))
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (near) return
    const node = holder.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => setNear(true), 0)
      return () => window.clearTimeout(timer)
    }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true) }, { rootMargin: '600px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    if (!near || url || !path) return
    let live = true
    void getGroupImageUrl(path, { group_id: groupId, sender_id: senderId }, session)
      .then((next) => {
        signedUrls.set(path, { url: next, expires: Date.now() + 3_600_000 })
        if (live) setUrl(next)
      })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [near, url, path, groupId, senderId, session, attempt])

  if (!safe) {
    return (
      <div className="chat-image is-failed">
        {Icon.image}
        <span>Image unavailable</span>
      </div>
    )
  }
  if (failed) {
    return (
      <div className="chat-image is-failed">
        {Icon.image}
        <span>Image unavailable</span>
        <button type="button" className="ui-link" onClick={() => { setFailed(false); setAttempt((value) => value + 1) }}>Try again</button>
      </div>
    )
  }
  if (!url) return <div ref={holder} className="chat-image is-loading ui-skeleton" role="img" aria-label={`Loading ${name}`} />
  return (
    <a className="chat-image" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} in a new tab`}>
      <img src={url} alt={name} width="320" height="240" loading="lazy" decoding="async" />
    </a>
  )
}

export function Chat({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const userId = session?.user.id ?? ''
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => token ? getCachedStudyGroups(token) : [])
  const [groupsError, setGroupsError] = useState(false)
  const [groupsAttempt, setGroupsAttempt] = useState(0)
  const [preferredId, setPreferredId] = useState(readActiveGroup)
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
  const [listOpen, setListOpen] = useState(false)
  // Under 1000px the conversation list is a drawer: inert while closed, modal while open.
  const narrow = useMediaQuery('(max-width: 1000px)')
  const listPanel = useRef<HTMLElement>(null)
  const closeList = useCallback(() => setListOpen(false), [])
  useDrawer({ open: listOpen && narrow, onClose: closeList, panel: listPanel })
  const [notice, setNotice] = useState('')
  const [toast, setToast] = useState<{ groupId: string; groupName: string; preview: string } | null>(null)

  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)
  const activeIdRef = useRef('')
  const groupsRef = useRef<StudyGroup[]>([])
  const ownNameRef = useRef('You')
  const typingTimer = useRef<number | null>(null)
  const lastTypingSignal = useRef(0)
  const imagesRef = useRef<DraftImage[]>([])
  const pendingRef = useRef<Pending[]>([])

  const groupList = useMemo(() => groups ?? [], [groups])
  const activeGroup = groupList.find((group) => group.id === preferredId) ?? groupList[0] ?? null
  const activeId = activeGroup?.id ?? ''
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
    setListOpen(false)
    setSummaries((current) => current[id]?.unread ? { ...current, [id]: { ...current[id], unread: 0 } } : current)
    stickToBottom.current = true
    try { sessionStorage.setItem(ACTIVE_KEY, id) } catch { /* convenience only */ }
  }, [])

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
      .catch((error: unknown) => {
        if (live) setThreadErrors((current) => ({ ...current, [activeId]: error instanceof Error ? error.message : 'Could not load this chat.' }))
      })
      .finally(() => { window.clearTimeout(timer); if (live) setLoadingThread((current) => current === activeId ? null : current) })
    return () => { live = false; window.clearTimeout(timer) }
  }, [session, activeId, threadAttempt])

  // Live messages for the open room.
  useEffect(() => {
    if (!session || !activeId) return
    let stop = () => {}
    let live = true
    void subscribeToGroupMessages(activeId, session, (message) => {
      setThreads((current) => ({ ...current, [activeId]: withMessage(current[activeId] ?? getCachedGroupMessages(activeId, session) ?? [], message) }))
      if (document.visibilityState === 'visible') void markGroupRead(activeId, session).catch(() => undefined)
    }).then((unsubscribe) => { if (live) stop = unsubscribe; else unsubscribe() }).catch(() => undefined)
    return () => {
      live = false
      stop()
      if (typingTimer.current) window.clearTimeout(typingTimer.current)
      void setGroupTyping(activeId, ownNameRef.current, false, session).catch(() => undefined)
    }
  }, [session, activeId])

  // Read receipts and who is typing, refreshed while the room is open.
  useEffect(() => {
    if (!session || !activeId) return
    let live = true
    const refresh = () => {
      void Promise.all([listGroupReadReceipts(activeId, session), listGroupTyping(activeId, session)])
        .then(([nextReceipts, nextTyping]) => { if (live) { setReceipts(nextReceipts); setTypingUsers(nextTyping) } })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 1800)
    return () => { live = false; window.clearInterval(timer) }
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
      if (own || isOpen) return
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

  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`
  }, [draft])

  const serverMessages = useMemo(() => {
    if (!activeId || !session) return []
    return threads[activeId] ?? getCachedGroupMessages(activeId, session) ?? []
  }, [threads, activeId, session])

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

  // Late layout changes (an image finishing loading) keep the reader at the end if they were there.
  const roomMounted = Boolean(session) && !(groups === null && groupsError) && !(groups && !groups.length)
  useEffect(() => {
    const node = scroller.current
    const thread = node?.firstElementChild
    if (!roomMounted || !node || !thread || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (stickToBottom.current) node.scrollTop = node.scrollHeight })
    observer.observe(thread)
    return () => observer.disconnect()
  }, [roomMounted])

  function addFiles(files: FileList | File[]) {
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
      if (uploadedPath && item.preview) localPreviews.set(uploadedPath, item.preview)
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
    if (!session || !activeGroup) return
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
    if (!session || !activeGroup) return
    const now = Date.now()
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

  const lastActivity = (group: StudyGroup) => time(summaries[group.id]?.lastAt ?? getCachedGroupMessages(group.id, session)?.at(-1)?.created_at)
  const sortedGroups = [...groupList].sort((a, b) => lastActivity(b) - lastActivity(a))
  const totalUnread = groupList.reduce((sum, group) => sum + (group.id === activeId ? 0 : summaries[group.id]?.unread ?? 0), 0)
  const memberName = (id: string, fallback?: string) => id === userId ? 'You' : fallback || activeGroup?.members.find((member) => member.student_id === id)?.display_name || 'Group member'
  const activeTyping = typingUsers.filter((item) => item.group_id === activeId && item.student_id !== userId && isTypingNow(item))
  const lastOwn = [...serverMessages].reverse().find((message) => message.sender_id === userId)
  const seenBy = lastOwn ? receipts.filter((receipt) => receipt.group_id === activeId && receipt.student_id !== userId && time(receipt.last_read_at) >= time(lastOwn.created_at)).length : 0
  const threadError = threadErrors[activeId]
  const members = activeGroup?.members ?? []
  const others = members.filter((member) => member.student_id !== userId)
  const memberLine = others.length
    ? `You, ${others.slice(0, 2).map((member) => member.display_name).join(', ')}${others.length > 2 ? ` and ${others.length - 2} more` : ''}`
    : 'Just you so far. Invite classmates from Groups.'
  const canSend = Boolean(draft.trim()) || images.some((item) => !item.error)

  return (
    <div className={`chat${listOpen ? ' is-list-open' : ''}`}>
      <aside ref={listPanel} className="chat__list" aria-label="Conversations" inert={narrow && !listOpen} role={narrow && listOpen ? 'dialog' : undefined} aria-modal={narrow && listOpen ? true : undefined}>
        <div className="chat__list-head">
          <h1>Messages</h1>
          <a className="ui-button ui-button--ghost ui-button--sm" href="#profile">Groups</a>
        </div>
        {groups === null ? (
          <div className="chat__list-skeleton" aria-label="Loading conversations">{[0, 1, 2].map((item) => <span key={item} className="ui-skeleton" />)}</div>
        ) : (
          <ul>
            {sortedGroups.map((group) => {
              const summary = summaries[group.id]
              const last = summary?.last ?? threads[group.id]?.at(-1) ?? getCachedGroupMessages(group.id, session)?.at(-1)
              const unread = group.id === activeId ? 0 : summary?.unread ?? 0
              const preview = last
                ? `${last.sender_id === userId ? 'You: ' : ''}${last.body || 'Shared an image'}`
                : `${group.members.length} member${group.members.length === 1 ? '' : 's'}`
              const lastAt = last?.created_at ?? summary?.lastAt
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    className={`chat__group${group.id === activeId ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
                    onClick={() => selectGroup(group.id)}
                    aria-current={group.id === activeId ? 'true' : undefined}
                  >
                    <span className={`chat__mark ${toneClass(toneForName(group.name))}`} aria-hidden="true">{courseInitial(group.name)}</span>
                    <span className="chat__group-text">
                      <span className="chat__group-top"><b>{group.name}</b>{lastAt ? <time dateTime={lastAt}>{listTime(lastAt)}</time> : null}</span>
                      <span className="chat__group-bottom">
                        <small>{preview}</small>
                        {unread ? <span className="chat__unread">{unread > 99 ? '99+' : unread}<span className="sr-only"> unread</span></span> : null}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="chat__privacy">{Icon.lock}<span>Only members of a group can read its messages and images.</span></p>
      </aside>
      {listOpen ? <button type="button" className="chat__scrim" aria-label="Close conversations" onClick={() => setListOpen(false)} /> : null}

      <section
        className="chat__room"
        aria-label={activeGroup ? `Conversation with ${activeGroup.name}` : 'Conversation'}
        onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragActive(true) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }}
        onDrop={onDrop}
      >
        <header className="chat__head">
          <button type="button" className="chat__list-toggle ui-button ui-button--ghost ui-button--sm" onClick={() => setListOpen(true)} aria-label={totalUnread ? `Show conversations, ${totalUnread} unread` : 'Show conversations'}>
            {Icon.list}
            {totalUnread ? <span className="chat__unread" aria-hidden="true">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
          </button>
          {activeGroup ? (
            <>
              <span className={`chat__mark ${toneClass(toneForName(activeGroup.name))}`} aria-hidden="true">{courseInitial(activeGroup.name)}</span>
              <div className="chat__title">
                <h2>{activeGroup.name}</h2>
                <p>{memberLine}</p>
              </div>
              <div className="chat__members" role="img" aria-label={`${members.length} member${members.length === 1 ? '' : 's'}`}>
                {members.slice(0, 4).map((member) => (
                  <span key={member.student_id} className={`ui-avatar ${toneClass(toneForName(member.display_name || member.username))}`} title={member.display_name}>{courseInitial(member.display_name || member.username)}</span>
                ))}
                {members.length > 4 ? <span className="ui-avatar">+{members.length - 4}</span> : null}
              </div>
              <a className="ui-button ui-button--sm chat__details" href="#profile">Details</a>
            </>
          ) : (
            <div className="chat__title"><span className="ui-skeleton chat__title-skeleton" /></div>
          )}
        </header>

        <div className="chat__scroll" ref={scroller} onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
          <div className="chat__thread" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
            {threadError ? (
              <div className="ui-alert" role="alert">
                <span>{serverMessages.length ? 'Newer messages could not be loaded.' : threadError}</span>
                <button type="button" className="ui-button ui-button--sm" onClick={() => setThreadAttempt((value) => value + 1)}>Try again</button>
              </div>
            ) : null}
            {!serverMessages.length && !roomPending.length && !threadError ? (
              groups === null || loadingThread === activeId ? (
                <div className="chat__skeleton" aria-label="Loading conversation"><span className="ui-skeleton" /><span className="ui-skeleton is-own" /><span className="ui-skeleton is-short" /></div>
              ) : (
                <div className="chat__first">
                  <h3>Start the conversation</h3>
                  <p>Ask a question, share a photo of a problem, or plan your next study session. Only members of {activeGroup?.name ?? 'this group'} can see it.</p>
                  <button type="button" className="ui-button ui-button--sm" onClick={() => fileInput.current?.click()}>{Icon.attach}Share an image</button>
                </div>
              )
            ) : null}

            {serverMessages.map((message, index) => {
              const previous = serverMessages[index - 1]
              const own = message.sender_id === userId
              const newDay = !previous || startOfDay(time(previous.created_at)) !== startOfDay(time(message.created_at))
              const grouped = !newDay && previous?.sender_id === message.sender_id && time(message.created_at) - time(previous.created_at) < GROUPING_WINDOW
              const name = memberName(message.sender_id, message.sender?.display_name)
              const stamp = timeFormat.format(time(message.created_at))
              return (
                <div key={message.id} className={`chat__item${grouped ? ' is-grouped' : ''}`}>
                  {newDay ? <p className="chat__day"><span>{dayLabel(message.created_at)}</span></p> : null}
                  <article className={`chat-message${own ? ' is-own' : ''}${grouped ? ' is-grouped' : ''}`} aria-label={`${name}, ${stamp}`}>
                    {own ? null : grouped
                      ? <span className="chat-message__gutter" aria-hidden="true" />
                      : <span className={`ui-avatar ${toneClass(toneForName(name))}`} aria-hidden="true">{courseInitial(name)}</span>}
                    <div className="chat-message__body">
                      {grouped ? null : <p className="chat-message__meta">{own ? null : <b>{name}</b>}<time dateTime={message.created_at}>{stamp}</time></p>}
                      {message.attachment_path ? <MessageImage message={message} session={session} /> : null}
                      {message.body ? <p className="chat-message__text">{message.body}</p> : null}
                      {message.id === lastOwn?.id && !roomPending.length ? <small className="chat-message__receipt">{seenBy ? `Seen by ${seenBy}` : 'Delivered'}</small> : null}
                    </div>
                  </article>
                </div>
              )
            })}

            {roomPending.map((item) => (
              <article key={item.key} className={`chat-message is-own is-${item.status}`}>
                <div className="chat-message__body">
                  {item.preview ? <span className="chat-image is-local"><img src={item.preview} alt={item.file?.name || 'Image being sent'} width="320" height="240" decoding="async" /></span> : null}
                  {item.body ? <p className="chat-message__text">{item.body}</p> : null}
                  {item.status === 'sending' && item.progress !== undefined && item.progress < 100 ? (
                    <div className="chat-message__progress" role="progressbar" aria-label="Uploading image" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><i style={{ transform: `scaleX(${item.progress / 100})` }} /></div>
                  ) : null}
                  {item.status === 'sending' ? <small className="chat-message__receipt">Sending…</small> : (
                    <div className="chat-message__failed" role="alert">
                      <span>{item.error || 'Not sent.'}</span>
                      <button type="button" className="ui-link" onClick={() => void deliver(item)}>Retry</button>
                      <button type="button" className="ui-link" onClick={() => discardPending(item)}>Remove</button>
                    </div>
                  )}
                </div>
              </article>
            ))}

            {activeTyping.length ? (
              <div className="chat__typing" role="status">
                <span aria-hidden="true"><i /><i /><i /></span>
                {activeTyping.length === 1 ? `${activeTyping[0].display_name} is typing` : `${activeTyping.length} people are typing`}
              </div>
            ) : null}
          </div>
        </div>

        <form className="chat__composer" onSubmit={submit}>
          {images.length ? (
            <ul className="chat__attachments" aria-label="Images to send">
              {images.map((item) => (
                <li key={item.id} className={item.error ? 'is-failed' : undefined}>
                  <img src={item.preview} alt="" width="40" height="40" />
                  <span><b>{item.file.name || 'Image'}</b><small>{item.error ?? formatFileSize(item.file.size)}</small></span>
                  <button type="button" onClick={() => removeImage(item.id)} aria-label={`Remove ${item.file.name || 'image'}`}>×</button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="chat__input">
            <textarea
              ref={textarea}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={activeGroup ? `Message ${activeGroup.name}` : 'Message'}
              aria-label={activeGroup ? `Message ${activeGroup.name}` : 'Message'}
              enterKeyHint="send"
              autoCapitalize="sentences"
              rows={1}
              maxLength={2000}
              disabled={!activeGroup}
            />
            <div className="chat__tools">
              <button type="button" className="chat__tool" onClick={() => fileInput.current?.click()} aria-label="Attach images" disabled={!activeGroup || images.length >= MAX_IMAGES}>{Icon.attach}</button>
              <button type="button" className="chat__tool chat__camera" onClick={() => cameraInput.current?.click()} aria-label="Take a photo" disabled={!activeGroup || images.length >= MAX_IMAGES}>{Icon.camera}</button>
              <span className="chat__hint">Enter to send · Shift+Enter for a new line · drop or paste images</span>
              <button type="submit" className="chat__send" disabled={!activeGroup || !canSend} aria-label="Send message">{Icon.send}</button>
            </div>
          </div>
          <input ref={fileInput} className="ui-file-input" type="file" accept={ACCEPTED.join(',')} multiple onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
          <input ref={cameraInput} className="ui-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
        </form>

        {dragActive ? <div className="chat__drop" aria-hidden="true"><span>Drop images to share with {activeGroup?.name ?? 'the group'}</span><small>JPG, PNG, WebP, or GIF · up to 10 MB each</small></div> : null}
        {toast ? (
          <button type="button" className="chat__toast" onClick={() => { selectGroup(toast.groupId); setToast(null) }}>
            <span className={`chat__mark ${toneClass(toneForName(toast.groupName))}`} aria-hidden="true">{courseInitial(toast.groupName)}</span>
            <span className="chat__toast-text"><b>{toast.groupName}</b><small>{toast.preview}</small></span>
            <span className="chat__toast-open">Open</span>
          </button>
        ) : null}
        {notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      </section>
    </div>
  )
}
