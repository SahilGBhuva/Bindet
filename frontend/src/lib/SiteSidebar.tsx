import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { GROUPS_CHANGED_EVENT, PROFILE_CHANGED_EVENT, TASKS_CHANGED_EVENT, type Profile, type StudyGroup, type Task } from './api'
import { accountDisplayName } from './accountName'
import type { AuthSession } from './auth'
import { listChatUnreads } from './chat'
import { useData } from './dataSource'
import type { Screen } from './screens'
import { withCourseTones } from './session'
import { saveThemePreference, useThemePreference, type ThemePreference } from './theme'
import type { Course, Notebook } from './types'
import { useDrawer } from './useDrawer'
import './SiteSidebar.css'

type NavItem = { id: Screen; label: string; short?: string }

/* Every page, for the phone menu sheet. On desktop, pages live in the shell's top icon bar. */
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
  const preference = useThemePreference()
  const next = () => saveThemePreference(THEME_NEXT[preference])
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

/* ---------- Panel layout: which sections show, in what order, and which are folded (per device). ---------- */

type SectionId = 'highlighted' | 'directory' | 'important' | 'groups' | 'tasks'
type Layout = { order: SectionId[]; hidden: SectionId[]; collapsed: SectionId[] }

const LAYOUT_KEY = 'bindit:sidebar:layout:v2'
const IMPORTANT_KEY = 'bindit:sidebar:important'
const SECTION_IDS: SectionId[] = ['highlighted', 'directory', 'important', 'groups', 'tasks']
const SECTION_TITLES: Record<SectionId, string> = {
  highlighted: 'Highlighted',
  directory: 'Directory',
  important: 'Important groups',
  groups: 'My Groups',
  tasks: 'Tasks',
}
const DEFAULT_LAYOUT: Layout = { order: SECTION_IDS, hidden: [], collapsed: [] }

const isSection = (value: unknown): value is SectionId => SECTION_IDS.includes(value as SectionId)

function readLayout(): Layout {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null
    if (!parsed) return DEFAULT_LAYOUT
    const order = [...new Set((Array.isArray(parsed.order) ? parsed.order : []).filter(isSection))]
    return {
      order: [...order, ...SECTION_IDS.filter((id) => !order.includes(id))],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(isSection) : [],
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed.filter(isSection) : [],
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function readImportant(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(IMPORTANT_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable; the change still applies for this visit.
  }
}

/* ---------- Task helpers ---------- */

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }
const DAY = 86_400_000

function dueAt(task: Task) {
  if (!task.due_date) return Infinity
  const value = Date.parse(`${task.due_date}T${task.due_time ? task.due_time.slice(0, 5) : '23:59'}`)
  return Number.isNaN(value) ? Infinity : value
}

function byUrgency(a: Task, b: Task) {
  const gap = dueAt(a) - dueAt(b)
  return (Number.isNaN(gap) ? 0 : gap) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
}

function readGroupParam() {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('group') ?? ''
}

/* "LM work team" then "LM prime devs": a group that shares the previous group's first word nests under it. */
function nestGroups(groups: StudyGroup[]) {
  const rows: { group: StudyGroup; child: boolean }[] = []
  let parentWord = ''
  // Oldest first, so the group that started a family ("LM work team") comes before the ones that grew from it.
  const ordered = groups.toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  for (const group of ordered) {
    const word = group.name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    const child = Boolean(word) && word === parentWord
    if (!child) parentWord = word
    rows.push({ group, child })
  }
  return rows
}

/* ---------- Tiny line glyphs from the drawing ---------- */

const svg = (body: ReactNode, size = 16) => <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">{body}</svg>
const glyphs = {
  gear: <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" /></svg>,
  folder: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.2c0-.6.4-1 1-1h3.2l1.4 1.6H13c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" /></svg>,
  play: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3v10l8.5-5z" /></svg>,
  handle: <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3v10M9.8 3v10" /></svg>,
  chevron: <svg className="bindit-rail__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>,
  square: svg(<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />),
  circle: svg(<circle cx="8" cy="8" r="4.5" />),
  triangle: svg(<path d="M8 3.5 13 12.5H3z" />),
  people: svg(<><circle cx="6" cy="5.5" r="2" /><path d="M2.5 13a3.5 3.5 0 0 1 7 0" /><path d="M10.5 3.8a1.9 1.9 0 0 1 0 3.6M13.5 13a3.5 3.5 0 0 0-1.9-3.1" /></>),
  star: svg(<path d="m8 2.6 1.6 3.4 3.7.4-2.8 2.5.8 3.7L8 10.7l-3.3 1.9.8-3.7-2.8-2.5 3.7-.4z" />),
  up: svg(<path d="m4.5 9.5 3.5-3.5 3.5 3.5" />),
  down: svg(<path d="m4.5 6.5 3.5 3.5 3.5-3.5" />),
  eye: svg(<><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /></>),
  eyeOff: svg(<><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><path d="M3 3l10 10" /></>),
}

type SiteSidebarProps = {
  active: Screen
  session?: AuthSession | null
  onOpenCommand?: () => void
  /* Collapse state is owned by the app shell (the handle, "Merge" and "↔" share it). Without it the rail stays open. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  /* Lets the shell's top bar show the Messages unread dot without a second request. */
  onUnreadChange?: (total: number) => void
}

export function SiteSidebar({ active, session = null, onOpenCommand, collapsed = false, onCollapsedChange, onUnreadChange }: SiteSidebarProps) {
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
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuPanel = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>(() => data.sandboxed ? DEFAULT_LAYOUT : readLayout())
  const [important, setImportant] = useState<string[]>(() => data.sandboxed ? [] : readImportant())
  const [editing, setEditing] = useState(false)
  const [now, setNow] = useState(() => data.now())
  // A failed refresh with nothing cached says so (the rail retries every 30 seconds) instead of looking empty.
  const [failed, setFailed] = useState({ tasks: false, groups: false })

  // Courses can change on other pages, so reread the local notebook whenever the page changes.
  if (seenActive !== active) {
    setSeenActive(active)
    setNotebook(data.loadNotebook())
    setNow(data.now())
  }

  // The Study page saves its notebook as the student works; follow it so the
  // Directory always highlights the course that page shows.
  useEffect(() => data.onNotebookChange(() => setNotebook(data.loadNotebook())), [data])

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
        if (unread.status === 'fulfilled') {
          const total = unread.value.reduce((sum, item) => sum + item.unread_count, 0)
          setUnreadTotal(total)
          onUnreadChange?.(total)
        }
        if (nextTasks.status === 'fulfilled') setTasks(nextTasks.value)
        else setTasks((current) => current ?? [])
        if (nextGroups.status === 'fulfilled') setGroups(nextGroups.value)
        else setGroups((current) => current ?? [])
        setFailed({ tasks: nextTasks.status === 'rejected', groups: nextGroups.status === 'rejected' })
        setNow(data.now())
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [data, session, onUnreadChange])

  // Changes made in this tab show at once: a task edit updates the shared cache (read it
  // directly), and group or profile writes fetch fresh copies past the 30-second cache.
  useEffect(() => {
    if (!session || data.sandboxed) return
    const token = session.access_token
    let live = true
    const onTasks = () => {
      const cached = data.getCachedTasks(token)
      if (cached) setTasks(cached)
    }
    const onGroups = () => {
      void Promise.allSettled([data.getStudyGroups(token, true), data.getTasks(token, true)]).then(([nextGroups, nextTasks]) => {
        if (!live) return
        if (nextGroups.status === 'fulfilled') setGroups(nextGroups.value)
        if (nextTasks.status === 'fulfilled') setTasks(nextTasks.value)
      })
    }
    const onProfile = () => {
      void data.getAccountProfile(token, true).then((next) => { if (live) setProfile(next) }).catch(() => undefined)
    }
    window.addEventListener(TASKS_CHANGED_EVENT, onTasks)
    window.addEventListener(GROUPS_CHANGED_EVENT, onGroups)
    window.addEventListener(PROFILE_CHANGED_EVENT, onProfile)
    return () => {
      live = false
      window.removeEventListener(TASKS_CHANGED_EVENT, onTasks)
      window.removeEventListener(GROUPS_CHANGED_EVENT, onGroups)
      window.removeEventListener(PROFILE_CHANGED_EVENT, onProfile)
    }
  }, [data, session])

  // The phone menu takes focus when it opens, keeps the page behind it still, closes on Esc
  // and hands focus back to the Menu button when it closes.
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDrawer({ open: menuOpen, onClose: closeMenu, panel: menuPanel, returnFocus: menuButton })

  const displayName = profile?.display_name || accountDisplayName(session?.user) || 'Your account'
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'B'
  const badge = (id: Screen) => id === 'chat' && unreadTotal ? <b className="bindit-rail__badge" aria-label={`${unreadTotal} unread`}>{unreadTotal > 99 ? '99+' : unreadTotal}</b> : null
  const allItems = SECTIONS.flatMap((section) => section.items)

  const courses = withCourseTones(notebook.courses)
  const openTasks = (tasks ?? []).filter((task) => task.status !== 'done').toSorted(byUrgency)
  // Highlighted pins what needs attention now: urgent or high priority work, and anything due within two days.
  const pressing = openTasks.filter((task) => PRIORITY_RANK[task.priority] <= 1 || dueAt(task) - now < 2 * DAY)
  const highlighted = (pressing.length ? pressing : openTasks).slice(0, 3)
  const nextTasks = openTasks.filter((task) => !highlighted.includes(task)).slice(0, 4)
  const tasksLoading = canRead && tasks === null
  const groupsLoading = canRead && groups === null
  const starred = (groups ?? []).filter((group) => important.includes(group.id))
  const importantGroups = starred.length ? starred : (groups ?? []).slice(0, 2)

  function updateLayout(change: (current: Layout) => Layout) {
    setLayout((current) => {
      const next = change(current)
      if (!data.sandboxed) store(LAYOUT_KEY, next)
      return next
    })
  }

  const toggleCollapsed = (id: SectionId) => updateLayout((current) => ({
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

  function toggleImportant(id: string) {
    setImportant((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      if (!data.sandboxed) store(IMPORTANT_KEY, next)
      return next
    })
  }

  function openCourse(course: Course) {
    const next = { ...data.loadNotebook(), activeCourse: course.name, activeUnit: course.units[0] ?? '' }
    try {
      data.saveNotebook(next)
    } catch {
      // Storage can be unavailable; Study still opens on its default course.
    }
    setNotebook(next)
  }

  const skeletonRows = (count: number) => (
    <ul className="bindit-rail__entries" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <li key={index}><span className="ui-skeleton bindit-rail__skeleton" /></li>)}
    </ul>
  )

  const empty = (content: ReactNode) => <p className="bindit-rail__empty">{content}</p>
  const offline = empty('Couldn’t load. Retrying shortly.')

  const groupLink = (group: StudyGroup, glyph: ReactNode, extra = '') => {
    const current = active === 'stats' && groupParam === group.id
    return (
      <a className={`bindit-rail__entry${extra}${current ? ' is-current' : ''}`} href={`#stats?group=${encodeURIComponent(group.id)}`} aria-current={current ? 'page' : undefined} title={group.name}>
        <span className="bindit-rail__glyph">{glyph}</span>
        <span className="bindit-rail__entry-text">{group.name}</span>
      </a>
    )
  }

  const sections: Record<SectionId, { count?: number; hatch?: boolean; body: ReactNode }> = {
    highlighted: {
      body: tasksLoading ? skeletonRows(2)
        : highlighted.length ? (
          <ul className="bindit-rail__entries">
            {highlighted.map((task) => (
              <li key={task.id}>
                <a className="bindit-rail__entry" href="#goals" title={task.title}>
                  <span className="bindit-rail__glyph bindit-rail__glyph--dot" aria-hidden="true">·</span>
                  <span className="bindit-rail__entry-text">{task.title}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : failed.tasks ? offline : empty('Nothing pressing right now.'),
    },
    directory: {
      body: (
        <ul className="bindit-rail__entries">
          {courses.map((course, index) => {
            const current = active === 'tools' && course.name === notebook.activeCourse
            return (
              <li key={course.name}>
                <a className={`bindit-rail__entry${current ? ' is-current' : ''}`} href="#tools" aria-current={current ? 'page' : undefined} title={course.name} onClick={() => openCourse(course)}>
                  <span className="bindit-rail__glyph">{index % 3 === 2 ? glyphs.circle : glyphs.square}</span>
                  <span className="bindit-rail__entry-text">{course.name}</span>
                </a>
              </li>
            )
          })}
          <li>
            <a className="bindit-rail__entry bindit-rail__entry--add" href="#tools" aria-label="Add a course" title="Add a course">
              <span className="bindit-rail__glyph bindit-rail__glyph--plus" aria-hidden="true">+</span>
            </a>
          </li>
        </ul>
      ),
    },
    important: {
      body: groupsLoading ? skeletonRows(2) : importantGroups.length ? (
        <ul className="bindit-rail__entries">
          {importantGroups.map((group) => <li key={group.id}>{groupLink(group, glyphs.triangle)}</li>)}
        </ul>
      ) : failed.groups ? offline : empty(<a className="ui-link" href="#profile">Join a study group</a>),
    },
    groups: {
      count: failed.groups && !groups?.length ? undefined : groups?.length,
      body: groupsLoading ? skeletonRows(3) : groups?.length ? (
        <ul className="bindit-rail__entries">
          {nestGroups(groups).map(({ group, child }) => {
            const isImportant = important.includes(group.id)
            return (
              <li key={group.id} className={`bindit-rail__group${child ? ' is-child' : ''}`}>
                {groupLink(group, glyphs.people, child ? ' bindit-rail__entry--child' : '')}
                <button
                  type="button"
                  className={`bindit-rail__star${isImportant ? ' is-on' : ''}`}
                  aria-pressed={isImportant}
                  aria-label={`Mark ${group.name} as an important group`}
                  title={isImportant ? 'Important' : 'Mark important'}
                  onClick={() => toggleImportant(group.id)}
                >
                  {glyphs.star}
                </button>
              </li>
            )
          })}
        </ul>
      ) : failed.groups ? offline : empty(<a className="ui-link" href="#profile">Join or start a study group</a>),
    },
    tasks: {
      count: tasks && !(failed.tasks && !tasks.length) ? openTasks.length : undefined,
      hatch: true,
      body: tasksLoading ? skeletonRows(2)
        : nextTasks.length ? (
          <ul className="bindit-rail__entries">
            {nextTasks.map((task) => (
              <li key={task.id}>
                <a className="bindit-rail__entry" href="#goals" title={task.title}>
                  <span className="bindit-rail__glyph bindit-rail__glyph--star" aria-hidden="true">*</span>
                  <span className="bindit-rail__entry-text">{task.title}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : failed.tasks && !openTasks.length ? offline : empty(openTasks.length ? 'The rest are highlighted above.' : <>All clear. <a className="ui-link" href="#goals">Add a task</a></>),
    },
  }

  const shown = layout.order.filter((id) => editing || !layout.hidden.includes(id))
  const canCollapse = Boolean(onCollapsedChange)
  const isCollapsed = canCollapse && collapsed

  const tools = (
    <div className="bindit-rail__tools">
      <a className={`bindit-rail__item bindit-rail__tool${active === 'settings' ? ' is-active' : ''}`} href="#settings" aria-label="Settings" title="Settings" aria-current={active === 'settings' ? 'page' : undefined}>{glyphs.gear}</a>
      <a className={`bindit-rail__item bindit-rail__tool${active === 'tools' ? ' is-active' : ''}`} href="#tools" aria-label="Study files" title="Study files" aria-current={active === 'tools' ? 'page' : undefined}>{glyphs.folder}</a>
      <a className={`bindit-rail__item bindit-rail__tool${active === 'games' ? ' is-active' : ''}`} href="#games" aria-label="Practice lab" title="Practice lab" aria-current={active === 'games' ? 'page' : undefined}>{glyphs.play}</a>
    </div>
  )

  const handle = canCollapse ? (
    <button
      type="button"
      className="bindit-rail__handle"
      aria-expanded={!isCollapsed}
      aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onClick={() => onCollapsedChange?.(!isCollapsed)}
    >
      {glyphs.handle}
    </button>
  ) : null

  return (
    <>
      <nav className={`bindit-rail${editing ? ' is-editing' : ''}${isCollapsed ? ' is-collapsed' : ''}`} aria-label="Sidebar">
        <div className="bindit-rail__top">
          {tools}
          {handle}
        </div>

        {isCollapsed ? null : (
          <>
            <div className="bindit-rail__account">
              <span className="bindit-rail__avatar" aria-hidden="true" />
              <a className="bindit-rail__name" href="#profile" aria-label={`Your profile, ${displayName}`}>{displayName}</a>
              <a className="bindit-rail__mini" href="#settings" aria-label="Account settings" title="Account settings">{glyphs.gear}</a>
            </div>

            {shown.map((id, index) => {
              const section = sections[id]
              const hidden = layout.hidden.includes(id)
              const folded = id === 'highlighted' && layout.collapsed.includes(id)
              const title = SECTION_TITLES[id]
              const headingId = `bindit-rail-${id}`
              const titleNode = <span className="bindit-rail__title">{title}</span>
              return (
                <section key={id} className={`bindit-rail__block is-${id}${hidden ? ' is-hidden' : ''}`} aria-labelledby={headingId}>
                  <h2 className="bindit-rail__heading">
                    {id === 'highlighted' && !editing ? (
                      <button type="button" id={headingId} className="bindit-rail__toggle" aria-expanded={!folded} aria-controls={`${headingId}-body`} onClick={() => toggleCollapsed(id)}>
                        {titleNode}{glyphs.chevron}
                      </button>
                    ) : (
                      <span id={headingId} className="bindit-rail__label">{titleNode}{hidden ? <small>hidden</small> : null}</span>
                    )}
                    {section.hatch && !editing ? <span className="bindit-rail__hatch" aria-hidden="true" /> : null}
                    {editing ? (
                      <span className="bindit-rail__controls">
                        <button type="button" className="bindit-rail__mini" onClick={() => move(id, -1)} disabled={index === 0} aria-label={`Move ${title} up`} title="Move up">{glyphs.up}</button>
                        <button type="button" className="bindit-rail__mini" onClick={() => move(id, 1)} disabled={index === shown.length - 1} aria-label={`Move ${title} down`} title="Move down">{glyphs.down}</button>
                        <button type="button" className="bindit-rail__mini" onClick={() => toggleHidden(id)} aria-pressed={!hidden} aria-label={hidden ? `Show ${title}` : `Hide ${title}`} title={hidden ? 'Show' : 'Hide'}>
                          {hidden ? glyphs.eyeOff : glyphs.eye}
                        </button>
                      </span>
                    ) : section.count !== undefined ? <span className="bindit-rail__count">{section.count}</span> : null}
                  </h2>
                  {!folded && !hidden ? <div id={`${headingId}-body`} className="bindit-rail__body">{section.body}</div> : null}
                </section>
              )
            })}

            <div className="bindit-rail__footer">
              <button type="button" className={`bindit-rail__lock${editing ? ' is-editing' : ''}`} aria-pressed={editing} onClick={() => setEditing((value) => !value)} aria-label={editing ? 'Done editing panel' : 'Edit panel'}>
                <span className="bindit-rail__lock-state">
                  <small>{editing ? 'editing' : 'locked'}</small>
                  <span className="bindit-rail__lock-box">
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="4" y="7.5" width="8" height="5.5" rx="1" />
                      {editing ? <path d="M5.8 7.5V5.6a2.2 2.2 0 0 1 4.2-.9" /> : <path d="M5.8 7.5V5.6a2.2 2.2 0 0 1 4.4 0v1.9" />}
                    </svg>
                  </span>
                </span>
                <span className="bindit-rail__lock-action">{editing ? 'done' : 'edit panel'}</span>
              </button>
              {editing ? (
                <button type="button" className="bindit-rail__mini" onClick={() => updateLayout(() => DEFAULT_LAYOUT)} aria-label="Reset panel layout" title="Reset layout">
                  {svg(<><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3" /><path d="M3.5 2.8v2.4h2.4" /></>)}
                </button>
              ) : null}
            </div>
          </>
        )}
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
        <button type="button" ref={menuButton} className={`bindit-tabbar__item${menuOpen || !TAB_BAR.includes(active) ? ' is-active' : ''}`} aria-expanded={menuOpen} aria-controls="bindit-menu" onClick={() => setMenuOpen((open) => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
          <span>Menu</span>
          {unreadTotal ? <i className="bindit-tabbar__dot" aria-hidden="true" /> : null}
        </button>
      </nav>

      {menuOpen ? (
        <div className="bindit-sheet" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) { setMenuOpen(false); menuButton.current?.focus({ preventScroll: true }) } }}>
          <div className="bindit-sheet__panel" id="bindit-menu" role="dialog" aria-modal="true" aria-label="All pages" ref={menuPanel}>
            {SECTIONS.map((section) => (
              <div key={section.label}>
                <span className="bindit-sheet__section">{section.label}</span>
                <ul className="bindit-sheet__grid">
                  {section.items.map((item) => (
                    <li key={item.id}><a href={`#${item.id}`} className={active === item.id ? 'is-active' : ''} onClick={() => setMenuOpen(false)}><NavIcon kind={item.id} />{item.label}{badge(item.id)}</a></li>
                  ))}
                </ul>
              </div>
            ))}
            {groups?.length ? (
              <div>
                <span className="bindit-sheet__section">My Groups</span>
                <ul className="bindit-sheet__groups">
                  {nestGroups(groups).map(({ group, child }) => {
                    const current = active === 'stats' && groupParam === group.id
                    return (
                      <li key={group.id} className={child ? 'is-child' : undefined}>
                        <a href={`#stats?group=${encodeURIComponent(group.id)}`} className={current ? 'is-active' : ''} aria-current={current ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
                          <span className="bindit-sheet__glyph">{glyphs.people}</span>
                          <span className="bindit-rail__entry-text">{group.name}</span>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}
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
