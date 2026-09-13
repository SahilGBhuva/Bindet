import './SiteSidebar.css'

export const SCREENS = ['home', 'tools', 'progress', 'games', 'goals', 'profile', 'settings', 'more'] as const
export type Screen = (typeof SCREENS)[number]

const ITEMS: { id: Screen; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'tools', label: 'Tools' },
  { id: 'progress', label: 'Progress' },
  { id: 'games', label: 'Games' },
  { id: 'goals', label: 'Goals' },
  { id: 'profile', label: 'Profile' },
  { id: 'settings', label: 'Settings' },
  { id: 'more', label: 'More' },
]

function Mark({ kind }: { kind: Screen }) {
  if (kind === 'home') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 10 8-7 8 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 21v-7h6v7"/></svg>
  if (kind === 'tools') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.5-.6-.6-2.5z"/></svg>
  if (kind === 'progress') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>
  if (kind === 'games') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10a5 5 0 0 1 4.8 6.4l-1 3.4a2 2 0 0 1-3.3.9L15 16H9l-2.5 2.7a2 2 0 0 1-3.3-.9l-1-3.4A5 5 0 0 1 7 8Z"/><path d="M7 12v4M5 14h4M16.5 12.5h.01M19 15h.01"/></svg>
  if (kind === 'goals') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>
  if (kind === 'profile') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
  if (kind === 'settings') return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h-.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.14.35.35.68.6 1 .25.32.38.7.4 1.1V13a1.7 1.7 0 0 0-.6 1c-.25.32-.46.65-.6 1Z"/></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
}

type SiteSidebarProps = { active: Screen }

export function SiteSidebar({ active }: SiteSidebarProps) {
  return (
    <nav className="bindit-rail" aria-label="Main">
      <a className="bindit-rail__brand" href="#home" aria-label="bindit home">
        <span className="bindit-rail__brand-mark" aria-hidden="true"><img src="/bindit-mascot.webp" alt="" /></span>
        bindit
      </a>
      <ol className="bindit-rail__list">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <a className={`bindit-rail__item is-${item.id} ${active === item.id ? 'is-active' : ''}`} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}>
              <span className="bindit-rail__icon"><Mark kind={item.id} /></span>
              <span className="bindit-rail__label">{item.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
