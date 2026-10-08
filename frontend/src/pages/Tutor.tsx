import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  deleteTutorConversation, generateNoteFlashcards, getCachedOttoProfile, getCachedProfile, getCachedTutorConversations, getCachedTutorMessages,
  getOttoProfile, getTutorConversations, getTutorMessages, OTTO_MEMORY_CHANGED_EVENT, parseServerTime, prepareTutorImage, rateTutorMessage,
  saveTutorReplyAsNote, setCachedTutorConversations, setCachedTutorMessages, streamTutorMessage, updateTutorConversation, warmAI,
  type Progress, type StudyMode, type Task, type TutorConversation, type TutorMessage,
} from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { withCourseTones } from '../lib/session'
import { useReviewSummary } from '../lib/useReviewSummary'
import { MathExpression, MathText } from '../components/math/Math'
import { OttoSheet, type OttoSheetTab } from '../components/otto/OttoSheet'
import { useDrawer, useMediaQuery } from '../lib/useDrawer'
import { guideFromAttachment, guideHash, guideKind } from '../lib/studyGuides'
import './Tutor.css'

/*
 * The tutor. The shell renders at once from cache; history loads behind it.
 * A sent message appears immediately, the reply streams in as tokens arrive,
 * and nothing here waits on anything it does not need.
 */

type Attachment = { id: string; name: string; preview: string; dataUrl?: string; size?: number; state: 'preparing' | 'ready' | 'failed'; error?: string }
type LocalMessage = TutorMessage & { key: string; status?: 'sending' | 'streaming' | 'failed' | 'stopped'; previews?: string[]; progress?: number; error?: string; tier?: string; grounded?: string[]; groundedIn?: { course: string; unit: string } }

const NEW = 'new'
const MAX_IMAGES = 3
// The server accepts 4 MB per image and 12 MB per request; base64 adds a third, so
// all images together must stay under about 8.5 MB. Photos are downscaled first.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 8.5 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function toLocal(message: TutorMessage): LocalMessage {
  return { ...message, key: `m-${message.id}` }
}

/* A small, safe renderer for the tutor's plain-text formatting: paragraphs, lists, code, bold, italics and math. */
function emphasis(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>
    return <Fragment key={key}>{part}</Fragment>
  })
}

/* Code spans first (math is never read inside them), then math, then bold and italics. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>
    return <MathText key={key} text={part} renderText={(plain, textKey) => emphasis(plain, `${key}-${textKey}`)} />
  })
}

/* A display equation on lines of its own: $$ … $$ or \[ … \]. Returns its end line, or -1. */
function displayMathEnd(lines: string[], start: number): number {
  const open = lines[start].trim()
  const close = open.startsWith('$$') ? '$$' : open.startsWith('\\[') ? '\\]' : ''
  if (!close) return -1
  const rest = open.slice(2)
  if (rest.includes(close)) return rest.trim().endsWith(close) ? start : -1
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().endsWith(close)) return index
  }
  return -1
}

/* Memoised: while a reply streams, only the message that is growing is parsed again. */
const Rich = memo(function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim().startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) { code.push(lines[index]); index += 1 }
      index += 1
      blocks.push(<pre key={`b${blocks.length}`}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const mathEnd = displayMathEnd(lines, index)
    if (mathEnd >= 0) {
      const source = lines.slice(index, mathEnd + 1).join('\n').trim()
      const tex = source.slice(2, -2).trim()
      blocks.push(tex
        ? <MathExpression key={`b${blocks.length}`} tex={tex} display source={source} />
        : <p key={`b${blocks.length}`}>{source}</p>)
      index = mathEnd + 1
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items: string[] = []
      while (index < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*([-*•]|\d+[.)])\s+/, '')); index += 1 }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={`b${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `l${blocks.length}-${itemIndex}`)}</li>)}</List>)
      continue
    }
    if (/^#{1,4}\s/.test(line)) {
      blocks.push(<h4 key={`b${blocks.length}`}>{inline(line.replace(/^#{1,4}\s/, ''), `h${blocks.length}`)}</h4>)
      index += 1
      continue
    }
    if (!line.trim()) { index += 1; continue }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[index]) && !lines[index].trim().startsWith('```') && !/^#{1,4}\s/.test(lines[index]) && (!paragraph.length || displayMathEnd(lines, index) < 0)) { paragraph.push(lines[index]); index += 1 }
    blocks.push(<p key={`b${blocks.length}`}>{paragraph.map((part, partIndex) => <Fragment key={partIndex}>{partIndex ? <br /> : null}{inline(part, `p${blocks.length}-${partIndex}`)}</Fragment>)}</p>)
  }
  return <>{blocks}</>
})

function readLastConversation(): string {
  try { return sessionStorage.getItem('bindit:tutor:active') || NEW } catch { return NEW }
}

/* One-tap follow-ups under a reply. Each sends an ordinary tutor message, so the usual limits apply. */
const FOLLOW_UPS = [
  { id: 'simpler', label: 'Explain simpler', prompt: 'Explain that again more simply, in plain words.' },
  { id: 'example', label: 'Give an example', prompt: 'Give me a concrete example of that.' },
  { id: 'quiz', label: 'Quiz me on this', prompt: 'Quiz me on that with 3 quick questions. Ask one at a time and wait for my answer before the next.' },
]

const MASCOT = '/bindit-mascot-cutout.webp'

type Starter = { key: string; label: string; prompt: string; course?: string; unit?: string; tone?: string }

/* "Just now", "5m ago", "3h ago", "Yesterday", "Mon", "Oct 3". */
function relativeTime(iso: string, now: number): string {
  const time = parseServerTime(iso)
  const minutes = Math.max(0, Math.round((now - time) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const then = new Date(time)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return `${Math.round(minutes / 60)}h ago`
  if (time >= startOfToday - 86_400_000) return 'Yesterday'
  if (time >= startOfToday - 6 * 86_400_000) return weekdayFormat.format(then)
  return dayFormat.format(then)
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

function groupOf(conversation: TutorConversation, now: number): 'Pinned' | 'Today' | 'This week' | 'Older' {
  if (conversation.pinned) return 'Pinned'
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const time = parseServerTime(conversation.updated_at)
  if (time >= startOfToday) return 'Today'
  if (time >= startOfToday - 6 * 86_400_000) return 'This week'
  return 'Older'
}

/* Text for reading aloud: no markdown symbols or LaTeX commands. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[*_#`>{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

function Icon({ name }: { name: 'pin' | 'pinned' | 'edit' | 'trash' | 'copy' | 'speak' | 'stop' | 'up' | 'down' | 'regen' | 'cards' | 'mic' | 'tune' | 'search' }) {
  const paths: Record<string, ReactNode> = {
    pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
    pinned: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" className="is-filled" />,
    edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
    trash: <path d="M6 7h12M10 7V5h4v2M8 7l1 12h6l1-12" />,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></>,
    speak: <path d="M4 10v4h3l5 4V6L7 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
    up: <path d="M7 11v9H4v-9zM7 11l4-7a2 2 0 0 1 3 2l-1 4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7" />,
    down: <path d="M7 13V4H4v9zM7 13l4 7a2 2 0 0 0 3-2l-1-4h5a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 16.8 4H7" />,
    regen: <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" />,
    cards: <><rect x="3" y="7" width="13" height="10" rx="2" /><path d="M8 4h11a2 2 0 0 1 2 2v9" /></>,
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
    tune: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  }
  return <svg className="tutor-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

export function Tutor({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const data = useData()
  const notebook = useMemo(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  }, [data])
  const toneOf = useCallback((name: string) => notebook.courses.find((item) => item.name === name)?.tone, [notebook])
  const [conversations, setConversations] = useState<TutorConversation[] | null>(() => token ? getCachedTutorConversations(token) : [])
  const [activeId, setActiveIdState] = useState<string>(readLastConversation)
  const [threads, setThreads] = useState<Record<string, LocalMessage[]>>(() => {
    const id = readLastConversation()
    const cached = token && id !== NEW ? getCachedTutorMessages(token, id) : null
    return cached ? { [id]: cached.map(toLocal) } : {}
  })
  const [loadingThread, setLoadingThread] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [course, setCourse] = useState(notebook.activeCourse || '')
  const [unit, setUnit] = useState(notebook.activeUnit || '')
  const [listOpen, setListOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [newMode, setNewMode] = useState<StudyMode>('explain')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [sheet, setSheet] = useState<OttoSheetTab | null>(null)
  const [ottoName, setOttoName] = useState(() => (token ? getCachedOttoProfile(token)?.preferred_name : '') ?? '')
  const [memoryNotice, setMemoryNotice] = useState(false)
  const [copied, setCopied] = useState('')
  const [speaking, setSpeaking] = useState('')
  const [listening, setListening] = useState(false)
  const [cardState, setCardState] = useState<Record<string, 'making' | 'done' | 'failed'>>({})
  const [now, setNow] = useState(() => Date.now())
  const [stats, setStats] = useState<Progress | null>(() => data.getCachedProgress(session?.user.id ?? data.getStudentId()))
  const [tasks, setTasks] = useState<Task[] | null>(() => token ? data.getCachedTasks(token) : null)
  const review = useReviewSummary(token || undefined)
  // Under 1000px the conversation list is a drawer: inert while closed, modal while open.
  const narrow = useMediaQuery('(max-width: 1000px)')
  const listPanel = useRef<HTMLElement>(null)
  const closeList = useCallback(() => setListOpen(false), [])
  useDrawer({ open: listOpen && narrow, onClose: closeList, panel: listPanel })
  const [dragActive, setDragActive] = useState(false)
  const [notice, setNotice] = useState('')
  const stopRef = useRef<(() => void) | null>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)
  const Recognition = useMemo(() => speechRecognition(), [])

  const thread = threads[activeId] ?? []
  const active = conversations?.find((item) => item.id === activeId) ?? null
  const streaming = thread.some((message) => message.status === 'streaming' || message.status === 'sending')
  const units = notebook.courses.find((item) => item.name === course)?.units ?? []
  const studyMode: StudyMode = active?.study_mode ?? (activeId === NEW ? newMode : 'explain')
  const displayName = (token ? getCachedProfile(token)?.display_name : '') ?? ''
  const greetingName = ottoName || displayName.split(/\s+/)[0] || ''

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id)
    try { sessionStorage.setItem('bindit:tutor:active', id) } catch { /* convenience only */ }
  }, [])

  // The conversation list refreshes in the background; the cached list is already on screen.
  useEffect(() => {
    if (!token) return
    let live = true
    void getTutorConversations(token).then((items) => { if (live) setConversations(items) }).catch(() => { if (live) setConversations((current) => current ?? []) })
    return () => { live = false }
  }, [token])

  // The name Otto uses, for the greeting. Cached first; refreshed quietly.
  useEffect(() => {
    if (!token || data.sandboxed) return
    let live = true
    void getOttoProfile(token).then((profile) => { if (live) setOttoName(profile.preferred_name) }).catch(() => undefined)
    return () => { live = false }
  }, [token, data])

  // Smart starters read data the app already has: no AI calls.
  useEffect(() => {
    if (!token) return
    let live = true
    void data.getProgress(session?.user.id ?? data.getStudentId(), token).then((value) => { if (live) setStats(value) }).catch(() => undefined)
    void data.getTasks(token, true).then((value) => { if (live) setTasks(value) }).catch(() => undefined)
    return () => { live = false }
  }, [token, data, session])

  // Relative times stay fresh.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // Opening a conversation never blocks: cached messages show first, then the latest page replaces them.
  useEffect(() => {
    if (!token || activeId === NEW || activeId.startsWith('pending')) return
    let live = true
    const timer = window.setTimeout(() => { if (live) setLoadingThread(activeId) }, 120)
    void getTutorMessages(token, activeId).then((items) => {
      if (!live) return
      setThreads((current) => {
        const local = current[activeId] ?? []
        // Keep anything still in flight that the server has not returned yet.
        const inFlight = local.filter((message) => message.status)
        // The server doesn't keep which notes a reply drew on (a fast or replayed reply can
        // finish before this page loads): keep the sources this page was told while it streamed.
        const grounded = new Map(local.filter((message) => message.grounded?.length).map((message) => [message.id, message.grounded]))
        const merged = items.map((item) => {
          const message = toLocal(item)
          const sources = grounded.get(item.id)
          return sources ? { ...message, grounded: sources } : message
        })
        if (grounded.size) setCachedTutorMessages(token, activeId, merged)
        return { ...current, [activeId]: [...merged, ...inFlight] }
      })
    }).catch((error: unknown) => {
      if (!live) return
      if (error instanceof Error && /not found/i.test(error.message)) { setActiveId(NEW) } else { setNotice('Older messages could not be loaded. They will appear when you are back online.') }
    }).finally(() => { window.clearTimeout(timer); if (live) setLoadingThread((current) => current === activeId ? null : current) })
    return () => { live = false; window.clearTimeout(timer) }
  }, [token, activeId, setActiveId])

  useEffect(() => {
    if (token && conversations) setCachedTutorConversations(token, conversations)
  }, [token, conversations])

  // Follow the reply as it streams, unless the student has scrolled up to read. The welcome
  // (no messages yet) starts at its top, so a short phone screen shows Otto's greeting first.
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    if ((threads[activeId] ?? []).length === 0) node.scrollTop = 0
    else if (stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [threads, activeId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!memoryNotice) return
    const timer = window.setTimeout(() => setMemoryNotice(false), 9000)
    return () => window.clearTimeout(timer)
  }, [memoryNotice])

  useEffect(() => () => {
    stopRef.current?.()
    recognition.current?.stop()
    if (canSpeak) window.speechSynthesis.cancel()
  }, [])

  // Opening the tutor wakes the API and its AI connection, so the first answer starts sooner.
  useEffect(() => { if (token) warmAI() }, [token])

  // Release image previews when they leave the composer.
  const releasePreview = (attachment: Attachment) => { if (attachment.preview.startsWith('blob:')) URL.revokeObjectURL(attachment.preview) }

  useEffect(() => {
    const node = textarea.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`
  }, [draft])

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (!list.length) { setNotice('Only images can be sent to Otto.'); return }
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (room <= 0) { setNotice(`You can attach up to ${MAX_IMAGES} images.`); return current }
      const next = list.slice(0, room).map((file) => {
        const attachment: Attachment = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'preparing' }
        if (!ACCEPTED.includes(file.type)) return { ...attachment, state: 'failed' as const, error: 'Use JPG, PNG, WebP, or GIF' }
        void prepareTutorImage(file).then((prepared) => {
          setAttachments((items) => items.map((item) => item.id === attachment.id
            ? prepared.size > MAX_IMAGE_BYTES ? { ...item, state: 'failed', error: 'Larger than 4 MB' } : { ...item, state: 'ready', dataUrl: prepared.dataUrl, size: prepared.size }
            : item))
        }).catch(() => setAttachments((items) => items.map((item) => item.id === attachment.id ? { ...item, state: 'failed', error: 'Could not read this image' } : item)))
        return attachment
      })
      if (list.length > room) setNotice(`Only the first ${room} ${room === 1 ? 'image was' : 'images were'} attached.`)
      return [...current, ...next]
    })
  }, [])

  const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => { if (item.id === id) { releasePreview(item); return false } return true }))

  function updateMessage(threadId: string, key: string, change: (message: LocalMessage) => LocalMessage) {
    setThreads((current) => ({ ...current, [threadId]: (current[threadId] ?? []).map((message) => message.key === key ? change(message) : message) }))
  }

  /*
   * Sends a message (or, with regenerate, asks for a new answer to the last one) and streams
   * the reply. Context overrides let a starter pick its course and unit in the same tap.
   */
  function send(content: string, images: Attachment[], retryKey?: string, options: { course?: string; unit?: string; regenerate?: boolean } = {}) {
    if (!token || !content.trim() || streaming) return
    const threadId = activeId
    const useCourse = options.course ?? course
    const useUnit = options.unit ?? unit
    const stamp = new Date().toISOString()
    const userKey = retryKey ?? `local-${Date.now()}`
    const replyKey = `reply-${Date.now()}`
    const ready = images.filter((item) => item.state === 'ready' && item.dataUrl)
    const userMessage: LocalMessage = { id: 0, key: userKey, role: 'user', content, attachments: ready.map((item) => item.name), model_tier: '', created_at: stamp, status: 'sending', previews: ready.map((item) => item.preview), progress: ready.length ? 0 : undefined }
    const reply: LocalMessage = { id: 0, key: replyKey, role: 'assistant', content: '', attachments: [], model_tier: '', created_at: stamp, status: 'streaming' }
    stickToBottom.current = true
    setThreads((current) => {
      const existing = (current[threadId] ?? []).filter((message) => message.key !== userKey)
      if (options.regenerate) {
        // The last reply is replaced; the question it answered stays where it is.
        const lastReply = existing.map((message) => message.role).lastIndexOf('assistant')
        return { ...current, [threadId]: [...existing.filter((_, index) => index !== lastReply), reply] }
      }
      return { ...current, [threadId]: [...existing, userMessage, reply] }
    })
    let liveThread = threadId
    let answered = false
    stopRef.current = streamTutorMessage(token, {
      conversation_id: threadId === NEW ? undefined : threadId,
      content,
      course: useCourse || undefined,
      unit: useUnit || undefined,
      images: ready.map((item) => ({ name: item.name, data_url: item.dataUrl! })),
      study_mode: studyMode,
      regenerate: options.regenerate || undefined,
    }, {
      onUploadProgress: (fraction) => updateMessage(liveThread, userKey, (message) => ({ ...message, progress: fraction })),
      onMeta: (meta) => {
        const conversationId = meta.conversation.id
        if (liveThread === NEW) {
          // The first message created the conversation: move the thread under its real id.
          setThreads((current) => { const { [NEW]: moved = [], ...rest } = current; return { ...rest, [conversationId]: moved } })
          liveThread = conversationId
          setActiveId(conversationId)
        }
        setConversations((current) => [meta.conversation, ...(current ?? []).filter((item) => item.id !== conversationId)].map((item) => item.id === conversationId ? { ...item, updated_at: new Date().toISOString() } : item))
        // The server accepted the message; it is stored while the reply starts.
        updateMessage(liveThread, userKey, (message) => ({ ...message, status: undefined, progress: undefined }))
        updateMessage(liveThread, replyKey, (message) => ({ ...message, tier: meta.tier, grounded: meta.grounded_in, groundedIn: { course: meta.conversation.unit ? meta.conversation.course : useCourse, unit: meta.conversation.unit || useUnit } }))
      },
      onSaved: (stored) => updateMessage(liveThread, userKey, (message) => ({ ...message, ...stored, key: userKey, status: undefined, progress: undefined })),
      onDelta: (text) => {
        answered = true
        updateMessage(liveThread, replyKey, (message) => ({ ...message, content: message.content + text }))
      },
      onDone: ({ message: saved }) => {
        updateMessage(liveThread, replyKey, (message) => ({ ...message, ...saved, key: replyKey, status: undefined }))
        stopRef.current = null
        setThreads((current) => { if (token && liveThread !== NEW) setCachedTutorMessages(token, liveThread, (current[liveThread] ?? []).filter((item) => !item.status)); return current })
      },
      onTitle: ({ conversation_id: conversationId, title }) => {
        setConversations((current) => (current ?? []).map((item) => item.id === conversationId ? { ...item, title } : item))
      },
      onMemory: ({ notice: first }) => {
        window.dispatchEvent(new Event(OTTO_MEMORY_CHANGED_EVENT))
        if (first) setMemoryNotice(true)
      },
      onError: (error) => {
        stopRef.current = null
        setThreads((current) => ({
          ...current,
          [liveThread]: (current[liveThread] ?? []).flatMap((message) => {
            if (message.key === replyKey) return message.content ? [{ ...message, status: undefined }] : []
            // With no reply at all, the error and a Retry sit on the student's message. Resending
            // a turn the server already saved reuses it instead of storing it twice.
            if (message.key === userKey) return [answered ? { ...message, status: undefined, progress: undefined } : { ...message, status: 'failed' as const, error, progress: undefined }]
            return [message]
          }),
        }))
        if (answered || options.regenerate) setNotice(error)
      },
    })
  }

  /* Stop generating: the stream is closed (the server keeps what was written) and the partial reply stays. */
  function stop() {
    stopRef.current?.()
    stopRef.current = null
    setThreads((current) => ({
      ...current,
      [activeId]: (current[activeId] ?? []).flatMap((message) => message.status === 'streaming'
        ? (message.content ? [{ ...message, status: 'stopped' as const }] : [])
        : message.status === 'sending' ? [{ ...message, status: undefined }] : [message]),
    }))
  }

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (attachments.some((item) => item.state === 'preparing')) { setNotice('Images are still being prepared. One moment.'); return }
    const total = attachments.reduce((sum, item) => sum + (item.state === 'ready' ? item.size ?? 0 : 0), 0)
    if (total > MAX_TOTAL_IMAGE_BYTES) { setNotice('These images are too large to send together. Remove one and try again.'); return }
    const content = draft.trim() || (attachments.length ? 'What can you tell me about this?' : '')
    if (!content) return
    recognition.current?.stop()
    send(content, attachments)
    setDraft('')
    setAttachments((current) => { current.filter((item) => item.state === 'failed').forEach(releasePreview); return [] })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() }
    if (event.key === 'Escape' && streaming) stop()
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

  function newConversation() {
    stop()
    setActiveId(NEW)
    setNewMode('explain')
    setRenaming(null)
    setThreads((current) => ({ ...current, [NEW]: [] }))
    setListOpen(false)
    window.setTimeout(() => textarea.current?.focus(), 0)
  }

  function open(conversation: TutorConversation) {
    if (conversation.id === activeId) { setListOpen(false); return }
    stop()
    setRenaming(null)
    if (token && !threads[conversation.id]) {
      const cached = getCachedTutorMessages(token, conversation.id)
      if (cached) setThreads((current) => ({ ...current, [conversation.id]: cached.map(toLocal) }))
    }
    setActiveId(conversation.id)
    if (conversation.course) { setCourse(conversation.course); setUnit(conversation.unit) }
    setListOpen(false)
  }

  async function remove(conversation: TutorConversation) {
    if (!token || !data.confirm(`Delete “${conversation.title}”? This removes the whole conversation.`)) return
    const previous = conversations
    setConversations((current) => (current ?? []).filter((item) => item.id !== conversation.id))
    if (activeId === conversation.id) newConversation()
    try { await deleteTutorConversation(token, conversation.id) }
    catch { setConversations(previous); setNotice('That conversation could not be deleted. Try again.') }
  }

  /* Rename, pin or study mode: shown at once, undone if the server says no. */
  async function change(conversation: TutorConversation, update: { title?: string; pinned?: boolean; study_mode?: StudyMode }, failure: string) {
    if (!token) return
    const previous = conversations
    setConversations((current) => (current ?? []).map((item) => item.id === conversation.id ? { ...item, ...update } : item))
    try {
      const saved = await updateTutorConversation(token, conversation.id, update)
      setConversations((current) => (current ?? []).map((item) => item.id === saved.id ? { ...item, ...saved, updated_at: item.updated_at } : item))
    } catch {
      setConversations(previous)
      setNotice(failure)
    }
  }

  function chooseMode(mode: StudyMode) {
    if (active) void change(active, { study_mode: mode }, 'The study mode could not be changed. Try again.')
    else setNewMode(mode)
  }

  function submitRename(event: FormEvent) {
    event.preventDefault()
    const title = (renaming ?? '').trim()
    if (active && title && title !== active.title) void change(active, { title }, 'That name could not be saved. Try again.')
    setRenaming(null)
  }

  async function copy(message: LocalMessage) {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(message.key)
      window.setTimeout(() => setCopied((current) => current === message.key ? '' : current), 2000)
    } catch {
      setNotice('Copying isn’t available here. Select the text instead.')
    }
  }

  function readAloud(message: LocalMessage) {
    if (!canSpeak) return
    const synth = window.speechSynthesis
    synth.cancel()
    if (speaking === message.key) { setSpeaking(''); return }
    const utterance = new SpeechSynthesisUtterance(speakable(message.content))
    utterance.onend = () => setSpeaking((current) => current === message.key ? '' : current)
    utterance.onerror = utterance.onend
    setSpeaking(message.key)
    synth.speak(utterance)
  }

  async function rate(message: LocalMessage, value: -1 | 1) {
    if (!token || !message.id) return
    const next = message.rating === value ? 0 : value
    updateMessage(activeId, message.key, (item) => ({ ...item, rating: next }))
    try { await rateTutorMessage(token, message.id, next) }
    catch { updateMessage(activeId, message.key, (item) => ({ ...item, rating: message.rating ?? 0 })); setNotice('Your rating could not be saved.') }
  }

  /* "Make flashcards": the reply becomes one note in this unit, then the normal flashcard path makes (or reuses) its cards. */
  async function makeFlashcards(message: LocalMessage) {
    if (!token || !message.id || !course || !unit) return
    setCardState((current) => ({ ...current, [message.key]: 'making' }))
    try {
      const note = await saveTutorReplyAsNote(token, message.id, course, unit)
      const result = await generateNoteFlashcards(note.id, undefined, token)
      if (result.status !== 'ready' || !result.cards.length) throw new Error(result.status === 'too_short' ? 'That reply is too short to make flashcards from.' : 'Flashcards couldn’t be made from that reply.')
      setCardState((current) => ({ ...current, [message.key]: 'done' }))
      setNotice(`${result.cards.length} ${result.cards.length === 1 ? 'flashcard' : 'flashcards'} saved to ${unit}.`)
    } catch (error) {
      setCardState((current) => ({ ...current, [message.key]: 'failed' }))
      setNotice(error instanceof Error ? error.message : 'Flashcards couldn’t be made. Try again.')
    }
  }

  function openUnit(courseName: string, unitName: string) {
    try { data.saveNotebook({ ...data.loadNotebook(), activeCourse: courseName, activeUnit: unitName }) } catch { /* Study opens on its default unit */ }
    window.location.hash = '#tools'
  }

  function toggleDictation() {
    if (!Recognition) return
    if (listening) { recognition.current?.stop(); return }
    const instance = new Recognition()
    instance.lang = navigator.language || 'en-US'
    instance.interimResults = false
    instance.continuous = false
    const before = draft
    instance.onresult = (event) => {
      let text = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (event.results[index].isFinal) text += event.results[index][0].transcript
      }
      if (text) setDraft(`${before}${before && !/\s$/.test(before) ? ' ' : ''}${text.trim()}`)
    }
    instance.onend = () => { setListening(false); recognition.current = null }
    instance.onerror = () => { setListening(false); recognition.current = null; setNotice('Dictation stopped. Check microphone permission and try again.') }
    recognition.current = instance
    setListening(true)
    try { instance.start() } catch { setListening(false); recognition.current = null }
  }

  /* Starters from the student's own data (due cards, weak topics, upcoming tasks, recent units). No AI. */
  const starters = useMemo<Starter[]>(() => {
    const list: Starter[] = []
    const due = [...(review?.by_unit ?? [])].filter((item) => item.due > 0).sort((a, b) => b.due - a.due)[0]
    if (due) list.push({ key: 'due', label: `Quiz me on my ${due.due} due ${due.course} ${due.due === 1 ? 'card' : 'cards'}`, prompt: `Quiz me on ${due.unit} in ${due.course}. Ask 3 quick questions, one at a time.`, course: due.course, unit: due.unit, tone: toneOf(due.course) })
    // One tap: Otto makes a saved study guide from the unit's notes (a card links to it).
    if (notebook.activeCourse && notebook.activeUnit) list.push({ key: 'guide', label: `Make a study guide for ${notebook.activeUnit}`, prompt: `Make me a study guide for ${notebook.activeUnit}`, course: notebook.activeCourse, unit: notebook.activeUnit, tone: toneOf(notebook.activeCourse) })
    const weak = stats?.weak_topics?.[0]
    if (weak) list.push({ key: 'weak', label: `Help me get better at ${weak}`, prompt: `I keep missing questions on ${weak}. Explain the key idea and give me one practice question.` })
    const today = new Date(now)
    const soon = (tasks ?? []).filter((task) => task.status !== 'done' && task.due_date)
      .map((task) => ({ task, at: new Date(`${task.due_date}T00:00:00`).getTime() }))
      .filter(({ at }) => at >= new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() && at - now < 8 * 86_400_000)
      .sort((a, b) => a.at - b.at)[0]
    if (soon) list.push({ key: 'task', label: `Prepare for “${soon.task.title}” (${weekdayFormat.format(new Date(soon.at))})`, prompt: `Help me prepare for “${soon.task.title}”${soon.task.course ? ` in ${soon.task.course}` : ''}. Make me a short plan and start with the most important topic.`, course: soon.task.course || undefined, tone: soon.task.course ? toneOf(soon.task.course) : undefined })
    if (notebook.activeCourse && notebook.activeUnit) list.push({ key: 'unit', label: `Explain the key ideas of ${notebook.activeUnit}`, prompt: `Explain the key ideas of ${notebook.activeUnit} like I’m seeing them for the first time.`, course: notebook.activeCourse, unit: notebook.activeUnit, tone: toneOf(notebook.activeCourse) })
    return list.slice(0, 4)
  }, [review, stats, tasks, notebook, now, toneOf])

  const generic: Starter[] = unit
    ? [{ key: 'g1', label: `Explain ${unit} like I'm seeing it for the first time`, prompt: `Explain ${unit} like I'm seeing it for the first time` }, { key: 'g4', label: `Make a study guide for ${unit}`, prompt: `Make me a study guide for ${unit}` }, { key: 'g2', label: `Quiz me with three questions on ${unit}`, prompt: `Quiz me with three questions on ${unit}` }, { key: 'g3', label: `What are the most common mistakes in ${unit}?`, prompt: `What are the most common mistakes in ${unit}?` }]
    : [{ key: 'g1', label: 'Help me make a study plan for this week', prompt: 'Help me make a study plan for this week' }, { key: 'g2', label: 'Explain a concept step by step', prompt: 'Explain a concept step by step' }, { key: 'g3', label: 'Check my understanding with a few questions', prompt: 'Check my understanding with a few questions' }]
  const startersShown = (starters.length ? [...starters, ...generic] : generic)
    .filter((item, index, all) => all.findIndex((other) => other.label === item.label) === index)
    .slice(0, 4)

  function startFrom(starter: Starter) {
    if (starter.course !== undefined) { setCourse(starter.course); setUnit(starter.unit ?? '') }
    send(starter.prompt, [], undefined, { course: starter.course, unit: starter.unit })
  }

  // Search over titles, course and unit; then grouped Pinned / Today / This week / Older.
  const grouped = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const matches = (conversations ?? []).filter((item) => !needle || `${item.title} ${item.course} ${item.unit}`.toLocaleLowerCase().includes(needle))
    const order = ['Pinned', 'Today', 'This week', 'Older'] as const
    return order.map((name) => ({ name, items: matches.filter((item) => groupOf(item, now) === name) })).filter((group) => group.items.length)
  }, [conversations, query, now])

  const lastAssistant = thread.map((message) => message.role).lastIndexOf('assistant')

  const starterList = (items: Starter[], className = '') => (
    <div className={`tutor__suggestions ${className}`}>
      {items.map((starter) => (
        <button key={starter.key} type="button" onClick={() => startFrom(starter)} disabled={streaming} style={starter.tone ? { ['--course' as string]: starter.tone } : undefined} className={starter.tone ? 'has-course' : ''}>
          {starter.label}<span aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className={`tutor${listOpen ? ' is-list-open' : ''}`}>
      <aside ref={listPanel} className="tutor__list" aria-label="Conversations" inert={narrow && !listOpen} role={narrow && listOpen ? 'dialog' : undefined} aria-modal={narrow && listOpen ? true : undefined}>
        <div className="tutor__list-head">
          <span className="ui-eyebrow">Otto · your tutor</span>
          <button type="button" className="ui-button ui-button--sm" onClick={newConversation}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New
          </button>
        </div>
        <label className="tutor__search">
          <Icon name="search" />
          <span className="sr-only">Search conversations</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" autoComplete="off" enterKeyHint="search" />
        </label>
        {conversations === null ? (
          <div className="tutor__list-skeleton">{[0, 1, 2, 3].map((item) => <span key={item} className="ui-skeleton" />)}</div>
        ) : grouped.length ? (
          <div className="tutor__groups">
            {grouped.map((group) => (
              <section key={group.name} aria-label={group.name}>
                <h2 className="tutor__group-title">{group.name}</h2>
                <ul>
                  {group.items.map((conversation) => {
                    const tone = toneOf(conversation.course)
                    return (
                      <li key={conversation.id} className={conversation.id === activeId ? 'is-active' : ''}>
                        <button type="button" className="tutor__list-item" onClick={() => open(conversation)} aria-current={conversation.id === activeId ? 'true' : undefined}>
                          <span>{conversation.title}</span>
                          <small>
                            {conversation.course ? <i className="ui-badge ui-badge--course tutor__tag" style={{ ['--course' as string]: tone ?? 'var(--color-brand)' }}>{conversation.unit || conversation.course}</i> : null}
                            <time dateTime={conversation.updated_at}>{relativeTime(conversation.updated_at, now)}</time>
                          </small>
                        </button>
                        <span className="tutor__list-actions">
                          <button type="button" className={`tutor__list-action${conversation.pinned ? ' is-on' : ''}`} onClick={() => void change(conversation, { pinned: !conversation.pinned }, 'That conversation could not be pinned. Try again.')} aria-label={conversation.pinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`} aria-pressed={Boolean(conversation.pinned)}>
                            <Icon name={conversation.pinned ? 'pinned' : 'pin'} />
                          </button>
                          <button type="button" className="tutor__list-action tutor__list-delete" onClick={() => void remove(conversation)} aria-label={`Delete ${conversation.title}`}>
                            <Icon name="trash" />
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : <p className="tutor__list-empty">{query ? 'No chats match that search.' : 'Your conversations will be saved here.'}</p>}
      </aside>
      {listOpen ? <button type="button" className="tutor__scrim" aria-label="Close conversations" onClick={() => setListOpen(false)} /> : null}

      <section
        className={`tutor__room${dragActive ? ' is-dragging' : ''}`}
        aria-label={active?.title ?? 'New conversation'}
        onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragActive(true) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }}
        onDrop={onDrop}
      >
        <header className="tutor__head">
          <button type="button" className="tutor__list-toggle ui-button ui-button--ghost ui-button--sm" onClick={() => setListOpen(true)} aria-label="Show conversations">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" /></svg>
          </button>
          <div className="tutor__title">
            {renaming !== null && active ? (
              <form className="tutor__rename" onSubmit={submitRename}>
                <input className="ui-input" aria-label="Conversation name" value={renaming} maxLength={80} autoFocus
                  onChange={(event) => setRenaming(event.target.value)} onBlur={submitRename}
                  onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(null) } }} />
              </form>
            ) : (
              <div className="tutor__title-row">
                <h1>{active?.title ?? 'New conversation'}</h1>
                {active ? (
                  <>
                    <button type="button" className="tutor__head-icon" onClick={() => setRenaming(active.title)} aria-label="Rename conversation"><Icon name="edit" /></button>
                    <button type="button" className={`tutor__head-icon${active.pinned ? ' is-on' : ''}`} aria-pressed={Boolean(active.pinned)} onClick={() => void change(active, { pinned: !active.pinned }, 'That conversation could not be pinned. Try again.')} aria-label={active.pinned ? 'Unpin conversation' : 'Pin conversation'}><Icon name={active.pinned ? 'pinned' : 'pin'} /></button>
                  </>
                ) : null}
              </div>
            )}
            <p>{course ? <>Grounded in your notes for <b>{unit || course}</b></> : 'General help · pick a course to use your notes'}</p>
          </div>
          <div className="ui-segmented tutor__mode" role="group" aria-label="Study mode">
            <button type="button" className="ui-segmented__item" aria-pressed={studyMode === 'explain'} onClick={() => chooseMode('explain')}>Explain it</button>
            <button type="button" className="ui-segmented__item" aria-pressed={studyMode === 'guide'} onClick={() => chooseMode('guide')}>Guide me</button>
          </div>
          <div className="tutor__context" role="group" aria-label="Notes Otto should use">
            <select className="ui-select" aria-label="Course" value={course} onChange={(event) => { setCourse(event.target.value); setUnit(notebook.courses.find((item) => item.name === event.target.value)?.units[0] ?? '') }}>
              <option value="">No course</option>
              {notebook.courses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            {course ? (
              <select className="ui-select" aria-label="Unit" value={unit} onChange={(event) => setUnit(event.target.value)}>
                <option value="">Whole course</option>
                {units.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            ) : null}
          </div>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm tutor__personalize" onClick={() => setSheet('talk')} aria-label="Personalize Otto" title="Personalize Otto">
            <Icon name="tune" /><span>Personalize</span>
          </button>
        </header>

        <div className="tutor__scroll" ref={scroller} onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
          <div className="tutor__thread" role="log" aria-live="polite" aria-relevant="additions text">
            {loadingThread === activeId && !thread.length ? (
              <div className="tutor__thread-skeleton" aria-label="Loading conversation"><span className="ui-skeleton is-user" /><span className="ui-skeleton" /><span className="ui-skeleton is-short" /></div>
            ) : !thread.length ? (
              <div className="tutor__welcome">
                <img src={MASCOT} alt="" width="240" height="288" decoding="async" />
                <h2>{greetingName ? <>Hi {greetingName}, I’m Otto</> : <>Hi, I’m Otto</>}</h2>
                <p>What are we working on? {course ? <>Answers use your notes for <b>{unit || course}</b> first.</> : 'Pick a course above and answers will use your own notes.'} {studyMode === 'guide' ? 'Guide me is on, so I’ll give hints instead of answers.' : 'Drop in a photo of a problem if it helps.'}</p>
                {starterList(startersShown)}
              </div>
            ) : thread.map((message, index) => {
              const isReply = message.role === 'assistant'
              const done = isReply && !message.status && Boolean(message.content)
              const smallTalk = message.model_tier === 'small_talk'
              const last = index === lastAssistant
              const sourceCourse = message.groundedIn?.course || active?.course || course
              const sourceUnit = message.groundedIn?.unit || active?.unit || unit
              // A study guide Otto made for this reply ("guide:<id>:<kind>"), shown as a card that opens it in Study.
              const guides = isReply ? message.attachments.map(guideFromAttachment).filter((item) => item !== null) : []
              const files = guides.length ? [] : message.attachments
              return (
                <article key={message.key} className={`tutor-message is-${message.role}${message.status ? ` is-${message.status}` : ''}`}>
                  {isReply ? <img className="tutor-message__avatar" src={MASCOT} alt="" width="32" height="32" decoding="async" loading="lazy" /> : null}
                  <div className="tutor-message__body">
                    {isReply ? <span className="sr-only">Otto said:</span> : null}
                    {message.previews?.length ? (
                      <div className="tutor-message__images">{message.previews.map((src, imageIndex) => <img key={src} src={src} alt={message.attachments[imageIndex] ?? 'Attached image'} width="120" height="120" loading="lazy" decoding="async" />)}</div>
                    ) : files.length ? (
                      <div className="tutor-message__files">{files.map((name) => <span key={name}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /></svg>{name}</span>)}</div>
                    ) : null}
                    {isReply ? (
                      message.content ? <div className="tutor-rich"><Rich text={message.content} />{message.status === 'streaming' ? <span className="tutor-caret" aria-hidden="true" /> : null}</div>
                        : <div className="tutor-thinking" role="status"><span /><span /><span /><span className="sr-only">Otto is thinking</span></div>
                    ) : <p className="tutor-message__text">{message.content}</p>}
                    {guides.map((guide) => {
                      const kind = guideKind(guide.kind)
                      return (
                        <a key={guide.id} className={`guide-card ui-tone--${kind.tone}`} href={guideHash(guide.id)}>
                          <span className="ui-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6M9 11h4" /></svg></span>
                          <span className="guide-card__text">
                            <span className="guide-card__kind">{kind.label}</span>
                            <span className="guide-card__title">Saved in Study{sourceUnit ? ` · ${sourceUnit}` : ''}</span>
                          </span>
                          <span className="guide-card__open">Open<span aria-hidden="true"> →</span></span>
                        </a>
                      )
                    })}
                    {message.status === 'sending' && message.progress !== undefined && message.progress < 1 ? (
                      <div className="tutor-message__progress" role="progressbar" aria-label="Uploading images" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(message.progress * 100)}><i style={{ width: `${Math.round(message.progress * 100)}%` }} /></div>
                    ) : null}
                    {message.status === 'failed' ? (
                      <div className="tutor-message__failed" role="alert">
                        <span>{message.error ?? 'Not sent.'}</span>
                        <button type="button" className="ui-link" onClick={() => send(message.content, [], message.key)}>Retry</button>
                      </div>
                    ) : null}
                    {isReply && !message.status && message.grounded?.length ? (
                      <div className="tutor-message__sources">
                        <span>From your notes</span>
                        {message.grounded.slice(0, 4).map((name) => sourceCourse && sourceUnit ? (
                          <button key={name} type="button" className="tutor-chip" style={{ ['--course' as string]: toneOf(sourceCourse) ?? 'var(--color-brand)' }} onClick={() => openUnit(sourceCourse, sourceUnit)} title={`Open ${sourceUnit} in Study`}>{name}</button>
                        ) : <span key={name} className="tutor-chip">{name}</span>)}
                        {message.grounded.length > 4 ? <span className="tutor-message__more">+{message.grounded.length - 4}</span> : null}
                      </div>
                    ) : null}
                    {message.status === 'stopped' ? <p className="tutor-message__note">Stopped. What Otto wrote so far is kept.</p> : null}
                    {done && smallTalk && last ? starterList(startersShown, 'tutor__suggestions--inline') : null}
                    {done && !smallTalk ? (
                      <div className="tutor-actions" role="group" aria-label="Reply actions">
                        {last && message.model_tier !== 'study_guide' ? FOLLOW_UPS.map((item) => (
                          <button key={item.id} type="button" className="tutor-actions__chip" disabled={streaming} onClick={() => send(item.prompt, [])}>{item.label}</button>
                        )) : null}
                        {last && course && unit && message.id && message.model_tier !== 'study_guide' ? (
                          <button type="button" className="tutor-actions__chip" disabled={streaming || cardState[message.key] === 'making' || cardState[message.key] === 'done'} onClick={() => void makeFlashcards(message)}>
                            <Icon name="cards" />{cardState[message.key] === 'making' ? 'Making flashcards…' : cardState[message.key] === 'done' ? 'Flashcards saved' : 'Make flashcards'}
                          </button>
                        ) : null}
                        <span className="tutor-actions__tools">
                          <button type="button" className="tutor-actions__icon" onClick={() => void copy(message)} aria-label={copied === message.key ? 'Copied' : 'Copy reply'} title="Copy"><Icon name="copy" /></button>
                          {copied === message.key ? <span className="tutor-actions__flash" role="status">Copied</span> : null}
                          {canSpeak ? <button type="button" className={`tutor-actions__icon${speaking === message.key ? ' is-on' : ''}`} onClick={() => readAloud(message)} aria-label={speaking === message.key ? 'Stop reading aloud' : 'Read aloud'} aria-pressed={speaking === message.key} title="Read aloud"><Icon name={speaking === message.key ? 'stop' : 'speak'} /></button> : null}
                          {message.id ? (
                            <>
                              <button type="button" className={`tutor-actions__icon${message.rating === 1 ? ' is-on' : ''}`} onClick={() => void rate(message, 1)} aria-label="Good reply" aria-pressed={message.rating === 1} title="Good reply"><Icon name="up" /></button>
                              <button type="button" className={`tutor-actions__icon${message.rating === -1 ? ' is-on' : ''}`} onClick={() => void rate(message, -1)} aria-label="Bad reply" aria-pressed={message.rating === -1} title="Bad reply"><Icon name="down" /></button>
                            </>
                          ) : null}
                          {last && message.id && activeId !== NEW ? <button type="button" className="tutor-actions__icon" disabled={streaming} onClick={() => send(thread[index - 1]?.content || 'Answer again', [], undefined, { regenerate: true })} aria-label="Regenerate reply" title="Regenerate"><Icon name="regen" /></button> : null}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        <form className="tutor__composer" onSubmit={submit}>
          {attachments.length ? (
            <ul className="tutor__attachments" aria-label="Attached images">
              {attachments.map((item) => (
                <li key={item.id} className={`is-${item.state}`}>
                  <img src={item.preview} alt="" width="40" height="40" />
                  <span><b>{item.name}</b><small>{item.state === 'preparing' ? 'Preparing…' : item.state === 'failed' ? item.error : `${Math.max(1, Math.round((item.size ?? 0) / 1024))} KB`}</small></span>
                  <button type="button" onClick={() => removeAttachment(item.id)} aria-label={`Remove ${item.name}`}>×</button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="tutor__input">
            <textarea
              ref={textarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onFocus={warmAI}
              placeholder={listening ? 'Listening…' : course ? `Ask about ${unit || course}…` : 'Ask Otto anything…'}
              aria-label="Message Otto"
              enterKeyHint="send"
              autoCapitalize="sentences"
              rows={1}
              maxLength={4000}
            />
            <div className="tutor__tools">
              <button type="button" className="tutor__tool" onClick={() => fileInput.current?.click()} aria-label="Attach images" disabled={attachments.length >= MAX_IMAGES}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 11-7.5 7.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L10.2 16a1.7 1.7 0 0 1-2.4-2.4L14.5 7" /></svg>
              </button>
              <button type="button" className="tutor__tool tutor__camera" onClick={() => cameraInput.current?.click()} aria-label="Take a photo" disabled={attachments.length >= MAX_IMAGES}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
              </button>
              {Recognition ? (
                <button type="button" className={`tutor__tool${listening ? ' is-listening' : ''}`} onClick={toggleDictation} aria-label={listening ? 'Stop dictation' : 'Dictate a message'} aria-pressed={listening} title="Dictate (uses your browser’s speech recognition)">
                  <Icon name="mic" />
                </button>
              ) : null}
              <span className="tutor__hint">Enter to send · Shift+Enter for a new line</span>
              {streaming ? (
                <button type="button" className="tutor__send is-stop" onClick={stop} aria-label="Stop generating"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg></button>
              ) : (
                <button type="submit" className="tutor__send" disabled={!draft.trim() && !attachments.some((item) => item.state === 'ready')} aria-label="Send">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
                </button>
              )}
            </div>
          </div>
          <input ref={fileInput} className="ui-file-input" type="file" accept={ACCEPTED.join(',')} multiple onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
          <input ref={cameraInput} className="ui-file-input" type="file" accept="image/*" capture="environment" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
        </form>
        {dragActive ? <div className="tutor__drop" aria-hidden="true"><span>Drop images to attach</span></div> : null}
        {memoryNotice ? (
          <p className="app-toast otto-notice" role="status">
            Otto saved a note about you ·
            <button type="button" className="ui-link" onClick={() => { setMemoryNotice(false); setSheet('memory') }}>Manage</button>
            <button type="button" onClick={() => setMemoryNotice(false)} aria-label="Dismiss">×</button>
          </p>
        ) : notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      </section>
      {sheet && token ? (
        <OttoSheet token={token} tab={sheet} defaultName={displayName} onClose={() => setSheet(null)} onSaved={(profile) => setOttoName(profile.preferred_name)} />
      ) : null}
    </div>
  )
}
