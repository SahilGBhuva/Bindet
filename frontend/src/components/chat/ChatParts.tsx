import { useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../../lib/auth'
import { getGroupImageUrl, isSafeAttachmentPath, type ChatMessage } from '../../lib/chat'
import { linkify } from '../../lib/chatView'
import { courseInitial, toneClass, toneForName } from '../../lib/tones'
import { cachedImageUrl, rememberSignedUrl } from './chatImageCache'
import { ChatIcon } from './chatIcons'

/* A person: their initial on their own stable color. */
export function PersonAvatar({ name, size = 'md', className = '' }: { name: string; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  return <span className={`chat-avatar chat-avatar--${size} ${toneClass(toneForName(name))} ${className}`.trim()} aria-hidden="true">{courseInitial(name)}</span>
}

/* A group: its initial on a soft gradient of the group's color. */
export function GroupAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return <span className={`chat-group-avatar chat-group-avatar--${size} ${toneClass(toneForName(name))}`} aria-hidden="true">{courseInitial(name)}</span>
}

/* Message text with http(s) links that open in a new tab. */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, index) => part.kind === 'link'
        ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.text}</a>
        : <span key={index}>{part.text}</span>)}
    </>
  )
}

export type OpenImage = { url: string; name: string; from?: HTMLElement }

/* Signs and loads a shared image only when it comes near the screen, and remembers the link. */
export function MessageImage({ message, session, onOpen }: { message: ChatMessage; session: AuthSession; onOpen: (image: OpenImage) => void }) {
  // A path outside the sender's folder is never signed or fetched.
  const { group_id: groupId, sender_id: senderId } = message
  const safe = isSafeAttachmentPath(message.attachment_path, { group_id: groupId, sender_id: senderId })
  const path = safe ? message.attachment_path ?? '' : ''
  const name = message.attachment_name || 'Shared image'
  const [url, setUrl] = useState(() => cachedImageUrl(path))
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
        rememberSignedUrl(path, next)
        if (live) setUrl(next)
      })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [near, url, path, groupId, senderId, session, attempt])

  if (!safe || failed) {
    return (
      <div className="chat-photo is-failed">
        {ChatIcon.image}
        <span>Image unavailable</span>
        {safe ? <button type="button" className="ui-link" onClick={() => { setFailed(false); setAttempt((value) => value + 1) }}>Try again</button> : null}
      </div>
    )
  }
  if (!url) return <div ref={holder} className="chat-photo is-loading ui-skeleton" role="img" aria-label={`Loading ${name}`} />
  return (
    <button type="button" className="chat-photo" onClick={(event) => onOpen({ url, name, from: event.currentTarget })} aria-label={`View ${name}`}>
      <img src={url} alt={name} width="280" height="210" loading="lazy" decoding="async" />
    </button>
  )
}

/* A full-screen look at one image. The native modal dialog traps focus and closes on Escape. */
export function ImageLightbox({ image, onClose }: { image: OpenImage; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  // No close() on cleanup: that fires "close" (and onClose) again; unmounting removes the dialog anyway.
  useEffect(() => {
    const node = dialog.current
    if (!node || node.open) return
    try { node.showModal() } catch { node.setAttribute('open', '') }
    node.querySelector<HTMLElement>('.chat-lightbox__close')?.focus()
  }, [])
  // Focus goes back to the photo that opened it.
  useEffect(() => () => { if (image.from?.isConnected) image.from.focus({ preventScroll: true }) }, [image.from])
  return (
    <dialog
      ref={dialog}
      className="chat-lightbox"
      aria-label={image.name}
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="chat-lightbox__bar">
        <span>{image.name}</span>
        <a className="chat-lightbox__button" href={image.url} target="_blank" rel="noopener noreferrer" aria-label="Open original in a new tab">{ChatIcon.external}</a>
        <button type="button" className="chat-lightbox__button chat-lightbox__close" onClick={onClose} aria-label="Close image">{ChatIcon.close}</button>
      </div>
      <img src={image.url} alt={image.name} onClick={onClose} />
    </dialog>
  )
}
