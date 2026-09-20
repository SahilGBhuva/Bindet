import { useEffect, useState } from 'react'
import type { Profile } from './api'
import { getAccountProfile } from './api'
import type { AuthSession } from './auth'
import { listChatUnreads } from './chat'
import './SiteSidebar.css'

export const SCREENS = ['home', 'tools', 'progress', 'games', 'goals', 'chat', 'profile', 'settings', 'more'] as const
export type Screen = (typeof SCREENS)[number]

const ITEMS: { id: Screen; label: string; section: string }[] = [
  { id: 'home', label: 'Home', section: 'Study' },
  { id: 'tools', label: 'Tools', section: 'Study' },
  { id: 'progress', label: 'Progress', section: 'Study' },
  { id: 'goals', label: 'Goals', section: 'Plan' },
  { id: 'games', label: 'Games', section: 'Plan' },
  { id: 'chat', label: 'Chat', section: 'Together' },
  { id: 'profile', label: 'Friends & profile', section: 'Together' },
  { id: 'settings', label: 'Settings', section: 'Workspace' },
  { id: 'more', label: 'More', section: 'Workspace' },
]

function Mark({ kind }: { kind: Screen }) {
  if (kind === 'home') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-7 8 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/></svg>
  if (kind === 'tools') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.5-.6-.6-2.5z"/></svg>
  if (kind === 'progress') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>
  if (kind === 'games') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10a5 5 0 0 1 4.8 6.4l-1 3.4a2 2 0 0 1-3.3.9L15 16H9l-2.5 2.7a2 2 0 0 1-3.3-.9l-1-3.4A5 5 0 0 1 7 8Z"/><path d="M7 12v4M5 14h4M16.5 12.5h.01M19 15h.01"/></svg>
  if (kind === 'goals') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>
  if (kind === 'chat') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M8 10h8M8 13h5"/></svg>
  if (kind === 'profile') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
  if (kind === 'settings') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h-.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.14.35.35.68.6 1 .25.32.38.7.4 1.1V13a1.7 1.7 0 0 0-.6 1c-.25.32-.46.65-.6 1Z"/></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
}

type SiteSidebarProps = { active: Screen; session?: AuthSession | null; onOpenCommand?: () => void }

export function SiteSidebar({ active, session = null, onOpenCommand }: SiteSidebarProps) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [unreadTotal, setUnreadTotal] = useState(0)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const refresh = () => {
      void Promise.all([getAccountProfile(session.access_token), listChatUnreads(session)]).then(([nextProfile, unread]) => {
        if (cancelled) return
        setProfile(nextProfile)
        setUnreadTotal(unread.reduce((total, item) => total + item.unread_count, 0))
      }).catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 20_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [session])

  const displayName = profile?.display_name || session?.user.user_metadata?.username || 'Your account'
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'B'

  return (
    <nav className="bindit-rail" aria-label="Main">
      <div className="bindit-rail__top">
        <a className="bindit-rail__brand" href="#home" aria-label="bindit home"><span className="bindit-rail__brand-mark" aria-hidden="true"><img src="/bindit-mascot-cutout.webp" alt="" /></span><span>bindit</span><i>beta</i></a>
        {onOpenCommand ? <button className="bindit-rail__search" type="button" onClick={onOpenCommand}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><span>Quick find</span><kbd>⌘ K</kbd></button> : null}
      </div>
      <ol className="bindit-rail__list">
        {ITEMS.map((item, index) => (
          <li key={item.id} className={index === 0 || ITEMS[index - 1].section !== item.section ? 'starts-section' : ''}>
            {index === 0 || ITEMS[index - 1].section !== item.section ? <span className="bindit-rail__section">{item.section}</span> : null}
            <a className={`bindit-rail__item is-${item.id} ${active === item.id ? 'is-active' : ''}`} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}>
              <span className="bindit-rail__icon"><Mark kind={item.id} /></span>
              <span className="bindit-rail__label">{item.label}</span>
              {item.id === 'chat' && unreadTotal ? <b className="bindit-rail__badge">{unreadTotal > 99 ? '99+' : unreadTotal}</b> : null}
            </a>
          </li>
        ))}
      </ol>
      {session ? <a className="bindit-rail__account" href="#settings" aria-label="Open account settings">
        <span>{initials}</span>
        <div><strong>{displayName}</strong><small>{session?.user.email || 'Student workspace'}</small></div>
        <i>•••</i>
      </a> : null}
    </nav>
  )
}
