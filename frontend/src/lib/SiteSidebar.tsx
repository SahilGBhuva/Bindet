import { useEffect, useState, type ReactNode } from 'react'
import type { Profile } from './api'
import { getAccountProfile, getCachedProfile } from './api'
import type { AuthSession } from './auth'
import { listChatUnreads } from './chat'
import type { Screen } from './screens'
import { loadThemePreference, saveThemePreference, type ThemePreference } from './theme'
import './SiteSidebar.css'

type NavItem = { id: Screen; label: string; short?: string }

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'home', label: 'Home' },
      { id: 'tools', label: 'Study', short: 'Study' },
      { id: 'tutor', label: 'Tutor' },
      { id: 'goals', label: 'Assignments', short: 'Tasks' },
      { id: 'progress', label: 'Progress' },
      { id: 'games', label: 'Practice lab' },
    ],
  },
  {
    label: 'Together',
    items: [
      { id: 'chat', label: 'Messages' },
      { id: 'profile', label: 'Friends & groups' },
    ],
  },
]

/* The phone tab bar keeps the four places students go most; everything else is one tap away in Menu. */
const TAB_BAR: Screen[] = ['home', 'tools', 'goals', 'tutor']

const paths: Record<Screen, ReactNode> = {
  home: <><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" /></>,
  tools: <><path d="M5 4.5h9.5a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2z" /><path d="M5 18a2 2 0 0 1 2-2h9.5" /><path d="M19 7v13" /><path d="M9 8h4" /></>,
  tutor: <><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="m12 8 .9 1.9L15 10.8l-2.1.9L12 13.6l-.9-1.9-2.1-.9 2.1-.9z" /></>,
  goals: <><rect x="4.5" y="4.5" width="15" height="15" rx="2.5" /><path d="m8.5 12 2.4 2.4 4.6-4.8" /></>,
  progress: <><path d="M4 19.5h16" /><path d="M7 16v-4M12 16V7M17 16v-6.5" /></>,
  games: <><path d="M8 7.5h8a4.5 4.5 0 0 1 4.3 5.8l-.9 3a1.8 1.8 0 0 1-3 .8L14 15H10l-2.4 2.1a1.8 1.8 0 0 1-3-.8l-.9-3A4.5 4.5 0 0 1 8 7.5z" /><path d="M8 11v3M6.5 12.5h3" /><path d="M15.5 12h.01M17.5 13.5h.01" /></>,
  chat: <><path d="M4.5 6.5A1.5 1.5 0 0 1 6 5h12a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 16H9.5L5.5 19v-3H6a1.5 1.5 0 0 1-1.5-1.5z" /></>,
  profile: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-2.4-4.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" /></>,
  more: <><circle cx="12" cy="12" r="8" /><path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 1.9-2.2 3.3M12 16.6h.01" /></>,
}

export function NavIcon({ kind }: { kind: Screen }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[kind]}</svg>
}

/* The bindit mark: a sheet bound by two violet rings. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="bindit-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="3.5" width="13.5" height="17" rx="2" className="bindit-mark__sheet" />
      <path d="M9.5 8.5h6.5M9.5 12h6.5M9.5 15.5h4" className="bindit-mark__lines" />
      <circle cx="6" cy="8" r="1.9" className="bindit-mark__ring" />
      <circle cx="6" cy="16" r="1.9" className="bindit-mark__ring" />
    </svg>
  )
}

const THEME_NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<ThemePreference, string> = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' }

function ThemeButton() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference)
  const next = () => {
    const value = THEME_NEXT[preference]
    setPreference(value)
    saveThemePreference(value)
  }
  return (
    <button className="bindit-rail__theme" type="button" onClick={next} aria-label={`${THEME_LABEL[preference]}. Change theme`} title={THEME_LABEL[preference]}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {preference === 'dark' ? <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />
          : preference === 'light' ? <><circle cx="12" cy="12" r="3.6" /><path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M6 6l1.3 1.3M16.7 16.7 18 18M6 18l1.3-1.3M16.7 7.3 18 6" /></>
            : <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M9 19.5h6M12 16v3.5" /></>}
      </svg>
    </button>
  )
}

type SiteSidebarProps = { active: Screen; session?: AuthSession | null; onOpenCommand?: () => void }

export function SiteSidebar({ active, session = null, onOpenCommand }: SiteSidebarProps) {
  const [profile, setProfile] = useState<Profile | null>(() => session ? getCachedProfile(session.access_token) : null)
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      void Promise.allSettled([getAccountProfile(session.access_token), listChatUnreads(session)]).then(([nextProfile, unread]) => {
        if (cancelled) return
        if (nextProfile.status === 'fulfilled') setProfile(nextProfile.value)
        if (unread.status === 'fulfilled') setUnreadTotal(unread.value.reduce((total, item) => total + item.unread_count, 0))
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [session])

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menuOpen])

  const displayName = profile?.display_name || session?.user.user_metadata?.username || 'Your account'
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'B'
  const badge = (id: Screen) => id === 'chat' && unreadTotal ? <b className="bindit-rail__badge" aria-label={`${unreadTotal} unread`}>{unreadTotal > 99 ? '99+' : unreadTotal}</b> : null
  const allItems = SECTIONS.flatMap((section) => section.items)

  return (
    <>
      <nav className="bindit-rail" aria-label="Main">
        <div className="bindit-rail__top">
          <a className="bindit-rail__brand" href="#home" aria-label="bindit home"><BrandMark /><span>bindit</span></a>
          {onOpenCommand ? (
            <button className="bindit-rail__search" type="button" onClick={onOpenCommand}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
              <span>Search</span><kbd>⌘K</kbd>
            </button>
          ) : null}
        </div>
        {SECTIONS.map((section) => (
          <div className="bindit-rail__group" key={section.label}>
            <span className="bindit-rail__section">{section.label}</span>
            <ul className="bindit-rail__list">
              {section.items.map((item) => (
                <li key={item.id}>
                  <a className={`bindit-rail__item${active === item.id ? ' is-active' : ''}`} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}>
                    <span className="bindit-rail__icon"><NavIcon kind={item.id} /></span>
                    <span className="bindit-rail__label">{item.label}</span>
                    {badge(item.id)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="bindit-rail__footer">
          <div className="bindit-rail__utility">
            <a className={`bindit-rail__item${active === 'settings' ? ' is-active' : ''}`} href="#settings" aria-current={active === 'settings' ? 'page' : undefined}>
              <span className="bindit-rail__icon"><NavIcon kind="settings" /></span><span className="bindit-rail__label">Settings</span>
            </a>
            <a className={`bindit-rail__theme${active === 'more' ? ' is-active' : ''}`} href="#more" aria-label="Help and more" title="Help and more"><NavIcon kind="more" /></a>
            <ThemeButton />
          </div>
          {session ? (
            <a className="bindit-rail__account" href="#profile" aria-label={`Open your profile, ${displayName}`}>
              <span aria-hidden="true">{initials}</span>
              <div><strong>{displayName}</strong><small>{session.user.email || 'Student'}</small></div>
            </a>
          ) : null}
        </div>
      </nav>

      <header className="bindit-topbar">
        <a className="bindit-rail__brand" href="#home" aria-label="bindit home"><BrandMark /><span>bindit</span></a>
        <div className="bindit-topbar__actions">
          {onOpenCommand ? <button type="button" className="bindit-topbar__button" onClick={onOpenCommand} aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg></button> : null}
          <a className="bindit-topbar__avatar" href="#settings" aria-label="Account settings">{initials}</a>
        </div>
      </header>

      <nav className="bindit-tabbar" aria-label="Main">
        {TAB_BAR.map((id) => {
          const item = allItems.find((entry) => entry.id === id)!
          return (
            <a key={id} className={`bindit-tabbar__item${active === id ? ' is-active' : ''}`} href={`#${id}`} aria-current={active === id ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
              <NavIcon kind={id} /><span>{item.short ?? item.label}</span>
            </a>
          )
        })}
        <button type="button" className={`bindit-tabbar__item${menuOpen || !TAB_BAR.includes(active) ? ' is-active' : ''}`} aria-expanded={menuOpen} aria-controls="bindit-menu" onClick={() => setMenuOpen((open) => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
          <span>Menu</span>
          {unreadTotal ? <i className="bindit-tabbar__dot" aria-hidden="true" /> : null}
        </button>
      </nav>

      {menuOpen ? (
        <div className="bindit-sheet" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setMenuOpen(false) }}>
          <div className="bindit-sheet__panel" id="bindit-menu" role="dialog" aria-modal="true" aria-label="All pages">
            {SECTIONS.map((section) => (
              <div key={section.label}>
                <span className="bindit-rail__section">{section.label}</span>
                <ul className="bindit-sheet__grid">
                  {section.items.map((item) => (
                    <li key={item.id}><a href={`#${item.id}`} className={active === item.id ? 'is-active' : ''} onClick={() => setMenuOpen(false)}><NavIcon kind={item.id} />{item.label}{badge(item.id)}</a></li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="bindit-sheet__footer">
              <a href="#settings" onClick={() => setMenuOpen(false)}><NavIcon kind="settings" />Settings</a>
              <a href="#more" onClick={() => setMenuOpen(false)}><NavIcon kind="more" />Help</a>
              <ThemeButton />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
