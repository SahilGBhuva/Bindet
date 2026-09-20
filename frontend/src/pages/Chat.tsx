import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent } from 'react'
import { getStudyGroups, type StudyGroup } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import {
  deleteGroupImage, getGroupImageUrl, listGroupMessages, sendGroupMessage,
  subscribeToGroupMessages, uploadGroupImage, type ChatMessage,
} from '../lib/chat'
import './Chat.css'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function PaperclipIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.4-9.4a4 4 0 0 1 5.7 5.7l-9.4 9.4a2 2 0 0 1-2.8-2.8l8.7-8.7" /></svg>
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 14-8-4.5 16-3-6.5L5 12Z" /><path d="m11.5 13.5 3.2-3.2" /></svg>
}

function ImageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m21 16-4.5-4.5L8 20" /></svg>
}

function MessageImage({ message, session }: { message: ChatMessage; session: AuthSession }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!message.attachment_path) return
    let cancelled = false
    void getGroupImageUrl(message.attachment_path, session)
      .then((next) => { if (!cancelled) setUrl(next) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [message.attachment_path, session])
  if (failed) return <div className="chat-image-failed"><ImageIcon /><span>Image unavailable</span></div>
  if (!url) return <div className="chat-image-loading" aria-label="Loading image"><span /></div>
  return <a className="chat-message__image" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${message.attachment_name || 'shared image'}`}><img src={url} alt={message.attachment_name || 'Shared image'} loading="lazy" decoding="async" /><span>Open image</span></a>
}

function formatFileSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function validateImage(file: File) {
  if (!IMAGE_TYPES.has(file.type)) return 'Choose a JPG, PNG, WebP, or GIF image.'
  if (file.size > MAX_IMAGE_BYTES) return 'That image is over 10 MB. Choose a smaller file.'
  return ''
}

export function Chat({ session }: { session: AuthSession | null }) {
  const [groups, setGroups] = useState<StudyGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepth = useRef(0)
  const activeGroup = useMemo(() => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null, [groups, activeGroupId])

  useEffect(() => {
    if (!session) { setLoading(false); return }
    setLoading(true)
    void getStudyGroups(session.access_token, true)
      .then((next) => { setGroups(next); setActiveGroupId((current) => current || next[0]?.id || '') })
      .catch(() => setStatus('Could not load your study groups.'))
      .finally(() => setLoading(false))
  }, [session])

  useEffect(() => {
    if (!session || !activeGroup) { setMessages([]); return }
    let stop = () => {}
    let cancelled = false
    setStatus('')
    void listGroupMessages(activeGroup.id, session)
      .then((rows) => { if (!cancelled) setMessages(rows) })
      .catch((error) => { if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load this chat.') })
    void subscribeToGroupMessages(activeGroup.id, session, (message) => setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]))
      .then((unsubscribe) => { if (cancelled) unsubscribe(); else stop = unsubscribe })
    return () => { cancelled = true; stop() }
  }, [session, activeGroup?.id])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: messages.length > 1 ? 'smooth' : 'auto' }) }, [messages.length, activeGroupId])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  function chooseImage(file: File | undefined) {
    if (!file) return
    const error = validateImage(file)
    if (error) { setStatus(error); return }
    setAttachment(file)
    setPreviewUrl(URL.createObjectURL(file))
    setUploadProgress(0)
    setStatus('')
  }

  function clearAttachment() {
    setAttachment(null); setPreviewUrl(''); setUploadProgress(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function onDragEnter(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault(); dragDepth.current += 1; setDragging(true)
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault(); dragDepth.current -= 1
    if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false)
    chooseImage(Array.from(event.dataTransfer.files).find((file) => file.type.startsWith('image/')))
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))?.getAsFile()
    if (image) chooseImage(image)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!session || !activeGroup || (!draft.trim() && !attachment) || sending) return
    const body = draft.trim()
    let uploadedPath = ''
    setSending(true); setStatus('')
    try {
      const uploaded = attachment ? await uploadGroupImage(activeGroup.id, attachment, session, setUploadProgress) : undefined
      uploadedPath = uploaded?.path ?? ''
      const message = await sendGroupMessage(activeGroup.id, body, session, uploaded)
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
      setDraft(''); clearAttachment()
    } catch (error) {
      if (uploadedPath) void deleteGroupImage(uploadedPath, session)
      setUploadProgress(0)
      setStatus(error instanceof Error ? error.message : 'Could not send that message.')
    } finally { setSending(false) }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
  }

  if (!session) return <section className="chat-page chat-empty"><h1>Study chat</h1><p>Sign in to message your study groups.</p><a href="#settings">Open settings</a></section>
  if (loading) return <section className="chat-page chat-empty"><div className="chat-loader" /><p>Opening your chats…</p></section>
  if (!groups.length) return <section className="chat-page chat-empty"><h1>No chats yet</h1><p>Create or join a study group first. Each group gets its own private chat.</p><a href="#profile">Go to study groups</a></section>

  return (
    <section className={`chat-page ${dragging ? 'is-dragging' : ''}`} aria-label="Study group chat" onDragEnter={onDragEnter} onDragOver={(event) => event.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
      <aside className="chat-list">
        <div className="chat-list__heading"><span className="chat-list__eyebrow">Workspace</span><h1>Messages</h1><p>{groups.length} active group{groups.length === 1 ? '' : 's'}</p></div>
        <div className="chat-list__groups">
          {groups.map((group, index) => <button key={group.id} className={group.id === activeGroup?.id ? 'is-active' : ''} onClick={() => setActiveGroupId(group.id)}><span className={`chat-group-mark tone-${index % 4}`}>{group.name.slice(0, 1).toUpperCase()}<i /></span><span><strong>{group.name}</strong><small>{group.members.length} member{group.members.length === 1 ? '' : 's'}</small></span><i className="chat-list__chevron">›</i></button>)}
        </div>
        <div className="chat-list__privacy"><span>⌁</span><div><strong>Private by default</strong><small>Only group members can see these messages and images.</small></div></div>
      </aside>

      <div className="chat-room">
        <header className="chat-room__header">
          <div className="chat-room__identity"><span className="chat-room__mark">{activeGroup?.name.slice(0, 1).toUpperCase()}</span><div><div className="chat-room__title"><h2>{activeGroup?.name}</h2><span><i /> Active</span></div><p>{activeGroup?.description || 'Study together in real time.'}</p></div></div>
          <div className="chat-room__members" aria-label={`${activeGroup?.members.length || 0} group members`}>{activeGroup?.members.slice(0, 4).map((member) => <span key={member.student_id} title={member.display_name}>{member.display_name.slice(0, 1).toUpperCase()}</span>)}{(activeGroup?.members.length || 0) > 4 ? <b>+{(activeGroup?.members.length || 0) - 4}</b> : null}<a href="#profile">Details</a></div>
        </header>

        <div className="chat-messages" aria-live="polite">
          <div className="chat-day"><span>Today</span></div>
          {!messages.length ? <div className="chat-first"><span>✦</span><h3>This is the beginning</h3><p>Share a question, drop in a diagram, or plan your next study session.</p><button type="button" onClick={() => fileInputRef.current?.click()}><PaperclipIcon /> Share an image</button></div> : null}
          {messages.map((message, index) => {
            const own = message.sender_id === session.user.id
            const previous = messages[index - 1]
            const grouped = previous?.sender_id === message.sender_id && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60 * 1000
            const member = activeGroup?.members.find((item) => item.student_id === message.sender_id)
            const name = own ? 'You' : message.sender?.display_name || member?.display_name || 'Group member'
            return <article key={message.id} className={`chat-message ${own ? 'is-own' : ''} ${grouped ? 'is-grouped' : ''}`}>{!grouped ? <div className="chat-avatar">{name.slice(0, 1).toUpperCase()}</div> : <div className="chat-avatar is-spacer" />}<div className="chat-message__content">{!grouped ? <p><strong>{name}</strong><time>{new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></p> : null}<div className={`chat-bubble ${message.attachment_path ? 'has-image' : ''}`}>{message.attachment_path ? <MessageImage message={message} session={session} /> : null}{message.body ? <span>{message.body}</span> : null}</div></div></article>
          })}
          <div ref={bottomRef} />
        </div>

        <div className="chat-compose-wrap">
          {attachment ? <div className="chat-attachment-preview"><img src={previewUrl} alt="Attachment preview" /><div><strong>{attachment.name}</strong><span>{formatFileSize(attachment.size)} · Ready to send</span></div>{sending ? <div className="chat-upload-progress" aria-label={`Uploading ${uploadProgress}%`}><i style={{ width: `${uploadProgress}%` }} /></div> : <button type="button" onClick={clearAttachment} aria-label="Remove image">×</button>}</div> : null}
          <form className="chat-composer" onSubmit={submit}>
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event: ChangeEvent<HTMLInputElement>) => chooseImage(event.target.files?.[0])} hidden />
            <button className="chat-attach" type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach an image" title="Attach an image"><PaperclipIcon /></button>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={onPaste} placeholder={activeGroup ? `Message ${activeGroup.name}` : 'Message'} maxLength={2000} rows={1} onKeyDown={onComposerKeyDown} />
            <span className="chat-composer__hint">Drop, paste, or attach a photo</span>
            <button className="chat-send" disabled={(!draft.trim() && !attachment) || sending} aria-label={sending ? 'Sending message' : 'Send message'}>{sending ? <i /> : <SendIcon />}</button>
          </form>
          {status ? <p className="chat-status" role="status">{status}</p> : null}
        </div>
        {dragging ? <div className="chat-drop-overlay"><div><ImageIcon /><strong>Drop your image here</strong><span>JPG, PNG, WebP, or GIF · up to 10 MB</span></div></div> : null}
      </div>
    </section>
  )
}
