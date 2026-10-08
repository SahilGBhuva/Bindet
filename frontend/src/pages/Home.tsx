import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { parseServerTime, type FriendsHub, type NoteScope, type Profile, type Progress, type StudyGroup, type Task } from '../lib/api'
import { accountDisplayName } from '../lib/accountName'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { mergeNoteScopes, withCourseTones } from '../lib/session'
import { loadHiddenCourses } from '../lib/studyPrefs'
import { REVIEW_ALL_HASH, useReviewSummary } from '../lib/useReviewSummary'
import { saveThemePreference, useThemePreference, type ThemePreference } from '../lib/theme'
import type { Course } from '../lib/types'
import { ProfileSetupCard } from '../components/ProfileSetupCard'
import './Home.css'

/*
 * Home, drawn after the owner's pencil sketch, top to bottom:
 *  - a wide line landscape (date top-left, "Change themes" on the ground line, the otter on the
 *    hill line, a hatched field on the right) with "Hello, <name>" and the clock across its bottom;
 *  - the notification box at the top right;
 *  - "Project navigation": two cube-stack filters, then a folded accordion of project cards;
 *  - "Recent and upcoming" deadlines;
 *  - at the right, behind a hairline, the busiest group's team and statistics.
 * The page-icon row and the Merge pill above it belong to the app shell, not to Home.
 */

const DAY = 86_400_000
const COMPACT_WIDTH = 780 // keep in step with the container query in Home.css
const WINDOW = 6 // one open card and up to five folded slices
const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }
const THEME_NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_NAME: Record<ThemePreference, string> = { system: 'matching your system', light: 'light', dark: 'dark' }

type Filter = 'none' | 'courses' | 'groups'
type Badge = 'Upcoming' | 'Due' | 'Ongoing' | 'Overdue'

type Project = {
  key: string
  type: 'course' | 'group'
  name: string
  href: string
  caption: string
  due: string
  done: number
  total: number
  course?: Course
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dueAt(task: Task) {
  if (!task.due_date) return Infinity
  const value = Date.parse(`${task.due_date}T${task.due_time ? task.due_time.slice(0, 5) : '23:59'}`)
  return Number.isNaN(value) ? Infinity : value
}

function byDue(a: Task, b: Task) {
  const gap = dueAt(a) - dueAt(b)
  return (Number.isNaN(gap) ? 0 : gap) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
}

/* "10:43 am" */
function clock(timestamp: number) {
  return clockFormat.format(new Date(timestamp)).replace(/\s?([AP]M)$/i, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`)
}

function ordinal(day: number) {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`
}

/* "Sept. 7th" */
function shortDay(timestamp: number) {
  const date = new Date(timestamp)
  return `${MONTHS[date.getMonth()]} ${ordinal(date.getDate())}`
}

/* "8:59 pm today", "8:00 am tomorrow", "Sept. 20th" */
function whenText(task: Task, now: number) {
  const at = dueAt(task)
  if (at === Infinity) return 'No date'
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  const word = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : shortDay(at)
  if (!task.due_time) return word.charAt(0).toUpperCase() + word.slice(1)
  return `${clock(at)} ${word}`
}

/* "now", "2min", "3h", "4d" */
function relative(ms: number) {
  const minutes = Math.round(Math.abs(ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function badgeOf(task: Task, now: number): Badge {
  const at = dueAt(task)
  if (at < now) return 'Overdue'
  if (task.status === 'in_progress' || task.status === 'review') return 'Ongoing'
  return startOfDay(at) === startOfDay(now) ? 'Due' : 'Upcoming'
}

function localDate(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function firstWord(name: string) {
  return name.trim().split(/\s+/)[0] ?? name
}

/* First names, as drawn; two people who share one get a last initial ("Reilly K.", "Reilly U."). */
function shortNames(names: string[]) {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(firstWord(name), (counts.get(firstWord(name)) ?? 0) + 1)
  return names.map((name) => {
    const first = firstWord(name)
    const last = name.trim().split(/\s+/).slice(1).at(-1)
    return (counts.get(first) ?? 0) > 1 && last ? `${first} ${last[0]}.` : first
  })
}

/* ---------- Drawings ---------- */

/* The line landscape: long hill on the left, double ground line, grass, and a hatched field on the right. */
function Landscape() {
  return (
    <svg className="home-banner__art" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="home-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-38)">
          <line x1="0" y1="0" x2="0" y2="9" className="home-banner__hatch-line" />
        </pattern>
      </defs>
      <path className="home-banner__hill" d="M30 206C120 150 250 118 370 128s170 46 230 78" />
      <path className="home-banner__hill is-faint" d="M120 198c70-30 150-48 230-46" />
      <path className="home-banner__field" d="M760 206h440v94H690c28-22 40-40 30-56 18-12 26-24 40-38z" />
      <path className="home-banner__field-edge" d="M760 206c-14 14-22 26-40 38 10 16-2 34-30 56M900 206l-60 94M1040 206l-30 94M745 236h455M712 268h488" />
      <path className="home-banner__ground" d="M0 206h1200M0 212h700" />
      <path className="home-banner__grass" d="M600 206l4-13 3 13m6 0 5-17 2 17m8 0 3-10 3 10m26 0 3-11 4 11m5 0 4-15 2 15m40 0 3-9 3 9m5 0 5-14 2 14m7 0 3-8 3 8M210 206l3-9 3 9m5 0 4-12 2 12M60 206l3-8 3 8" />
    </svg>
  )
}

function Cloud({ className }: { className: string }) {
  return (
    <svg className={`home-banner__cloud ${className}`} viewBox="0 0 90 34" aria-hidden="true" focusable="false">
      <path d="M8 30c-6 0-7-9 1-10 0-9 12-12 17-5 4-11 21-12 25-1 8-5 19 0 17 8 9-1 12 8 4 8z" />
    </svg>
  )
}

/* One isometric cube at (x, y) = the top corner of its top face: top, left and right faces. */
function cube(x: number, y: number, s: number) {
  const w = s * 0.87
  const h = s / 2
  return [
    `M${x} ${y}l${w} ${h}l${-w} ${h}l${-w} ${-h}z`,
    `M${x - w} ${y + h}v${s}l${w} ${h}v${-s}z`,
    `M${x} ${y + s}v${s}l${w} ${-h}v${-s}z`,
  ]
}

/* Two stacks of cubes: a tall tower (courses) and a block (groups). */
function CubeStack({ tall }: { tall: boolean }) {
  const s = 9
  const cubes: [number, number, number][] = tall
    ? [[22, 31, 0], [22, 22, 1], [22, 13, 2], [22, 4, 3], [14.2, 35.5, 0], [29.8, 35.5, 0], [14.2, 26.5, 1]]
    : [[22, 22, 0], [14.2, 26.5, 0], [29.8, 26.5, 0], [22, 31, 0], [22, 13, 1], [14.2, 17.5, 1], [29.8, 17.5, 1], [22, 4, 2]]
  // Paint lower layers first, then back-to-front within a layer.
  const order = cubes.toSorted((a, b) => a[2] - b[2] || a[1] - b[1])
  return (
    <svg className="home-cubes__icon" viewBox="0 0 44 54" aria-hidden="true" focusable="false">
      {order.map(([x, y]) => (
        <g key={`${x}-${y}`}>{cube(x, y, s).map((d, face) => <path key={face} d={d} className={`is-face-${face}`} />)}</g>
      ))}
    </svg>
  )
}

/* A small flow diagram on a project card: four steps, filled as tasks get done. */
function Diagram({ done, total }: { done: number; total: number }) {
  const filled = total ? Math.round((done / total) * 4) : 0
  const steps: [number, number][] = [[4, 2], [22, 12], [4, 22], [22, 32]]
  return (
    <svg className="home-fold__diagram" viewBox="0 0 34 42" aria-hidden="true" focusable="false">
      <path d="M8 6 26 16 8 26 26 36" />
      {steps.map(([x, y], index) => <rect key={y} x={x} y={y} width="8" height="8" rx="1.5" className={index < filled ? 'is-done' : undefined} />)}
    </svg>
  )
}

type IconName = 'gear' | 'chart' | 'clock' | 'person' | 'bell' | 'smile' | 'target' | 'flame' | 'star' | 'check' | 'heart' | 'cards' | 'test' | 'bolt' | 'chat'
const ICONS: Record<IconName, ReactNode> = {
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M3.8 12.2l1.1-1.1M11.1 4.9l1.1-1.1" /></>,
  chart: <><path d="M2.5 13.5h11" /><path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></>,
  person: <><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13a4 4 0 0 1 8 0" /><path d="M10.5 3.6a2 2 0 0 1 0 3.8M12 9.8a3.6 3.6 0 0 1 2 3.2" /></>,
  bell: <><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" /><path d="M6.8 14a1.4 1.4 0 0 0 2.4 0" /></>,
  smile: <><circle cx="8" cy="8" r="6" /><path d="M5.6 9.6a3 3 0 0 0 4.8 0" /><path d="M6 6.4v.1M10 6.4v.1" /></>,
  target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /><path d="M8 8h.01" /></>,
  flame: <path d="M8 14c2.5 0 4-1.7 4-4 0-2.6-2-3.8-2.6-6.2C8.4 5 7.6 6.2 7.4 7.6 6.6 7 6.3 6.2 6.2 5.4 4.9 6.6 4 8 4 10c0 2.3 1.5 4 4 4z" />,
  star: <path d="M8 2.2l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.9l-3.4 1.8.7-3.8L2.5 6.2l3.8-.5z" />,
  check: <><circle cx="8" cy="8" r="5.5" /><path d="M5.6 8.2l1.7 1.7 3.2-3.4" /></>,
  heart: <path d="M8 13.2S2.5 10 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3C13.5 10 8 13.2 8 13.2z" />,
  cards: <><rect x="2.5" y="4.5" width="8.5" height="9" rx="1.2" /><path d="M5 2.5h7.3a1.2 1.2 0 0 1 1.2 1.2V11" /></>,
  test: <><rect x="3" y="2.5" width="10" height="11" rx="1.2" /><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" /></>,
  bolt: <path d="M9 1.8L3.8 9h3.6L7 14.2 12.2 7H8.6z" />,
  chat: <><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z" /></>,
}

function Icon({ name }: { name: IconName }) {
  return <svg className={`home-icon is-${name}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{ICONS[name]}</svg>
}

/* ---------- Page ---------- */

/* firstRun: the "Get started" list, passed in by the signed-in app only (never by the landing demo). */
export function Home({ session, firstRun = null }: { session: AuthSession | null; firstRun?: ReactNode }) {
  const data = useData()
  const token = session?.access_token
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [profile, setProfile] = useState<Profile | null>(() => token ? data.getCachedProfile(token) : null)
  // Signed in, but the server has no bindet profile for this account yet.
  const [profileMissing, setProfileMissing] = useState(false)
  const [social, setSocial] = useState<FriendsHub | null>(() => token ? data.getCachedFriends(token) : null)
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => token ? data.getCachedStudyGroups(token) : [])
  const [tasks, setTasks] = useState<Task[] | null>(() => token ? data.getCachedTasks(token) : [])
  const [now, setNow] = useState(() => data.now())
  // The landing demo never reads the visitor's storage.
  const theme = useThemePreference(!data.sandboxed)
  const [filter, setFilter] = useState<Filter>('none')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [compact, setCompact] = useState(false)
  // Set when the task refresh fails, so an empty list can say so instead of "Nothing due".
  const [tasksFailed, setTasksFailed] = useState(false)
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const frame = useRef<HTMLDivElement>(null)
  const cardLinks = useRef(new Map<string, HTMLAnchorElement>())
  const focusAfterOpen = useRef(false)
  // Flashcards due today: one extra row in the notification box (none when nothing is due).
  const reviewSummary = useReviewSummary(token)
  const reviewDue = reviewSummary?.due ?? 0
  const studentId = session?.user.id ?? data.getStudentId()
  const [stats, setStats] = useState<Progress | null>(() => data.getCachedProgress(studentId))
  // Saved notes per course and unit on the server, so Home counts notes added on any device.
  const [scopes, setScopes] = useState<NoteScope[] | null>(null)

  useEffect(() => {
    let active = true
    void data.getProgress(studentId, token).then((value) => { if (active) setStats(value) }).catch(() => undefined)
    void data.listNoteScopes(token).then((listed) => {
      if (!active) return
      setScopes(listed)
      const hidden = data.sandboxed ? [] : loadHiddenCourses()
      setNotebook((current) => {
        const merged = mergeNoteScopes(current, listed, hidden)
        return merged === current ? current : { ...merged, courses: withCourseTones(merged.courses) }
      })
    }, () => undefined)
    return () => { active = false }
  }, [data, studentId, token])

  // Cached values above render first; everything refreshes in parallel in the background.
  useEffect(() => {
    if (!token) return
    let active = true
    void data.getAccountProfile(token).then((value) => {
      if (!active) return
      setProfile(value)
      setProfileMissing(value === null)
    }).catch(() => undefined)
    void data.getFriends(token).then((value) => { if (active) setSocial(value) }).catch(() => undefined)
    void data.getStudyGroups(token).then((value) => {
      if (!active) return
      setGroups(value)
      setGroupsFailed(false)
    }).catch(() => {
      if (!active) return
      setGroupsFailed(true)
      setGroups((current) => current ?? [])
    })
    void data.getTasks(token, true).then((value) => {
      if (!active) return
      setTasks(value)
      setTasksFailed(false)
    }).catch(() => {
      if (!active) return
      setTasksFailed(true)
      setTasks((current) => current ?? [])
    })
    return () => { active = false }
  }, [data, token, reload])

  function retryTasks() {
    setTasksFailed(false)
    setTasks(null)
    setReload((value) => value + 1)
  }

  function retryGroups() {
    setGroupsFailed(false)
    setGroups(null)
    setReload((value) => value + 1)
  }

  // The clock ticks on the minute. The demo keeps its pinned time.
  useEffect(() => {
    if (data.sandboxed) return
    let interval = 0
    const tick = () => setNow(data.now())
    const timeout = window.setTimeout(() => {
      tick()
      interval = window.setInterval(tick, 60_000)
    }, 60_000 - (Date.now() % 60_000))
    return () => { window.clearTimeout(timeout); window.clearInterval(interval) }
  }, [data])

  // Layout switches with a container query; this only tells the accordion whether folded
  // cards are swipeable (narrow) or have to be opened first (wide). No visual change follows.
  useEffect(() => {
    const node = frame.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= COMPACT_WIDTH))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const courses = notebook.courses
  const firstName = firstWord(profile?.display_name || accountDisplayName(session?.user))
  const openTasks = (tasks ?? []).filter((task) => task.status !== 'done').toSorted(byDue)
  const dated = openTasks.filter((task) => dueAt(task) !== Infinity)

  // Deadlines: recent (up to three days late) and upcoming; three rows, as drawn.
  const deadlines = dated.filter((task) => dueAt(task) >= now - 3 * DAY && (task.kind !== 'event' || dueAt(task) >= now)).slice(0, 3)

  // Notification: the next event or task; failing that, the newest unread notice.
  const nextItem = dated.find((task) => dueAt(task) >= now)
  const unread = (social?.notifications ?? []).filter((item) => !item.is_read).toSorted((a, b) => parseServerTime(b.created_at) - parseServerTime(a.created_at))[0]

  function cycleTheme() {
    if (data.sandboxed) return
    saveThemePreference(THEME_NEXT[theme])
  }

  function openCourse(course: Course) {
    const next = { ...data.loadNotebook(), activeCourse: course.name, activeUnit: course.units[0] ?? '' }
    try {
      data.saveNotebook(next)
    } catch {
      // Storage can be unavailable; Study still opens on its default course.
    }
    setNotebook({ ...next, courses: withCourseTones(next.courses) })
  }

  // Projects: the student's courses and study groups.
  const projects: Project[] = [
    ...courses.map((course): Project => {
      const related = (tasks ?? []).filter((task) => task.course === course.name)
      const next = related.filter((task) => task.status !== 'done' && dueAt(task) !== Infinity).toSorted(byDue)[0]
      const localNotes = notebook.deposits.filter((note) => note.course === course.name).length
      const serverNotes = (scopes ?? []).filter((scope) => scope.course === course.name).reduce((sum, scope) => sum + scope.note_count, 0)
      const notes = Math.max(localNotes, serverNotes)
      return {
        key: `course-${course.name}`,
        type: 'course',
        name: course.name,
        href: '#tools',
        caption: `course, ${course.units.length} ${course.units.length === 1 ? 'unit' : 'units'}, ${notes} ${notes === 1 ? 'note' : 'notes'}`,
        due: next ? shortDay(dueAt(next)) : 'No due date',
        done: related.filter((task) => task.status === 'done').length,
        total: related.length,
        course,
      }
    }),
    ...(groups ?? []).map((group): Project => {
      const related = (tasks ?? []).filter((task) => task.group_id === group.id)
      const next = related.filter((task) => task.status !== 'done' && dueAt(task) !== Infinity).toSorted(byDue)[0]
      return {
        key: `group-${group.id}`,
        type: 'group',
        name: group.name,
        href: `#stats?group=${encodeURIComponent(group.id)}`,
        caption: group.description.trim() || `group project, ${group.members.length} ${group.members.length === 1 ? 'member' : 'members'}`,
        due: next ? shortDay(dueAt(next)) : 'No due date',
        done: related.filter((task) => task.status === 'done').length,
        total: related.length,
      }
    }),
  ]
  const shown = projects.filter((project) => filter === 'none' || (filter === 'courses' ? project.type === 'course' : project.type === 'group'))
  const openIndex = Math.max(0, shown.findIndex((project) => project.key === openKey))
  const openProject = shown[openIndex]
  const projectsLoading = Boolean(token) && (groups === null || tasks === null) && !shown.length
  const visible = Math.min(shown.length, WINDOW)
  const windowStart = Math.min(Math.max(0, openIndex - 1), Math.max(0, shown.length - WINDOW))
  const markerAt = shown.length > 1 ? openIndex / (shown.length - 1) : 0

  // After a keyboard move, focus the card once it has rendered open.
  useEffect(() => {
    if (!focusAfterOpen.current || !openProject) return
    focusAfterOpen.current = false
    cardLinks.current.get(openProject.key)?.focus()
  }, [openProject])

  function openAt(index: number, focus: boolean) {
    const project = shown[Math.min(Math.max(index, 0), shown.length - 1)]
    if (!project) return
    focusAfterOpen.current = focus
    setOpenKey(project.key)
  }

  function onAccordionKey(event: KeyboardEvent<HTMLUListElement>) {
    if (compact) return
    const moves: Record<string, number> = { ArrowRight: openIndex + 1, ArrowLeft: openIndex - 1, Home: 0, End: shown.length - 1 }
    if (!(event.key in moves)) return
    event.preventDefault()
    openAt(moves[event.key], true)
  }

  function toggleFilter(next: Filter) {
    setFilter((current) => current === next ? 'none' : next)
    setOpenKey(null)
  }

  // The team panel shows the group with the most open work: the one that needs attention.
  const groupOpen = (group: StudyGroup) => openTasks.filter((task) => task.group_id === group.id).length
  const group = (groups ?? []).toSorted((a, b) => groupOpen(b) - groupOpen(a))[0]
  const groupTasks = group ? (tasks ?? []).filter((task) => task.group_id === group.id) : []
  const groupOpenTasks = groupTasks.filter((task) => task.status !== 'done').toSorted(byDue)
  const statsHref = group ? `#stats?group=${encodeURIComponent(group.id)}` : '#stats'
  const assignedPeople = new Set(groupOpenTasks.flatMap((task) => task.assignees.map((person) => person.student_id)))
  const leads = group?.members.filter((member) => member.role === 'owner').length ?? 0
  const milestones = new Set(groupTasks.map((task) => task.milestone_id).filter((value) => value !== null))
  const groupDone = groupTasks.filter((task) => task.status === 'done').length

  const teamStats = group ? [
    { label: 'Progress:', value: groupTasks.length ? `${Math.round((groupDone / groupTasks.length) * 100)}%` : '—' },
    { label: 'Assigned workload', value: groupOpenTasks.length ? `${groupOpenTasks.length} open, ${assignedPeople.size} ${assignedPeople.size === 1 ? 'person' : 'people'}` : 'none open' },
    { label: 'Roles', value: `${leads} ${leads === 1 ? 'lead' : 'leads'}, ${group.members.length - leads} ${group.members.length - leads === 1 ? 'member' : 'members'}` },
    { label: 'Budget', value: '—' },
    { label: 'Major milestones', value: milestones.size ? String(milestones.size) : '—' },
  ] : []

  const teamMembers = group?.members.slice(0, 6) ?? []
  const teamNames = shortNames(teamMembers.map((member) => member.display_name))

  // Today's numbers for the colored stat cards (the same server totals the Progress page shows).
  const goal = profile?.daily_goal ?? 20
  const todayXp = stats?.recent_xp?.find((day) => day.day === localDate(now))?.xp ?? 0
  const goalPercent = Math.min(100, Math.round((todayXp / Math.max(goal, 1)) * 100))
  const streak = Math.max(stats?.streak ?? profile?.streak ?? 0, 0)
  const accuracy = stats && stats.attempts > 0 ? Math.round(stats.accuracy) : null
  const friendCount = social?.friends.length ?? 0
  const reviewNew = reviewSummary?.new_available ?? 0
  const studyNext: { key: string; tone: string; icon: IconName; title: string; copy: string; href: string; review?: boolean }[] = [
    {
      key: 'review', tone: 'violet', icon: 'cards', href: REVIEW_ALL_HASH, review: true, title: 'Review flashcards',
      copy: reviewDue ? `${reviewDue} ${reviewDue === 1 ? 'card is' : 'cards are'} due now` : reviewNew ? `${reviewNew} new ${reviewNew === 1 ? 'card' : 'cards'} to learn` : 'All caught up for now',
    },
    { key: 'test', tone: 'blue', icon: 'test', href: '#tools', title: 'Take a practice test', copy: 'A timed test from your notes' },
    { key: 'round', tone: 'orange', icon: 'bolt', href: '#games', title: 'Play a quick round', copy: 'Beat your best in 1, 2 or 5 minutes' },
    { key: 'tutor', tone: 'teal', icon: 'chat', href: '#tutor', title: 'Ask Otto', copy: 'Get unstuck on a problem' },
  ]

  function currentlyOn(studentId: string) {
    const mine = groupOpenTasks.filter((task) => task.assignees.some((person) => person.student_id === studentId))
    return mine.find((task) => task.status === 'in_progress') ?? mine[0]
  }

  const filterLabel = filter === 'none' ? 'none' : filter === 'courses' ? 'Courses' : 'Groups'

  return (
    <div className="ui-page home">
      <div className="home__frame" ref={frame}>
        <header className="home-hero">
          <section className="home-banner" aria-label="Today">
            <Landscape />
            <Cloud className="is-one" />
            <Cloud className="is-two" />
            <Cloud className="is-three" />
            <img className="home-banner__otter" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" decoding="async" />
            <p className="home-banner__date"><time dateTime={localDate(now)}>{monthDay.format(new Date(now))}</time></p>
            <button
              type="button"
              className="home-banner__theme"
              onClick={cycleTheme}
              aria-disabled={data.sandboxed || undefined}
              title={data.sandboxed ? 'Available in the app' : `Theme: ${THEME_NAME[theme]}`}
            >
              Change themes <Icon name="gear" />
            </button>
            <div className="home-hello">
              <h1 className="home-hello__title">
                Hello{firstName ? `, ${firstName}` : ''} <Icon name="smile" />
              </h1>
              <time className="home-hello__clock" dateTime={new Date(now).toISOString()}>{clock(now)}</time>
            </div>
          </section>

          <section className="home-notice" aria-labelledby="home-notice-title">
            <span className="home-notice__corner" aria-hidden="true"><Icon name="bell" /></span>
            <h2 className="home-notice__title" id="home-notice-title"><a href="#profile">View notifications:</a></h2>
            {reviewDue ? (
              <a className="home-notice__row home-notice__review" href={REVIEW_ALL_HASH} data-review-link="">
                <span className="home-badge home-badge--review">Review</span>
                <span className="home-notice__text">{reviewDue} {reviewDue === 1 ? 'flashcard' : 'flashcards'} due</span>
                <span className="home-notice__time">now</span>
              </a>
            ) : null}
            {tasks === null && !unread ? (
              <span className="ui-skeleton home-notice__skeleton" aria-hidden="true" />
            ) : nextItem ? (
              <a className="home-notice__row" href="#goals">
                <span className="home-badge">{nextItem.kind === 'event' ? 'Event' : 'Task'}</span>
                <span className="home-notice__text">{nextItem.title}</span>
                <span className="home-notice__time"><span className="sr-only">in </span>{relative(dueAt(nextItem) - now)}</span>
              </a>
            ) : unread ? (
              <a className="home-notice__row" href="#profile">
                <span className="home-badge">New</span>
                <span className="home-notice__text">{unread.message}</span>
                <span className="home-notice__time">{relative(now - parseServerTime(unread.created_at))}<span className="sr-only"> ago</span></span>
              </a>
            ) : reviewDue && !tasksFailed ? null : (
              <p className="home-notice__quiet">{tasksFailed ? 'Couldn’t check right now.' : 'All caught up.'}</p>
            )}
          </section>
        </header>

        {session && profileMissing && !data.sandboxed ? <ProfileSetupCard className="home-setup" /> : null}
        {data.sandboxed ? null : firstRun}

        <ul className="home-today" aria-label="Today at a glance">
          <li className="home-today__card ui-tone--blue">
            <a href="#settings" className="home-today__link">
              <span className="home-today__icon"><Icon name="target" /></span>
              <span className="home-today__label">Daily goal</span>
              <span className="home-today__value">{todayXp}<small> / {goal} XP</small></span>
              <span className="home-today__meter" aria-hidden="true"><span style={{ width: `${goalPercent}%` }} /></span>
            </a>
          </li>
          <li className="home-today__card ui-tone--orange">
            <a href="#stats" className="home-today__link">
              <span className="home-today__icon"><Icon name="flame" /></span>
              <span className="home-today__label">Streak</span>
              <span className="home-today__value">{streak}<small> {streak === 1 ? 'day' : 'days'}</small></span>
              {streak >= 7 ? <img className="ui-mascot-cheer home-today__cheer" src="/bindit-mascot-cutout.webp" alt="" width="36" height="43" /> : null}
            </a>
          </li>
          <li className="home-today__card ui-tone--violet">
            <a href="#stats" className="home-today__link">
              <span className="home-today__icon"><Icon name="star" /></span>
              <span className="home-today__label">Total XP</span>
              <span className="home-today__value">{(stats?.total_xp ?? profile?.total_xp ?? 0).toLocaleString()}</span>
            </a>
          </li>
          <li className={`home-today__card ${accuracy === null || accuracy >= 70 ? 'ui-tone--green' : 'ui-tone--amber'}`}>
            <a href="#stats" className="home-today__link">
              <span className="home-today__icon"><Icon name="check" /></span>
              <span className="home-today__label">Quiz accuracy</span>
              <span className="home-today__value">{accuracy === null ? '—' : <>{accuracy}<small>%</small></>}</span>
            </a>
          </li>
          <li className="home-today__card ui-tone--pink">
            <a href="#profile" className="home-today__link">
              <span className="home-today__icon"><Icon name="heart" /></span>
              <span className="home-today__label">Friends</span>
              <span className="home-today__value">{friendCount}</span>
            </a>
          </li>
        </ul>

        <div className="home__grid">
          <div className="home__main">
            <section className="home-projects" aria-labelledby="home-projects-title">
              <h2 className="home-heading" id="home-projects-title">
                Project navigation <span className="home-heading__chevrons" aria-hidden="true">⟩ ⟩</span>
              </h2>

              <div className="home-projects__box">
                <div className="home-cubes" role="group" aria-label="Filter projects">
                  {/* home-filter__select: the landing demo lets controls with this class work. */}
                  <button type="button" className="home-cubes__button home-filter__select" aria-pressed={filter === 'courses'} aria-label="Show courses only" title="Courses" onClick={() => toggleFilter('courses')}>
                    <CubeStack tall />
                  </button>
                  <button type="button" className="home-cubes__button home-filter__select" aria-pressed={filter === 'groups'} aria-label="Show groups only" title="Groups" onClick={() => toggleFilter('groups')}>
                    <CubeStack tall={false} />
                  </button>
                </div>

                <div className="home-carousel">
                  <div className="home-carousel__top">
                    <span className="home-carousel__filters" aria-live="polite">Filters: {filterLabel}</span>
                    <span className="home-carousel__count">{projectsLoading ? '' : <>{shown.length}<span className="sr-only"> projects</span></>}</span>
                  </div>
                  <div className="home-carousel__rule-row">
                    <span className="home-rule" aria-hidden="true">
                      <span className="home-rule__track" style={{ '--p': markerAt } as CSSProperties}><span className="home-rule__m">M</span></span>
                    </span>
                    <a className="home-carousel__all ui-link" href={filter === 'groups' ? '#profile' : '#tools'}>See all <span aria-hidden="true">⟩</span></a>
                  </div>

                  {projectsLoading ? (
                    <div className="home-fold is-loading" aria-busy="true" aria-label="Loading projects">
                      <span className="ui-skeleton home-fold__skeleton" />
                      <span className="ui-skeleton home-fold__skeleton is-slices" />
                    </div>
                  ) : shown.length ? (
                    <>
                      <ul
                        className={`home-fold${compact ? ' is-compact' : ''}`}
                        style={{ '--count': visible } as CSSProperties}
                        aria-label="Projects. Use the left and right arrow keys to open the next card."
                        onKeyDown={onAccordionKey}
                      >
                        {shown.map((project, index) => {
                          const isOpen = index === openIndex
                          const inWindow = index >= windowStart && index < windowStart + WINDOW
                          const w = Math.min(Math.max(index - windowStart, 0), visible - 1)
                          const after = index > openIndex ? 1 : 0
                          const reachable = compact || isOpen
                          const isEnd = !isOpen && index === windowStart + visible - 1
                          const isFirst = !isOpen && index === windowStart
                          return (
                            <li
                              key={project.key}
                              className={`home-fold__card${isOpen ? ' is-open' : ''}${inWindow ? '' : ' is-away'}${isEnd ? ' is-end' : ''}${isFirst ? ' is-first' : ''}`}
                              style={{ '--w': w, '--after': after, zIndex: inWindow ? WINDOW + 1 - Math.abs(index - openIndex) : 0 } as CSSProperties}
                              aria-hidden={!compact && !inWindow ? true : undefined}
                            >
                              <div className="home-fold__body" inert={!reachable}>
                                <a
                                  className="home-fold__link"
                                  href={project.href}
                                  ref={(node) => {
                                    if (node) cardLinks.current.set(project.key, node)
                                    else cardLinks.current.delete(project.key)
                                  }}
                                  onClick={() => { if (project.course) openCourse(project.course) }}
                                >
                                  <strong className="home-fold__name">{project.name}</strong>
                                  <Diagram done={project.done} total={project.total} />
                                  <span className="home-fold__due"><Icon name="clock" /><span className="sr-only">Due </span>{project.due}</span>
                                </a>
                              </div>
                              {!compact && !isOpen && inWindow ? (
                                <button
                                  type="button"
                                  className="home-fold__slice home-arrow"
                                  aria-expanded="false"
                                  aria-label={`Open ${project.name}`}
                                  title={project.name}
                                  onClick={() => openAt(index, true)}
                                />
                              ) : null}
                            </li>
                          )
                        })}
                      </ul>
                      {openProject ? (
                        <p className="home-fold__caption" aria-live="polite">
                          <span>{openProject.name}: {openProject.caption}</span>
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="home-fold__empty">
                      <p>{filter === 'groups' ? 'No group projects yet.' : 'No projects yet.'}</p>
                      <a className="ui-link" href={filter === 'groups' ? '#profile' : '#tools'}>{filter === 'groups' ? 'Find a group' : 'Create a course'}</a>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="home-deadlines" aria-labelledby="home-deadlines-title">
              <p className="home-deadlines__eyebrow"><span aria-hidden="true">↙</span> Recent and upcoming</p>
              <h2 className="home-deadlines__title" id="home-deadlines-title">Deadlines</h2>
              {tasks === null ? (
                <div className="home-rows" aria-busy="true" aria-label="Loading deadlines">
                  <span className="ui-skeleton home-rows__skeleton" /><span className="ui-skeleton home-rows__skeleton" /><span className="ui-skeleton home-rows__skeleton" />
                </div>
              ) : tasksFailed && !deadlines.length ? (
                <p className="home-rows__empty" role="alert">Deadlines couldn’t load. <button type="button" className="ui-link" onClick={retryTasks}>Try again</button></p>
              ) : deadlines.length ? (
                <ul className="home-rows">
                  {deadlines.map((task) => {
                    const badge = badgeOf(task, now)
                    return (
                      <li key={task.id}>
                        <a className="home-row" href="#goals">
                          <span className={`home-badge is-${badge.toLowerCase()}`}>{badge}</span>
                          <span className="home-row__title">{task.title}</span>
                          <span className="home-row__leader" aria-hidden="true" />
                          <span className="home-row__time">{whenText(task, now)}</span>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="home-rows__empty">Nothing due. <a className="ui-link" href="#goals">Add a task</a></p>
              )}
            </section>
          </div>

          <aside className="home-team" aria-labelledby="home-team-title">
            {groups === null ? (
              <div className="home-team__loading" aria-busy="true" aria-label="Loading your group">
                <span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" />
              </div>
            ) : group ? (
              <>
                <div className="home-team__head">
                  <h2 className="home-team__name" id="home-team-title">{group.name}</h2>
                  <a className="home-team__icon" href="#profile" aria-label={`Group settings for ${group.name}`} title="Group settings"><Icon name="gear" /></a>
                  <a className="home-team__icon" href={statsHref} aria-label={`Project statistics for ${group.name}`} title="Project statistics"><Icon name="chart" /></a>
                </div>

                <table className="home-members">
                  <thead>
                    <tr><th scope="col">Team member</th><th scope="col">Currently on</th></tr>
                  </thead>
                  <tbody>
                    {teamMembers.map((member, index) => {
                      const focus = currentlyOn(member.student_id)
                      const name = teamNames[index]
                      return (
                        <tr key={member.student_id}>
                          <th scope="row" title={member.display_name}><Icon name="person" /><span>{name}</span></th>
                          <td title={focus?.title}>{focus ? focus.title : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <h3 className="home-team__label" id="home-team-stats">Team statistics:</h3>
                <ul className="home-stats" aria-labelledby="home-team-stats">
                  {teamStats.map((item) => (
                    <li key={item.label}>
                      <a href={statsHref}><span>{item.label}</span> <small>{item.value}</small></a>
                    </li>
                  ))}
                </ul>
              </>
            ) : groupsFailed ? (
              <div className="home-team__empty" role="alert">
                <h2 className="home-team__name" id="home-team-title">Your group</h2>
                <p>Your groups couldn’t load.</p>
                <button type="button" className="ui-link" onClick={retryGroups}>Try again</button>
              </div>
            ) : (
              <div className="home-team__empty">
                <h2 className="home-team__name" id="home-team-title">No group yet</h2>
                <p>Members, what each is on, and team statistics show here.</p>
                <a className="ui-link" href="#profile">Find or start a group</a>
              </div>
            )}

            <section className="home-next" aria-labelledby="home-next-title">
              <h2 className="home-next__title" id="home-next-title">Study next</h2>
              <ul className="home-next__list">
                {studyNext.map((item) => (
                  <li key={item.key}>
                    <a className={`home-next__item ui-tone--${item.tone}`} href={item.href} data-review-link={item.review ? '' : undefined}>
                      <span className="ui-icon"><Icon name={item.icon} /></span>
                      <span className="home-next__text">
                        <strong>{item.title}</strong>
                        <span>{item.copy}</span>
                      </span>
                      <span className="home-next__arrow" aria-hidden="true">›</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
