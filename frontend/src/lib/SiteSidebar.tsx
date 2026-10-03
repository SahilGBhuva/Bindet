import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Profile, StudyGroup, Task } from './api'
import type { AuthSession } from './auth'
import { listChatUnreads } from './chat'
import { useData } from './dataSource'
import type { Screen } from './screens'
import { withCourseTones } from './session'
import { loadThemePreference, saveThemePreference, type ThemePreference } from './theme'
import { courseInitial } from './tones'
import type { Course, Notebook } from './types'
import './SiteSidebar.css'

type NavItem = { id: Screen; label: string; short?: string }

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Workspace',
    items: [
      { id: 'home', label: 'Home' },
      { id: 'tools', label: 'Study', short: 'Study' },
      { id: 'goals', label: 'Tasks', short: 'Tasks' },
      { id: 'stats', label: 'Project stats' },
      { id: 'tutor', label: 'Tutor' },
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
  stats: <><path d="M11 4.6A7.5 7.5 0 1 0 19.4 13H11z" /><path d="M14 3.6A6.5 6.5 0 0 1 20.4 10H14z" /></>,
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

/* ---------- Panel layout: which content sections show, and in what order (per device). ---------- */

type SectionId = 'highlighted' | 'directory' | 'groups' | 'tasks'
type Layout = { order: SectionId[]; hidden: SectionId[]; collapsed: string[] }

const LAYOUT_KEY = 'bindit:sidebar:layout'
const SECTION_IDS: SectionId[] = ['highlighted', 'directory', 'groups', 'tasks']
const SECTION_TITLES: Record<SectionId, string> = { highlighted: 'Highlighted', directory: 'Directory', groups: 'My groups', tasks: 'Tasks' }
const DEFAULT_LAYOUT: Layout = { order: SECTION_IDS, hidden: [], collapsed: [] }

function readLayout(): Layout {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null
    if (!parsed) return DEFAULT_LAYOUT
    const known = (value: unknown): value is SectionId => SECTION_IDS.includes(value as SectionId)
    const order = [...new Set((Array.isArray(parsed.order) ? parsed.order : []).filter(known))]
    return {
      order: [...order, ...SECTION_IDS.filter((id) => !order.includes(id))],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(known) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter((value) => typeof value === 'string') : [],
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function writeLayout(layout: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // Storage can be unavailable; the layout still applies for this visit.
  }
}

/* ---------- Task helpers ---------- */

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }
const DAY = 86_400_000
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function dueAt(task: Task) {
  if (!task.due_date) return Infinity
  const value = Date.parse(`${task.due_date}T${task.due_time ? task.due_time.slice(0, 5) : '23:59'}`)
  return Number.isNaN(value) ? Infinity : value
}

function byUrgency(a: Task, b: Task) {
  const gap = dueAt(a) - dueAt(b)
  return (Number.isNaN(gap) ? 0 : gap) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dueLabel(task: Task, now: number) {
  const at = dueAt(task)
  if (at === Infinity) return ''
  if (task.kind !== 'event' && at < now) return 'Overdue'
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return shortDate.format(new Date(at))
}

function readGroupParam() {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('group') ?? ''
}

const plus = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
const chevron = <svg className="bindit-rail__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>

type SiteSidebarProps = { active: Screen; session?: AuthSession | null; onOpenCommand?: () => void }

export function SiteSidebar({ active, session = null, onOpenCommand }: SiteSidebarProps) {
  const data = useData()
  // The landing demo has no session but a sandboxed, in-memory data source it may read from.
  const canRead = Boolean(session) || data.sandboxed
  const token = session?.access_token ?? ''
  const [profile, setProfile] = useState<Profile | null>(() => canRead ? data.getCachedProfile(token) : null)
  const [tasks, setTasks] = useState<Task[] | null>(() => canRead ? data.getCachedTasks(token) : null)
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => canRead ? data.getCachedStudyGroups(token) : null)
  const [notebook, setNotebook] = useState<Notebook>(() => data.loadNotebook())
  const [seenActive, setSeenActive] = useState(active)
  const [groupParam, setGroupParam] = useState(readGroupParam)
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [layout, setLayout] = useState<Layout>(() => data.sandboxed ? DEFAULT_LAYOUT : readLayout())
  const [editing, setEditing] = useState(false)
  const [now, setNow] = useState(() => data.now())

  // Courses can change on other pages, so reread the local notebook whenever the page changes.
  if (seenActive !== active) {
    setSeenActive(active)
    setNotebook(data.loadNotebook())
    setNow(data.now())
  }

  useEffect(() => {
    const sync = () => setGroupParam(readGroupParam())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    if (!session || data.sandboxed) return
    let cancelled = false
    const refresh = () => {
      if (document.visibilityState === 'hidden') return
      void Promise.allSettled([
        data.getAccountProfile(session.access_token),
        listChatUnreads(session),
        data.getTasks(session.access_token),
        data.getStudyGroups(session.access_token),
      ]).then(([nextProfile, unread, nextTasks, nextGroups]) => {
        if (cancelled) return
        if (nextProfile.status === 'fulfilled') setProfile(nextProfile.value)
        if (unread.status === 'fulfilled') setUnreadTotal(unread.value.reduce((total, item) => total + item.unread_count, 0))
        if (nextTasks.status === 'fulfilled') setTasks(nextTasks.value)
        else setTasks((current) => current ?? [])
        if (nextGroups.status === 'fulfilled') setGroups(nextGroups.value)
        else setGroups((current) => current ?? [])
        setNow(data.now())
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [data, session])

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

  const courses = withCourseTones(notebook.courses)
  const openTasks = (tasks ?? []).filter((task) => task.status !== 'done').toSorted(byUrgency)
  // Highlighted pins what needs attention now: urgent or high priority work, and anything due within two days.
  const pressing = openTasks.filter((task) => PRIORITY_RANK[task.priority] <= 1 || dueAt(task) - now < 2 * DAY)
  const highlighted = (pressing.length ? pressing : openTasks).slice(0, 3)
  const nextTasks = openTasks.filter((task) => !highlighted.includes(task)).slice(0, 3)
  const tasksLoading = canRead && tasks === null
  const groupsLoading = canRead && groups === null

  function updateLayout(change: (current: Layout) => Layout) {
    setLayout((current) => {
      const next = change(current)
      if (!data.sandboxed) writeLayout(next)
      return next
    })
  }

  const toggleCollapsed = (id: string) => updateLayout((current) => ({
    ...current,
    collapsed: current.collapsed.includes(id) ? current.collapsed.filter((item) => item !== id) : [...current.collapsed, id],
  }))

  const move = (id: SectionId, step: -1 | 1) => updateLayout((current) => {
    const order = [...current.order]
    const from = order.indexOf(id)
    const to = from + step
    if (from < 0 || to < 0 || to >= order.length) return current
    ;[order[from], order[to]] = [order[to], order[from]]
    return { ...current, order }
  })

  const toggleHidden = (id: SectionId) => updateLayout((current) => ({
    ...current,
    hidden: current.hidden.includes(id) ? current.hidden.filter((item) => item !== id) : [...current.hidden, id],
  }))

  function openCourse(course: Course) {
    const next = { ...data.loadNotebook(), activeCourse: course.name, activeUnit: course.units[0] ?? '' }
    try {
      data.saveNotebook(next)
    } catch {
      // Storage can be unavailable; Study still opens on its default course.
    }
    setNotebook(next)
  }

  const taskRow = (task: Task, pinned: boolean) => {
    const due = dueLabel(task, now)
    return (
      <li key={task.id}>
        <a className={`bindit-rail__entry${due === 'Overdue' ? ' is-late' : ''}`} href="#goals">
          <span className="bindit-rail__glyph" aria-hidden="true">
            {pinned
              ? <svg viewBox="0 0 16 16"><path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" /></svg>
              : <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" /></svg>}
          </span>
          <span className="bindit-rail__entry-text">{task.title}</span>
          {due ? <small className="bindit-rail__meta">{due}</small> : null}
        </a>
      </li>
    )
  }

  const skeletonRows = (count: number) => (
    <ul className="bindit-rail__entries" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <li key={index}><span className="ui-skeleton bindit-rail__skeleton" /></li>)}
    </ul>
  )

  const sections: Record<SectionId, { count?: number; action?: ReactNode; body: ReactNode }> = {
    highlighted: {
      body: tasksLoading ? skeletonRows(2)
        : highlighted.length ? <ul className="bindit-rail__entries">{highlighted.map((task) => taskRow(task, true))}</ul>
          : <p className="bindit-rail__empty">Nothing pressing. Urgent and soon-due tasks pin here.</p>,
    },
    directory: {
      action: <a className="bindit-rail__mini" href="#tools" aria-label="Add a course" title="Add a course">{plus}</a>,
      body: courses.length ? (
        <ul className="bindit-rail__entries">
          {courses.map((course) => {
            const current = active === 'tools' && course.name === notebook.activeCourse
            return (
              <li key={course.name}>
                <a className={`bindit-rail__entry${current ? ' is-current' : ''}`} href="#tools" aria-current={current ? 'page' : undefined} onClick={() => openCourse(course)} style={{ '--course': course.tone } as CSSProperties}>
                  <span className="bindit-rail__course" aria-hidden="true">{courseInitial(course.name)}</span>
                  <span className="bindit-rail__entry-text">{course.name}</span>
                </a>
              </li>
            )
          })}
        </ul>
      ) : <p className="bindit-rail__empty"><a className="ui-link" href="#tools">Add your first course</a></p>,
    },
    groups: {
      count: groups?.length,
      action: <a className="bindit-rail__mini" href="#profile" aria-label="Join or create a group" title="Join or create a group">{plus}</a>,
      body: groupsLoading ? skeletonRows(2) : groups?.length ? (
        <ul className="bindit-rail__entries">
          {groups.map((group) => {
            const current = active === 'stats' && groupParam === group.id
            return (
              <li key={group.id}>
                <a className={`bindit-rail__entry bindit-rail__entry--group${current ? ' is-current' : ''}`} href={`#stats?group=${encodeURIComponent(group.id)}`} aria-current={current ? 'page' : undefined}>
                  <span className="bindit-rail__glyph" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="6" cy="6" r="2.2" /><path d="M2.5 13a3.5 3.5 0 0 1 7 0" /><path d="M10.5 4a2 2 0 0 1 0 4M13.5 13a3.5 3.5 0 0 0-1.8-3" /></svg></span>
                  <span className="bindit-rail__entry-text">{group.name}</span>
                  {group.description ? <small className="bindit-rail__sub">{group.description}</small> : null}
                </a>
              </li>
            )
          })}
        </ul>
      ) : <p className="bindit-rail__empty"><a className="ui-link" href="#profile">Join or start a study group</a></p>,
    },
    tasks: {
      count: tasks ? openTasks.length : undefined,
      action: <a className="bindit-rail__mini" href="#goals" aria-label="Open all tasks" title="Open all tasks"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg></a>,
      body: tasksLoading ? skeletonRows(3)
        : nextTasks.length ? <ul className="bindit-rail__entries">{nextTasks.map((task) => taskRow(task, false))}</ul>
          : <p className="bindit-rail__empty">{openTasks.length ? 'Everything open is highlighted above.' : <>All clear. <a className="ui-link" href="#goals">Add a task</a></>}</p>,
    },
  }

  const shown = layout.order.filter((id) => editing || !layout.hidden.includes(id))
  const pagesOpen = !layout.collapsed.includes('pages')

  return (
    <>
      <nav className={`bindit-rail${editing ? ' is-editing' : ''}`} aria-label="Main">
        <div className="bindit-rail__top">
          <a className="bindit-rail__brand" href="#home" aria-label="bindit home"><BrandMark /><span>bindit</span></a>
          <div className="bindit-rail__tools">
            <a className={`bindit-rail__tool${active === 'settings' ? ' is-active' : ''}`} href="#settings" aria-label="Settings" title="Settings" aria-current={active === 'settings' ? 'page' : undefined}><NavIcon kind="settings" /></a>
            {onOpenCommand ? (
              <button className="bindit-rail__tool" type="button" onClick={onOpenCommand} aria-label="Search" aria-keyshortcuts="Meta+K" title="Search (⌘K)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
              </button>
            ) : null}
            <a className={`bindit-rail__tool${active === 'tutor' ? ' is-active' : ''}`} href="#tutor" aria-label="Tutor" title="Tutor"><NavIcon kind="tutor" /></a>
          </div>
        </div>

        <a className="bindit-rail__account" href="#profile" aria-label={`Open your profile, ${displayName}`}>
          <span aria-hidden="true">{initials}</span>
          <strong>{displayName}</strong>
        </a>

        <section className="bindit-rail__block" aria-labelledby="bindit-rail-pages">
          <h2 className="bindit-rail__heading">
            <button type="button" id="bindit-rail-pages" className="bindit-rail__toggle" aria-expanded={pagesOpen} aria-controls="bindit-rail-pages-list" onClick={() => toggleCollapsed('pages')}>
              <span>Pages</span>{chevron}
            </button>
          </h2>
          {pagesOpen ? (
            <ul className="bindit-rail__list" id="bindit-rail-pages-list">
              {allItems.map((item) => (
                <li key={item.id}>
                  <a className={`bindit-rail__item${active === item.id ? ' is-active' : ''}`} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}>
                    <span className="bindit-rail__icon"><NavIcon kind={item.id} /></span>
                    <span className="bindit-rail__label">{item.label}</span>
                    {badge(item.id)}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {shown.map((id, index) => {
          const section = sections[id]
          const hidden = layout.hidden.includes(id)
          const collapsed = layout.collapsed.includes(id)
          const title = SECTION_TITLES[id]
          const headingId = `bindit-rail-${id}`
          return (
            <section key={id} className={`bindit-rail__block${hidden ? ' is-hidden' : ''}`} aria-labelledby={headingId}>
              <h2 className="bindit-rail__heading">
                {editing ? (
                  <span id={headingId} className="bindit-rail__toggle is-static"><span>{title}</span>{hidden ? <small>Hidden</small> : null}</span>
                ) : (
                  <button type="button" id={headingId} className="bindit-rail__toggle" aria-expanded={!collapsed} aria-controls={`${headingId}-body`} onClick={() => toggleCollapsed(id)}>
                    <span>{title}</span>
                    {section.count !== undefined ? <span className="bindit-rail__count">{section.count}</span> : null}
                    {chevron}
                  </button>
                )}
                {editing ? (
                  <span className="bindit-rail__controls">
                    <button type="button" className="bindit-rail__mini" onClick={() => move(id, -1)} disabled={index === 0} aria-label={`Move ${title} up`} title="Move up"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 9.5 3.5-3.5 3.5 3.5" /></svg></button>
                    <button type="button" className="bindit-rail__mini" onClick={() => move(id, 1)} disabled={index === shown.length - 1} aria-label={`Move ${title} down`} title="Move down"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg></button>
                    <button type="button" className="bindit-rail__mini" onClick={() => toggleHidden(id)} aria-label={hidden ? `Show ${title}` : `Hide ${title}`} title={hidden ? 'Show' : 'Hide'}>
                      {hidden
                        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><path d="M3 3l10 10" /></svg>
                        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /></svg>}
                    </button>
                  </span>
                ) : section.action}
              </h2>
              {!collapsed && !hidden ? <div id={`${headingId}-body`} className="bindit-rail__body">{section.body}</div> : null}
            </section>
          )
        })}

        <div className="bindit-rail__footer">
          <button type="button" className={`bindit-rail__lock${editing ? ' is-editing' : ''}`} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
            <span className="bindit-rail__lock-state">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                {editing ? <path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1" /> : <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />}
              </svg>
              {editing ? 'Editing' : 'Locked'}
            </span>
            <span className="bindit-rail__lock-action">{editing ? 'Done' : 'Edit panel'}</span>
          </button>
          {editing ? (
            <button type="button" className="bindit-rail__theme" onClick={() => updateLayout(() => DEFAULT_LAYOUT)} aria-label="Reset panel layout" title="Reset layout">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.1-5" /><path d="M5 4.5V8h3.5" /></svg>
            </button>
          ) : (
            <>
              <a className={`bindit-rail__theme${active === 'more' ? ' is-active' : ''}`} href="#more" aria-label="Help and more" title="Help and more"><NavIcon kind="more" /></a>
              <ThemeButton />
            </>
          )}
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
