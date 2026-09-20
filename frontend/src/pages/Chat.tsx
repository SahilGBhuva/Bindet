import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { getStudyGroups, type StudyGroup } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { listGroupMessages, sendGroupMessage, subscribeToGroupMessages, type ChatMessage } from '../lib/chat'
import './Chat.css'

type Density = 'cozy' | 'compact'
type ChatTheme = 'midnight' | 'soft'

const ACCENTS = ['#7c6cff', '#4f9cff', '#20b486', '#f59e42', '#ec5f8f']

export function Chat({ session }: { session: AuthSession | null }) {
  const [groups, setGroups] = useState<StudyGroup[]>([])
  const [activeGroupId, setActiveGroupId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('bindit-chat-density') as Density) || 'cozy')
  const [theme, setTheme] = useState<ChatTheme>(() => (localStorage.getItem('bindit-chat-theme') as ChatTheme) || 'midnight')
  const [accent, setAccent] = useState(() => localStorage.getItem('bindit-chat-accent') || ACCENTS[0])
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [groups, activeGroupId],
  )

  useEffect(() => { localStorage.setItem('bindit-chat-density', density) }, [density])
  useEffect(() => { localStorage.setItem('bindit-chat-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('bindit-chat-accent', accent) }, [accent])

  useEffect(() => {
    if (!session) { setLoading(false); return }
    const cached = sessionStorage.getItem('bindit-study-groups')
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as StudyGroup[]
        if (parsed.length) {
          setGroups(parsed)
          setActiveGroupId((current) => current || parsed[0]?.id || '')
          setLoading(false)
        }
      } catch {}
    }
    void getStudyGroups(session.access_token, true)
      .then((next) => {
        setGroups(next)
        sessionStorage.setItem('bindit-study-groups', JSON.stringify(next))
        setActiveGroupId((current) => current || next[0]?.id || '')
      })
      .catch(() => setStatus('Could not load your study groups.'))
      .finally(() => setLoading(false))
  }, [session])

  useEffect(() => {
    if (!session || !activeGroup) { setMessages([]); return }
    let stop = () => {}
    let cancelled = false
    const cacheKey = `bindit-chat-${activeGroup.id}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      try { setMessages(JSON.parse(cached) as ChatMessage[]) } catch {}
    } else {
      setMessages([])
      setMessagesLoading(true)
    }
    setStatus('')

    const load = listGroupMessages(activeGroup.id, session)
      .then((rows) => {
        if (cancelled) return
        setMessages(rows)
        sessionStorage.setItem(cacheKey, JSON.stringify(rows))
      })
      .catch((error) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load this chat.')
      })
      .finally(() => { if (!cancelled) setMessagesLoading(false) })

    void subscribeToGroupMessages(activeGroup.id, session, (message) => {
      setMessages((current) => {
        const next = current.some((item) => item.id === message.id) ? current : [...current, message]
        sessionStorage.setItem(cacheKey, JSON.stringify(next.slice(-200)))
        return next
      })
    }).then((unsubscribe) => { if (cancelled) unsubscribe(); else stop = unsubscribe })

    void load
    return () => { cancelled = true; stop() }
  }, [session, activeGroup?.id])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, activeGroupId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!session || !activeGroup || !draft.trim()) return
    const body = draft.trim()
    setDraft('')
    setStatus('')
    try {
      const message = await sendGroupMessage(activeGroup.id, body, session)
      setMessages((current) => {
        const next = current.some((item) => item.id === message.id) ? current : [...current, message]
        sessionStorage.setItem(`bindit-chat-${activeGroup.id}`, JSON.stringify(next.slice(-200)))
        return next
      })
    } catch (error) {
      setDraft(body)
      setStatus(error instanceof Error ? error.message : 'Could not send that message.')
    }
  }

  if (!session) return <section className="chat-page chat-empty"><h1>Study chat</h1><p>Sign in to message your study groups.</p><a href="#settings">Open settings</a></section>
  if (loading) return <section className="chat-page chat-empty"><div className="chat-loader" /><p>Opening your chats…</p></section>
  if (!groups.length) return <section className="chat-page chat-empty"><h1>No chats yet</h1><p>Create or join a study group first. Each group gets its own private chat.</p><a href="#profile">Go to study groups</a></section>

  const pageStyle = { '--chat-accent': accent } as CSSProperties

  return (
    <section className="chat-page" data-theme={theme} data-density={density} style={pageStyle} aria-label="Study group chat">
      <aside className="chat-list">
        <div className="chat-list__brand">
          <div><span className="chat-eyebrow">Your space</span><h1>Messages</h1></div>
          <button className="chat-icon-button" onClick={() => setSettingsOpen((value) => !value)} aria-label="Customize chat" title="Customize chat">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Zm7.4-2.1 1.5 1.2-2 3.5-1.9-.8a8 8 0 0 1-2.1 1.2l-.3 2H10.5l-.3-2a8 8 0 0 1-2.1-1.2l-1.9.8-2-3.5 1.5-1.2a8 8 0 0 1 0-2.5L4.2 9.7l2-3.5 1.9.8a8 8 0 0 1 2.1-1.2l.3-2h4.1l.3 2A8 8 0 0 1 17 7l1.9-.8 2 3.5-1.5 1.2a8 8 0 0 1 0 2.5Z"/></svg>
          </button>
        </div>

        {settingsOpen ? (
          <div className="chat-customize">
            <div className="chat-customize__head"><strong>Appearance</strong><button onClick={() => setSettingsOpen(false)} aria-label="Close">×</button></div>
            <label>Theme</label>
            <div className="chat-segmented">
              <button className={theme === 'midnight' ? 'is-selected' : ''} onClick={() => setTheme('midnight')}>Midnight</button>
              <button className={theme === 'soft' ? 'is-selected' : ''} onClick={() => setTheme('soft')}>Soft</button>
            </div>
            <label>Message spacing</label>
            <div className="chat-segmented">
              <button className={density === 'cozy' ? 'is-selected' : ''} onClick={() => setDensity('cozy')}>Cozy</button>
              <button className={density === 'compact' ? 'is-selected' : ''} onClick={() => setDensity('compact')}>Compact</button>
            </div>
            <label>Accent</label>
            <div className="chat-swatches">
              {ACCENTS.map((color) => <button key={color} className={accent === color ? 'is-selected' : ''} style={{ background: color }} onClick={() => setAccent(color)} aria-label={`Use accent ${color}`} />)}
            </div>
          </div>
        ) : null}

        <div className="chat-list__label">Study groups <span>{groups.length}</span></div>
        <div className="chat-list__groups">
          {groups.map((group) => (
            <button key={group.id} className={group.id === activeGroup?.id ? 'is-active' : ''} onClick={() => setActiveGroupId(group.id)}>
              <span className="chat-group-avatar">{group.name.slice(0, 1).toUpperCase()}</span>
              <span className="chat-group-copy"><strong>{group.name}</strong><small>{group.description || `${group.members.length} member${group.members.length === 1 ? '' : 's'}`}</small></span>
              <span className="chat-group-presence" />
            </button>
          ))}
        </div>
        <div className="chat-list__footer"><span className="chat-lock">◆</span><div><strong>Private groups</strong><small>Only members can read messages</small></div></div>
      </aside>

      <div className="chat-room">
        <header className="chat-room__header">
          <div className="chat-room__identity">
            <span className="chat-room__mark">#</span>
            <div><h2>{activeGroup?.name}</h2><span>{activeGroup?.description || 'Study together in real time.'}</span></div>
          </div>
          <div className="chat-room__actions">
            <div className="chat-member-stack">
              {activeGroup?.members.slice(0, 3).map((member, index) => <span key={member.student_id} style={{ zIndex: 3 - index }}>{(member.display_name || 'M').slice(0, 1).toUpperCase()}</span>)}
            </div>
            <span className="chat-member-count">{activeGroup?.members.length} member{activeGroup?.members.length === 1 ? '' : 's'}</span>
            <a href="#profile">Group details</a>
          </div>
        </header>

        <div className="chat-messages" aria-live="polite">
          <div className="chat-welcome">
            <div className="chat-welcome__icon">#</div>
            <h3>Welcome to {activeGroup?.name}</h3>
            <p>This is the beginning of your group's private study chat.</p>
          </div>

          {messagesLoading && !messages.length ? (
            <div className="chat-skeletons">
              {[0, 1, 2].map((item) => <div className="chat-skeleton" key={item}><span /><div><i /><b /></div></div>)}
            </div>
          ) : null}

          {messages.map((message, index) => {
            const own = message.sender_id === session.user.id
            const previous = messages[index - 1]
            const grouped = previous?.sender_id === message.sender_id && (new Date(message.created_at).getTime() - new Date(previous.created_at).getTime()) < 5 * 60 * 1000
            const member = activeGroup?.members.find((item) => item.student_id === message.sender_id)
            const name = own ? 'You' : message.sender?.display_name || member?.display_name || 'Group member'
            const time = new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            return (
              <article key={message.id} className={`chat-message ${own ? 'is-own' : ''} ${grouped ? 'is-grouped' : ''}`}>
                {!grouped ? <div className="chat-avatar">{name.slice(0, 1).toUpperCase()}</div> : <time className="chat-hover-time">{time}</time>}
                <div className="chat-message__content">
                  {!grouped ? <p><strong>{name}</strong>{own ? <em>you</em> : null}<time>{time}</time></p> : null}
                  <span className="chat-message__body">{message.body}</span>
                </div>
              </article>
            )
          })}
          <div ref={bottomRef} />
        </div>

        <div className="chat-compose-wrap">
          {status ? <p className="chat-status" role="status">{status}</p> : null}
          <form className="chat-composer" onSubmit={submit}>
            <span className="chat-compose-plus" aria-hidden="true">+</span>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={activeGroup ? `Message #${activeGroup.name}` : 'Message'} maxLength={2000} rows={1} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
            }} />
            <span className="chat-char-count">{draft.length > 1700 ? `${draft.length}/2000` : ''}</span>
            <button className="chat-send" disabled={!draft.trim()} aria-label="Send message">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Zm3.7 7h8.5L6.6 6.5 7.7 11Zm-1.1 6.5 9.6-4.5H7.7l-1.1 4.5Z"/></svg>
            </button>
          </form>
          <div className="chat-compose-hint"><span>Enter to send</span><span>Shift + Enter for a new line</span></div>
        </div>
      </div>
    </section>
  )
}
