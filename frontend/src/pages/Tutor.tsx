import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  deleteTutorConversation, getCachedTutorConversations, getCachedTutorMessages, getTutorConversations, getTutorMessages,
  parseServerTime, prepareTutorImage, setCachedTutorConversations, setCachedTutorMessages, streamTutorMessage,
  type TutorConversation, type TutorMessage,
} from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { withCourseTones } from '../lib/session'
import './Tutor.css'

/*
 * The tutor. The shell renders at once from cache; history loads behind it.
 * A sent message appears immediately, the reply streams in as tokens arrive,
 * and nothing here waits on anything it does not need.
 */

type Attachment = { id: string; name: string; preview: string; dataUrl?: string; size?: number; state: 'preparing' | 'ready' | 'failed'; error?: string }
type LocalMessage = TutorMessage & { key: string; status?: 'sending' | 'streaming' | 'failed' | 'stopped'; previews?: string[]; progress?: number; error?: string; tier?: string; grounded?: string[] }

const NEW = 'new'
const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function toLocal(message: TutorMessage): LocalMessage {
  return { ...message, key: `m-${message.id}` }
}

/* A small, safe renderer for the tutor's plain-text formatting: paragraphs, lists, code, bold and italics. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key}>{part.slice(1, -1)}</em>
    return <Fragment key={key}>{part}</Fragment>
  })
}

function Rich({ text }: { text: string }) {
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
    while (index < lines.length && lines[index].trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[index]) && !lines[index].trim().startsWith('```') && !/^#{1,4}\s/.test(lines[index])) { paragraph.push(lines[index]); index += 1 }
    blocks.push(<p key={`b${blocks.length}`}>{paragraph.map((part, partIndex) => <Fragment key={partIndex}>{partIndex ? <br /> : null}{inline(part, `p${blocks.length}-${partIndex}`)}</Fragment>)}</p>)
  }
  return <>{blocks}</>
}

function readLastConversation(): string {
  try { return sessionStorage.getItem('bindit:tutor:active') || NEW } catch { return NEW }
}

export function Tutor({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const data = useData()
  const notebook = useMemo(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  }, [data])
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
  const [dragActive, setDragActive] = useState(false)
  const [notice, setNotice] = useState('')
  const stopRef = useRef<(() => void) | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)

  const thread = threads[activeId] ?? []
  const active = conversations?.find((item) => item.id === activeId) ?? null
  const streaming = thread.some((message) => message.status === 'streaming' || message.status === 'sending')
  const units = notebook.courses.find((item) => item.name === course)?.units ?? []

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
        return { ...current, [activeId]: [...items.map(toLocal), ...inFlight] }
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

  // Follow the reply as it streams, unless the student has scrolled up to read.
  useEffect(() => {
    const node = scroller.current
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [threads, activeId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => () => stopRef.current?.(), [])

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
    if (!list.length) { setNotice('Only images can be attached to the tutor.'); return }
    setAttachments((current) => {
      const room = MAX_IMAGES - current.length
      if (room <= 0) { setNotice(`You can attach up to ${MAX_IMAGES} images.`); return current }
      const next = list.slice(0, room).map((file) => {
        const attachment: Attachment = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: file.name || 'image', preview: URL.createObjectURL(file), state: 'preparing' }
        if (!ACCEPTED.includes(file.type)) return { ...attachment, state: 'failed' as const, error: 'Use JPG, PNG, WebP, or GIF' }
        void prepareTutorImage(file).then((prepared) => {
          setAttachments((items) => items.map((item) => item.id === attachment.id
            ? prepared.size > MAX_IMAGE_BYTES ? { ...item, state: 'failed', error: 'Larger than 5 MB' } : { ...item, state: 'ready', dataUrl: prepared.dataUrl, size: prepared.size }
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

  function send(content: string, images: Attachment[], retryKey?: string) {
    if (!token || !content.trim() || streaming) return
    const threadId = activeId
    const stamp = new Date().toISOString()
    const userKey = retryKey ?? `local-${Date.now()}`
    const replyKey = `reply-${Date.now()}`
    const ready = images.filter((item) => item.state === 'ready' && item.dataUrl)
    const userMessage: LocalMessage = { id: 0, key: userKey, role: 'user', content, attachments: ready.map((item) => item.name), model_tier: '', created_at: stamp, status: 'sending', previews: ready.map((item) => item.preview), progress: ready.length ? 0 : undefined }
    const reply: LocalMessage = { id: 0, key: replyKey, role: 'assistant', content: '', attachments: [], model_tier: '', created_at: stamp, status: 'streaming' }
    stickToBottom.current = true
    setThreads((current) => {
      const existing = (current[threadId] ?? []).filter((message) => message.key !== userKey)
      return { ...current, [threadId]: [...existing, userMessage, reply] }
    })
    let liveThread = threadId
    stopRef.current = streamTutorMessage(token, {
      conversation_id: threadId === NEW ? undefined : threadId,
      content,
      course: course || undefined,
      unit: unit || undefined,
      images: ready.map((item) => ({ name: item.name, data_url: item.dataUrl! })),
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
        updateMessage(liveThread, userKey, (message) => ({ ...message, ...meta.user_message, key: userKey, status: undefined, progress: undefined }))
        updateMessage(liveThread, replyKey, (message) => ({ ...message, tier: meta.tier, grounded: meta.grounded_in }))
      },
      onDelta: (text) => updateMessage(liveThread, replyKey, (message) => ({ ...message, content: message.content + text })),
      onDone: ({ message: saved }) => {
        updateMessage(liveThread, replyKey, (message) => ({ ...message, ...saved, key: replyKey, status: undefined }))
        stopRef.current = null
        setThreads((current) => { if (token && liveThread !== NEW) setCachedTutorMessages(token, liveThread, (current[liveThread] ?? []).filter((item) => !item.status)); return current })
      },
      onError: (error) => {
        stopRef.current = null
        setThreads((current) => ({
          ...current,
          [liveThread]: (current[liveThread] ?? []).flatMap((message) => {
            if (message.key === replyKey) return message.content ? [{ ...message, status: undefined }] : []
            if (message.key === userKey && message.status) return [{ ...message, status: 'failed' as const, error, progress: undefined }]
            return [message]
          }),
        }))
      },
    })
  }

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
    const content = draft.trim() || (attachments.length ? 'What can you tell me about this?' : '')
    if (!content) return
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
    setThreads((current) => ({ ...current, [NEW]: [] }))
    setListOpen(false)
    window.setTimeout(() => textarea.current?.focus(), 0)
  }

  function open(conversation: TutorConversation) {
    if (conversation.id === activeId) { setListOpen(false); return }
    stop()
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

  const suggestions = unit
    ? [`Explain ${unit} like I'm seeing it for the first time`, `Quiz me with three questions on ${unit}`, `What are the most common mistakes in ${unit}?`]
    : ['Help me make a study plan for this week', 'Explain a concept step by step', 'Check my understanding with a few questions']

  return (
    <div className={`tutor${listOpen ? ' is-list-open' : ''}`}>
      <aside className="tutor__list" aria-label="Conversations">
        <div className="tutor__list-head">
          <span className="ui-eyebrow">Tutor</span>
          <button type="button" className="ui-button ui-button--sm" onClick={newConversation}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New
          </button>
        </div>
        {conversations === null ? (
          <div className="tutor__list-skeleton">{[0, 1, 2, 3].map((item) => <span key={item} className="ui-skeleton" />)}</div>
        ) : conversations.length ? (
          <ul>
            {conversations.map((conversation) => (
              <li key={conversation.id} className={conversation.id === activeId ? 'is-active' : ''}>
                <button type="button" className="tutor__list-item" onClick={() => open(conversation)} aria-current={conversation.id === activeId ? 'true' : undefined}>
                  <span>{conversation.title}</span>
                  <small>{conversation.unit || conversation.course || 'General'} · {dayFormat.format(new Date(parseServerTime(conversation.updated_at)))}</small>
                </button>
                <button type="button" className="tutor__list-delete" onClick={() => void remove(conversation)} aria-label={`Delete ${conversation.title}`}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M10 7V5h4v2M8 7l1 12h6l1-12" /></svg>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="tutor__list-empty">Your conversations will be saved here.</p>}
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
            <h1>{active?.title ?? 'New conversation'}</h1>
            <p>{course ? <>Grounded in your notes for <b>{unit || course}</b></> : 'General help · pick a course to use your notes'}</p>
          </div>
          <div className="tutor__context" role="group" aria-label="Notes the tutor should use">
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
        </header>

        <div className="tutor__scroll" ref={scroller} onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }}>
          <div className="tutor__thread" role="log" aria-live="polite" aria-relevant="additions text">
            {loadingThread === activeId && !thread.length ? (
              <div className="tutor__thread-skeleton" aria-label="Loading conversation"><span className="ui-skeleton is-user" /><span className="ui-skeleton" /><span className="ui-skeleton is-short" /></div>
            ) : !thread.length ? (
              <div className="tutor__welcome">
                <img src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
                <h2>What are we working on?</h2>
                <p>Ask anything. {course ? <>Answers use your notes for <b>{unit || course}</b> first.</> : 'Pick a course above and answers will use your own notes.'} Drop in a photo of a problem or a diagram if it helps.</p>
                <div className="tutor__suggestions">
                  {suggestions.map((text) => <button key={text} type="button" onClick={() => send(text, [])}>{text}<span aria-hidden="true">→</span></button>)}
                </div>
              </div>
            ) : thread.map((message) => (
              <article key={message.key} className={`tutor-message is-${message.role}${message.status ? ` is-${message.status}` : ''}`}>
                {message.role === 'assistant' ? <span className="tutor-message__mark" aria-hidden="true" /> : null}
                <div className="tutor-message__body">
                  {message.previews?.length ? (
                    <div className="tutor-message__images">{message.previews.map((src, index) => <img key={src} src={src} alt={message.attachments[index] ?? 'Attached image'} />)}</div>
                  ) : message.attachments.length ? (
                    <div className="tutor-message__files">{message.attachments.map((name) => <span key={name}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /></svg>{name}</span>)}</div>
                  ) : null}
                  {message.role === 'assistant' ? (
                    message.content ? <div className="tutor-rich"><Rich text={message.content} />{message.status === 'streaming' ? <span className="tutor-caret" aria-hidden="true" /> : null}</div>
                      : <div className="tutor-thinking" role="status"><span /><span /><span /><span className="sr-only">The tutor is thinking</span></div>
                  ) : <p className="tutor-message__text">{message.content}</p>}
                  {message.status === 'sending' && message.progress !== undefined && message.progress < 1 ? (
                    <div className="tutor-message__progress" role="progressbar" aria-label="Uploading images" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(message.progress * 100)}><i style={{ width: `${Math.round(message.progress * 100)}%` }} /></div>
                  ) : null}
                  {message.status === 'failed' ? (
                    <div className="tutor-message__failed" role="alert">
                      <span>{message.error ?? 'Not sent.'}</span>
                      <button type="button" className="ui-link" onClick={() => send(message.content, [], message.key)}>Retry</button>
                    </div>
                  ) : null}
                  {message.role === 'assistant' && !message.status && message.grounded?.length ? <p className="tutor-message__sources">From your notes: {message.grounded.slice(0, 3).join(', ')}{message.grounded.length > 3 ? ` +${message.grounded.length - 3}` : ''}</p> : null}
                  {message.status === 'stopped' ? <p className="tutor-message__sources">Stopped.</p> : null}
                </div>
              </article>
            ))}
          </div>
        </div>

        <form className="tutor__composer" onSubmit={submit}>
          {attachments.length ? (
            <ul className="tutor__attachments" aria-label="Attached images">
              {attachments.map((item) => (
                <li key={item.id} className={`is-${item.state}`}>
                  <img src={item.preview} alt="" />
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
              placeholder={course ? `Ask about ${unit || course}…` : 'Ask the tutor anything…'}
              aria-label="Message the tutor"
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
              <span className="tutor__hint">Enter to send · Shift+Enter for a new line</span>
              {streaming ? (
                <button type="button" className="tutor__send is-stop" onClick={stop} aria-label="Stop the reply"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg></button>
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
        {notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
      </section>
    </div>
  )
}
