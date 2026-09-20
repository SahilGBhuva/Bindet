import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getStudyGroups, type StudyGroup } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { listGroupMessages, sendGroupMessage, subscribeToGroupMessages, type ChatMessage } from '../lib/chat'
import './Chat.css'

export function Chat({ session }: { session: AuthSession | null }) {
  const [groups, setGroups] = useState<StudyGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  )

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    setLoading(true)
    void getStudyGroups(session.access_token, true)
      .then((next) => {
        setGroups(next)
        setActiveGroupId((current) => current || next[0]?.id || '')
      })
      .catch(() => setStatus('Could not load your study groups.'))
      .finally(() => setLoading(false))
  }, [session])

  useEffect(() => {
    if (!session || !activeGroup) {
      setMessages([])
      return
    }
    let stop = () => {}
    let cancelled = false
    setStatus('')
    void listGroupMessages(activeGroup.id, session)
      .then((rows) => {
        if (!cancelled) setMessages(rows)
      })
      .catch((error) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load this chat.')
      })
    void subscribeToGroupMessages(activeGroup.id, session, (message) => {
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
    }).then((unsubscribe) => {
      if (cancelled) unsubscribe()
      else stop = unsubscribe
    })
    return () => {
      cancelled = true
      stop()
    }
  }, [session, activeGroup?.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, activeGroupId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!session || !activeGroup || !draft.trim()) return
    const body = draft.trim()
    setDraft('')
    setStatus('')
    try {
      const message = await sendGroupMessage(activeGroup.id, body, session)
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
    } catch (error) {
      setDraft(body)
      setStatus(error instanceof Error ? error.message : 'Could not send that message.')
    }
  }

  if (!session) {
    return <section className="chat-page chat-empty"><h1>Study chat</h1><p>Sign in to message your study groups.</p><a href="#settings">Open settings</a></section>
  }

  if (loading) return <section className="chat-page chat-empty"><p>Loading chats…</p></section>

  if (!groups.length) {
    return <section className="chat-page chat-empty"><h1>No chats yet</h1><p>Create or join a study group first. Each group gets its own private chat.</p><a href="#profile">Go to study groups</a></section>
  }

  return (
    <section className="chat-page" aria-label="Study group chat">
      <aside className="chat-list">
        <div className="chat-list__heading"><p>Messages</p><h1>Study chat</h1></div>
        <div className="chat-list__groups">
          {groups.map((group) => (
            <button key={group.id} className={group.id === activeGroup?.id ? 'is-active' : ''} onClick={() => setActiveGroupId(group.id)}>
              <span>{group.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{group.name}</strong><small>{group.members.length} member{group.members.length === 1 ? '' : 's'}</small></span>
            </button>
          ))}
        </div>
      </aside>

      <div className="chat-room">
        <header className="chat-room__header">
          <div><p>Private group</p><h2>{activeGroup?.name}</h2><span>{activeGroup?.description || 'Study together in real time.'}</span></div>
          <a href="#profile">Group details</a>
        </header>

        <div className="chat-messages" aria-live="polite">
          {!messages.length ? <div className="chat-first"><span>✦</span><h3>Start the conversation</h3><p>Share a question, goal, or quick update with your group.</p></div> : null}
          {messages.map((message, index) => {
            const own = message.sender_id === session.user.id
            const previous = messages[index - 1]
            const grouped = previous?.sender_id === message.sender_id
            const member = activeGroup?.members.find((item) => item.student_id === message.sender_id)
            const name = own ? 'You' : message.sender?.display_name || member?.display_name || 'Group member'
            return (
              <article key={message.id} className={`chat-message ${own ? 'is-own' : ''} ${grouped ? 'is-grouped' : ''}`}>
                {!grouped ? <div className="chat-avatar">{name.slice(0, 1).toUpperCase()}</div> : <div className="chat-avatar is-spacer" />}
                <div>
                  {!grouped ? <p><strong>{name}</strong><time>{new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></p> : null}
                  <span>{message.body}</span>
                </div>
              </article>
            )
          })}
          <div ref={bottomRef} />
        </div>

        <form className="chat-composer" onSubmit={submit}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={activeGroup ? `Message ${activeGroup.name}` : 'Message'} maxLength={2000} rows={1} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }} />
          <button disabled={!draft.trim()} aria-label="Send message">↑</button>
        </form>
        {status ? <p className="chat-status" role="status">{status}</p> : null}
      </div>
    </section>
  )
}
