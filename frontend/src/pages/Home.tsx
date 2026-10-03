import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { parseServerTime, type FriendsHub, type Profile, type StudyGroup, type Task } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { withCourseTones } from '../lib/session'
import { loadThemePreference, saveThemePreference, type ThemePreference } from '../lib/theme'
import { courseInitial } from '../lib/tones'
import type { Course } from '../lib/types'
import './Home.css'

/*
 * Home, after the student's sketch: the date and notifications, a quiet landscape
 * banner, a greeting with the time, the projects they are part of, their deadlines,
 * and their main study group's team panel.
 */

const DAY = 86_400_000
const MUTE_KEY = 'bindit:home:mute-notifications'
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }
const THEME_NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_NAME: Record<ThemePreference, string> = { system: 'matching your system', light: 'light', dark: 'dark' }

type Filter = 'all' | 'courses' | 'groups'
type Kind = 'event' | 'overdue' | 'today' | 'upcoming'
const KIND_LABEL: Record<Kind, string> = { event: 'Event', overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming' }

type Project = {
  key: string
  type: 'course' | 'group'
  name: string
  href: string
  detail: string
  due: string
  done: number
  total: number
  tone?: string
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

function clock(timestamp: number) {
  return clockFormat.format(new Date(timestamp)).replace(/\s?([AP]M)$/i, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`)
}

function dayWord(timestamp: number, now: number) {
  const days = Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  return shortDate.format(new Date(timestamp))
}

/* "8:59 pm today", "8:00 am tomorrow", or just "Today" when no time is set. */
function whenText(task: Task, now: number) {
  const at = dueAt(task)
  if (at === Infinity) return 'No date'
  const word = dayWord(at, now)
  if (!task.due_time) return word.charAt(0).toUpperCase() + word.slice(1)
  return `${clock(at)} ${word}`
}

function kindOf(task: Task, now: number): Kind {
  if (task.kind === 'event') return 'event'
  const at = dueAt(task)
  if (at < now) return 'overdue'
  return startOfDay(at) === startOfDay(now) ? 'today' : 'upcoming'
}

function localDate(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function nameInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, '1')
    else localStorage.removeItem(MUTE_KEY)
  } catch {
    // Storage can be unavailable; the choice still applies for this visit.
  }
}

/* A calm line drawing: distant hills, a near hill on the left, a ground line and grass. */
function Landscape() {
  return (
    <svg className="home-banner__art" viewBox="0 0 1200 220" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
      <circle className="home-banner__sun" cx="1040" cy="58" r="22" />
      <path className="home-banner__cloud" d="M300 64c6-16 30-18 38-4 10-12 34-8 34 10h-86c0-4 6-8 14-6z" />
      <path className="home-banner__cloud" d="M760 44c5-12 24-14 30-3 8-9 27-6 27 8h-68c0-3 5-6 11-5z" />
      <path className="home-banner__far" d="M0 176c120-34 210-46 320-30s180 22 280 4 210-48 330-36 190 34 270 38v68H0z" />
      <path className="home-banner__near" d="M-20 188c70-58 190-92 330-72 90 13 150 44 190 72z" />
      <path className="home-banner__ground" d="M0 188h1200" />
      <path className="home-banner__grass" d="M540 188l4-12 3 12m6 0 5-16 2 16m8 0 3-9 3 9M660 188l3-10 4 10m5 0 4-14 2 14M860 188l3-11 3 11m5 0 5-15 2 15m7 0 3-8 3 8M960 188l4-13 2 13m6 0 3-9 3 9M120 188l3-9 3 9m5 0 4-12 2 12" />
      <path className="home-banner__hatch" d="M1010 188l40-24M1036 188l40-24M1062 188l40-24M1088 188l40-24M1114 188l40-24M1140 188l40-24" />
    </svg>
  )
}

export function Home({ session }: { session: AuthSession | null }) {
  const data = useData()
  const token = session?.access_token
  const studentId = session?.user.id ?? ''
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [profile, setProfile] = useState<Profile | null>(() => token ? data.getCachedProfile(token) : null)
  const [social, setSocial] = useState<FriendsHub | null>(() => token ? data.getCachedFriends(token) : null)
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => token ? data.getCachedStudyGroups(token) : [])
  const [tasks, setTasks] = useState<Task[] | null>(() => token ? data.getCachedTasks(token) : [])
  const [now, setNow] = useState(() => data.now())
  const [muted, setMuted] = useState(() => data.sandboxed ? false : readMuted())
  const [theme, setTheme] = useState<ThemePreference>(() => data.sandboxed ? 'system' : loadThemePreference())
  const [filter, setFilter] = useState<Filter>('all')
  const rail = useRef<HTMLUListElement>(null)

  // Cached values above render first; everything refreshes in parallel in the background.
  useEffect(() => {
    if (!token) return
    let active = true
    void data.getAccountProfile(token).then((value) => { if (active) setProfile(value) }).catch(() => undefined)
    void data.getFriends(token).then((value) => { if (active) setSocial(value) }).catch(() => undefined)
    void data.getStudyGroups(token).then((value) => { if (active) setGroups(value) }).catch(() => { if (active) setGroups((current) => current ?? []) })
    void data.getTasks(token, true).then((value) => { if (active) setTasks(value) }).catch(() => { if (active) setTasks((current) => current ?? []) })
    return () => { active = false }
  }, [data, token])

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

  const courses = notebook.courses
  const firstName = profile?.display_name?.split(/\s+/)[0] || session?.user.user_metadata?.username || ''
  const openTasks = (tasks ?? []).filter((task) => task.status !== 'done').toSorted(byDue)
  const dated = openTasks.filter((task) => dueAt(task) !== Infinity)
  const deadlines = dated.filter((task) => task.kind !== 'event' || dueAt(task) >= startOfDay(now)).slice(0, 6)

  // Notifications: the next thing on the calendar, plus unread social notifications.
  const nextItem = dated.find((task) => dueAt(task) >= now) ?? dated[0]
  const unread = (social?.notifications ?? []).filter((item) => !item.is_read).toSorted((a, b) => parseServerTime(b.created_at) - parseServerTime(a.created_at))

  function toggleMute() {
    const next = !muted
    setMuted(next)
    if (!data.sandboxed) writeMuted(next)
  }

  function cycleTheme() {
    const next = THEME_NEXT[theme]
    setTheme(next)
    saveThemePreference(next)
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

  // Projects: one card per course in the notebook and per study group.
  const projects: Project[] = [
    ...courses.map((course): Project => {
      const related = (tasks ?? []).filter((task) => task.course === course.name)
      const next = related.filter((task) => task.status !== 'done').toSorted(byDue)[0]
      const notes = notebook.deposits.filter((note) => note.course === course.name)
      const latest = notes.map((note) => Date.parse(note.createdAt)).filter((value) => !Number.isNaN(value)).toSorted((a, b) => b - a)[0]
      return {
        key: `course-${course.name}`,
        type: 'course',
        name: course.name,
        href: '#tools',
        detail: `${course.units.length} ${course.units.length === 1 ? 'unit' : 'units'} · ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`,
        due: next && dueAt(next) !== Infinity ? `Next due ${dayWord(dueAt(next), now)}` : latest ? `Updated ${shortDate.format(new Date(latest))}` : 'No notes yet',
        done: related.filter((task) => task.status === 'done').length,
        total: related.length,
        tone: course.tone,
        course,
      }
    }),
    ...(groups ?? []).map((group): Project => {
      const related = (tasks ?? []).filter((task) => task.group_id === group.id)
      const next = related.filter((task) => task.status !== 'done').toSorted(byDue)[0]
      return {
        key: `group-${group.id}`,
        type: 'group',
        name: group.name,
        href: `#stats?group=${encodeURIComponent(group.id)}`,
        detail: `${group.members.length} ${group.members.length === 1 ? 'member' : 'members'}`,
        due: next && dueAt(next) !== Infinity ? `Next due ${dayWord(dueAt(next), now)}` : `Started ${shortDate.format(new Date(parseServerTime(group.created_at)))}`,
        done: related.filter((task) => task.status === 'done').length,
        total: related.length,
      }
    }),
  ]
  const shownProjects = projects.filter((project) => filter === 'all' || (filter === 'courses' ? project.type === 'course' : project.type === 'group'))
  const projectsLoading = Boolean(token) && groups === null && !courses.length

  const scrollRail = (direction: -1 | 1) => {
    const node = rail.current
    if (!node) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollBy({ left: direction * Math.max(220, node.clientWidth * 0.8), behavior: reduce ? 'auto' : 'smooth' })
  }

  // The team panel shows the group with the most open work, so it is the one that needs attention.
  const groupOpen = (group: StudyGroup) => openTasks.filter((task) => task.group_id === group.id).length
  const group = (groups ?? []).toSorted((a, b) => groupOpen(b) - groupOpen(a))[0]
  const groupTasks = group ? (tasks ?? []).filter((task) => task.group_id === group.id) : []
  const groupOpenTasks = groupTasks.filter((task) => task.status !== 'done').toSorted(byDue)
  const statsHref = group ? `#stats?group=${encodeURIComponent(group.id)}` : '#stats'
  const assignedPeople = new Set(groupOpenTasks.flatMap((task) => task.assignees.map((person) => person.student_id)))
  const owners = group?.members.filter((member) => member.role === 'owner') ?? []
  const milestones = new Set(groupTasks.map((task) => task.milestone_id).filter((value) => value !== null))
  const groupDone = groupTasks.filter((task) => task.status === 'done').length

  const teamStats = group ? [
    { label: 'Progress', detail: groupTasks.length ? `${groupDone} of ${groupTasks.length} tasks done` : 'No tasks yet' },
    { label: 'Assigned workload', detail: groupOpenTasks.length ? `${groupOpenTasks.length} open · ${assignedPeople.size} ${assignedPeople.size === 1 ? 'person' : 'people'}` : 'Nothing open' },
    { label: 'Roles', detail: owners.length ? `${owners.map((member) => member.display_name.split(/\s+/)[0]).join(', ')} ${owners.length === 1 ? 'leads' : 'lead'}` : `${group.members.length} members` },
    { label: 'Major milestones', detail: milestones.size ? `${milestones.size} ${milestones.size === 1 ? 'milestone' : 'milestones'}` : 'None set' },
  ] : []

  return (
    <div className="ui-page home">
      <header className="home-top">
        <p className="home-top__date"><time dateTime={localDate(now)}>{monthDay.format(new Date(now))}</time></p>

        <section className={`home-notice${muted ? ' is-muted' : ''}`} aria-labelledby="home-notice-title">
          <div className="home-notice__head">
            <a id="home-notice-title" className="home-notice__title" href="#profile">
              View notifications
              {unread.length && !muted ? <span className="ui-count" aria-label={`${unread.length} unread`}>{unread.length}</span> : null}
            </a>
            <button type="button" className="home-notice__mute" aria-pressed={muted} onClick={toggleMute}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" /><path d="M6.8 14a1.4 1.4 0 0 0 2.4 0" />
                {muted ? <path d="M2.5 2.5l11 11" /> : null}
              </svg>
              {muted ? 'Muted' : 'Mute'}
            </button>
          </div>
          {muted ? (
            <p className="home-notice__quiet">Notifications are muted on this device.</p>
          ) : tasks === null ? (
            <span className="ui-skeleton home-notice__skeleton" aria-hidden="true" />
          ) : (
            <ul className="home-notice__list">
              {nextItem ? (
                <li>
                  <a href="#goals">
                    <span className={`home-kind is-${kindOf(nextItem, now)}`}>{KIND_LABEL[kindOf(nextItem, now)]}</span>
                    <span className="home-notice__text">{nextItem.title}</span>
                    <small>{whenText(nextItem, now)}</small>
                  </a>
                </li>
              ) : null}
              {unread[0] ? (
                <li>
                  <a href="#profile">
                    <span className="home-kind is-social">New</span>
                    <span className="home-notice__text">{unread[0].message}</span>
                  </a>
                </li>
              ) : null}
              {!nextItem && !unread[0] ? <li className="home-notice__quiet">You are all caught up.</li> : null}
            </ul>
          )}
        </section>
      </header>

      <section className="home-banner" aria-label="Banner">
        <Landscape />
        <img className="home-banner__otter" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" decoding="async" />
        <button type="button" className="home-banner__theme" onClick={cycleTheme} title={`Theme: ${THEME_NAME[theme]}`}>
          Change theme
        </button>
      </section>

      <div className="home-hello">
        <h1 className="ui-page-title">Hello{firstName ? <>, <em>{firstName}</em></> : null}</h1>
        <time className="home-hello__clock" dateTime={new Date(now).toISOString()}>{clock(now)}</time>
      </div>

      <div className="home__grid">
        <div className="home__main">
          <section className="home-projects" aria-labelledby="home-projects-title">
            <div className="home-head">
              <h2 id="home-projects-title">Project navigation</h2>
              <div className="home-head__tools">
                <label className="home-filter">
                  <span>Filters:</span>
                  <select className="ui-select home-filter__select" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                    <option value="all">None</option>
                    <option value="courses">Courses</option>
                    <option value="groups">Groups</option>
                  </select>
                </label>
                <span className="home-projects__arrows">
                  <button type="button" className="home-arrow" onClick={() => scrollRail(-1)} aria-label="Scroll projects left"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg></button>
                  <button type="button" className="home-arrow" onClick={() => scrollRail(1)} aria-label="Scroll projects right"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg></button>
                </span>
                <a className="ui-link" href="#tools">See all <span aria-hidden="true">›</span></a>
              </div>
            </div>

            {projectsLoading ? (
              <div className="home-rail" aria-busy="true" aria-label="Loading projects">
                <span className="ui-skeleton home-rail__skeleton is-featured" /><span className="ui-skeleton home-rail__skeleton" /><span className="ui-skeleton home-rail__skeleton" />
              </div>
            ) : shownProjects.length ? (
              <ul className="home-rail" ref={rail}>
                {shownProjects.map((project, index) => (
                  <li key={project.key} className={`home-project${index === 0 ? ' is-featured' : ''}`} style={project.tone ? { '--course': project.tone } as CSSProperties : undefined}>
                    <a href={project.href} onClick={() => { if (project.course) openCourse(project.course) }}>
                      <span className={`home-project__icon is-${project.type}`} aria-hidden="true">
                        {project.type === 'course' ? courseInitial(project.name) : (
                          <svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M15.5 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-2.4-4.5" /></svg>
                        )}
                      </span>
                      <span className="home-project__type">{project.type === 'course' ? 'Course' : 'Group project'}</span>
                      <strong className="home-project__name">{project.name}</strong>
                      <span className="home-project__detail">{project.detail}</span>
                      {index === 0 && project.total ? (
                        <span className="home-project__meter">
                          <span className="ui-meter"><span style={{ width: `${Math.round(project.done / project.total * 100)}%` }} /></span>
                          <small>{project.done} of {project.total} tasks done</small>
                        </span>
                      ) : null}
                      <span className="home-project__due">
                        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>
                        {project.due}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="home-empty">
                <p><b>{filter === 'groups' ? 'No group projects yet.' : 'No projects yet.'}</b> {filter === 'groups' ? 'Join or start a study group to plan work together.' : 'Each course and study group gets a card here.'}</p>
                <a className="ui-button ui-button--sm" href={filter === 'groups' ? '#profile' : '#tools'}>{filter === 'groups' ? 'Find a group' : 'Create a course'}</a>
              </div>
            )}
          </section>

          <section className="home-deadlines" aria-labelledby="home-deadlines-title">
            <span className="home-eyebrow">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 4 4 12M4 6.5V12h5.5" /></svg>
              Recent and upcoming
            </span>
            <div className="home-head">
              <h2 id="home-deadlines-title">Deadlines</h2>
              <a className="ui-link" href="#goals">All tasks</a>
            </div>
            {tasks === null ? (
              <div className="home-list" aria-busy="true" aria-label="Loading deadlines">
                <span className="ui-skeleton home-skeleton-row" /><span className="ui-skeleton home-skeleton-row" /><span className="ui-skeleton home-skeleton-row" />
              </div>
            ) : deadlines.length ? (
              <ul className="home-list">
                {deadlines.map((task) => {
                  const kind = kindOf(task, now)
                  return (
                    <li key={task.id}>
                      <a href="#goals" className="home-deadline">
                        <span className={`home-kind is-${kind}`}>{KIND_LABEL[kind]}</span>
                        <span className="home-deadline__main">
                          <b>{task.title}</b>
                          <small>{task.group_name || task.course || 'Personal'}{task.kind === 'event' && task.location ? ` · ${task.location}` : ''}</small>
                        </span>
                        <span className={`home-deadline__when${kind === 'overdue' ? ' is-late' : ''}`}>{whenText(task, now)}</span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="home-empty">
                <p><b>No deadlines.</b> Give tasks a due date and they line up here in order.</p>
                <a className="ui-button ui-button--sm" href="#goals?new">Add a task</a>
              </div>
            )}
          </section>
        </div>

        <aside className="home-team" aria-labelledby="home-team-title">
          {groups === null ? (
            <div className="home-team__loading" aria-busy="true" aria-label="Loading your group">
              <span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" />
            </div>
          ) : group ? (
            <>
              <div className="home-team__head">
                <h2 id="home-team-title">{group.name}</h2>
                <a className="home-team__settings" href={statsHref} aria-label={`Project statistics for ${group.name}`} title="Project statistics">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" /></svg>
                </a>
              </div>

              <h3 className="home-team__label" id="home-team-members">Team members</h3>
              <ul className="home-members" aria-labelledby="home-team-members">
                {group.members.map((member) => {
                  const focus = groupOpenTasks.find((task) => task.assignees.some((person) => person.student_id === member.student_id))
                  const me = member.student_id === studentId
                  return (
                    <li key={member.student_id}>
                      <span className="home-members__avatar" aria-hidden="true">{nameInitials(member.display_name)}</span>
                      <span className="home-members__who">
                        <b>{member.display_name}{me ? <span className="home-members__you"> (you)</span> : null}</b>
                        <small>{member.role === 'owner' ? 'Owner' : 'Member'}</small>
                      </span>
                      <span className={`home-members__focus${focus ? '' : ' is-idle'}`} title={focus ? `Working on ${focus.title}` : undefined}>
                        {focus ? focus.title : 'No open tasks'}
                      </span>
                    </li>
                  )
                })}
              </ul>

              <h3 className="home-team__label" id="home-team-stats">Team statistics</h3>
              <ul className="home-team__stats" aria-labelledby="home-team-stats">
                {teamStats.map((item) => (
                  <li key={item.label}>
                    <a href={statsHref}>
                      <span>{item.label}</span>
                      <small>{item.detail}</small>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="home-team__empty">
              <h2 id="home-team-title">Your team</h2>
              <p>Study groups show their members, who is working on what, and how the project is going right here.</p>
              <a className="ui-button ui-button--primary ui-button--sm" href="#profile">Find or start a group</a>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
