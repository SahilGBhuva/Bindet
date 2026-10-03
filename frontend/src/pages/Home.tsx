import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { parseServerTime, type FriendsHub, type Profile, type Progress, type StudyGroup, type StudyTask } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import { buildCoursePulse, VERDICT_COPY } from '../lib/progress'
import { courseInitial } from '../lib/tones'
import { notesFor, withCourseTones } from '../lib/session'
import type { Course } from '../lib/types'
import './Home.css'

const DAY = 86_400_000
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

type NextStep = { eyebrow: string; title: string; detail: string; action: string; href: string; course?: string; unit?: string; tone?: 'urgent' | 'calm' }

function greeting(hour: number) {
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dueText(dueAt: string | null, now: number) {
  if (!dueAt) return 'No due date'
  const days = Math.round((startOfDay(parseServerTime(dueAt)) - startOfDay(now)) / DAY)
  if (days < 0) return days === -1 ? 'Overdue · yesterday' : `Overdue · ${shortDate.format(new Date(parseServerTime(dueAt)))}`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  if (days < 7) return `Due ${relative.format(days, 'day')}`
  return `Due ${shortDate.format(new Date(parseServerTime(dueAt)))}`
}

function timeAgo(iso: string, now: number) {
  const minutes = Math.min(0, Math.round((parseServerTime(iso) - now) / 60_000))
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour')
  return relative.format(Math.round(hours / 24), 'day')
}

export function Home({ session }: { session: AuthSession | null }) {
  const data = useData()
  const studentId = session?.user.id ?? data.getStudentId()
  const token = session?.access_token
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [stats, setStats] = useState<Progress | null>(() => data.getCachedProgress(studentId))
  const [profile, setProfile] = useState<Profile | null>(() => token ? data.getCachedProfile(token) : null)
  const [social, setSocial] = useState<FriendsHub | null>(() => token ? data.getCachedFriends(token) : null)
  const [groups, setGroups] = useState<StudyGroup[]>(() => token ? data.getCachedStudyGroups(token) ?? [] : [])
  const [tasks, setTasks] = useState<StudyTask[] | null>(() => token ? data.getCachedTasks(token) : null)
  const [now] = useState(() => data.now())

  // Everything is independent, so it loads in parallel; cached values above render first.
  useEffect(() => {
    let active = true
    void data.getProgress(studentId, token, true).then((value) => { if (active) setStats(value) }).catch(() => undefined)
    if (!token) return () => { active = false }
    void data.getAccountProfile(token).then((value) => { if (active) setProfile(value) }).catch(() => undefined)
    void data.getFriends(token).then((value) => { if (active) setSocial(value) }).catch(() => undefined)
    void data.getStudyGroups(token).then((value) => { if (active) setGroups(value) }).catch(() => undefined)
    void data.getTasks(token, true).then((value) => { if (active) setTasks(value) }).catch(() => { if (active) setTasks((current) => current ?? []) })
    return () => { active = false }
  }, [data, studentId, token])

  const courses = notebook.courses
  const activeCourse = courses.find((course) => course.name === notebook.activeCourse) ?? courses[0]
  const activeUnit = (activeCourse && notebook.activeUnit && activeCourse.units.includes(notebook.activeUnit)) ? notebook.activeUnit : activeCourse?.units[0] ?? ''
  const unitNotes = activeCourse ? notesFor(notebook.deposits, activeCourse.name, activeUnit) : []
  const attempts = useMemo(() => data.loadUnitAttempts(), [data])
  const pulses = useMemo(() => courses.map((course) => buildCoursePulse(course, notebook.deposits, attempts, stats?.topics ?? [])), [courses, notebook.deposits, attempts, stats?.topics])

  const openTasks = (tasks ?? []).filter((task) => task.status !== 'complete')
  const upcoming = openTasks.toSorted((a, b) => (a.due_at ? parseServerTime(a.due_at) : Infinity) - (b.due_at ? parseServerTime(b.due_at) : Infinity)).slice(0, 5)
  const overdue = openTasks.filter((task) => task.due_at && startOfDay(parseServerTime(task.due_at)) < startOfDay(now))
  const dueSoon = openTasks.filter((task) => task.due_at && parseServerTime(task.due_at) - now < 2 * DAY && !overdue.includes(task))

  const dailyGoal = profile?.daily_goal ?? 20
  const week = stats?.recent_xp?.slice(-7) ?? []
  const todayXp = week[week.length - 1]?.xp ?? 0
  const goalPercent = Math.min(100, Math.round(todayXp / dailyGoal * 100))
  const streak = stats?.login_streak ?? profile?.login_streak ?? 0
  const xp = profile?.total_xp ?? stats?.total_xp ?? 0
  const weakTopic = stats?.weak_topics?.[0]?.replaceAll('_', ' ')
  const firstName = profile?.display_name?.split(/\s+/)[0] || session?.user.user_metadata?.username || ''
  const isNew = !courses.length && tasks !== null && !tasks.length

  const next: NextStep = !courses.length
    ? { eyebrow: 'Start here', title: 'Create your first course', detail: 'Add a course and a unit, then drop in your notes. Everything else in bindit is built from them.', action: 'Set up a course', href: '#tools', tone: 'calm' }
    : overdue[0]
      ? { eyebrow: 'Overdue', title: overdue[0].title, detail: `${overdue[0].course || 'Personal'}${overdue[0].unit ? ` · ${overdue[0].unit}` : ''} was ${dueText(overdue[0].due_at, now).replace('Overdue · ', 'due ')}. Finish it or move the date so your plan stays honest.`, action: 'Open assignment', href: '#goals', tone: 'urgent' }
      : !unitNotes.length
        ? { eyebrow: 'Collect', title: `Add notes to ${activeUnit || activeCourse.name}`, detail: 'Upload a PDF, a photo of your notebook, or a document. Flashcards and quiz questions come from what you add.', action: 'Add notes', href: '#tools', course: activeCourse.name, unit: activeUnit }
        : weakTopic
          ? { eyebrow: 'Strengthen', title: `Practice ${weakTopic}`, detail: 'Your recent answers here are below 60%. A short quiz will target exactly this.', action: 'Start a quiz', href: '#tools', course: activeCourse.name, unit: activeUnit }
          : dueSoon[0]
            ? { eyebrow: dueText(dueSoon[0].due_at, now), title: dueSoon[0].title, detail: `${dueSoon[0].course || 'Personal'}${dueSoon[0].unit ? ` · ${dueSoon[0].unit}` : ''}. Get it moving now and it will not be a late-night job.`, action: 'Open assignment', href: '#goals' }
            : { eyebrow: 'Keep it fresh', title: `Review ${activeUnit || activeCourse.name}`, detail: `Flashcards from ${unitNotes.length} ${unitNotes.length === 1 ? 'source' : 'sources'} in ${activeCourse.name}. Five minutes now saves an hour before the test.`, action: 'Review flashcards', href: '#tools', course: activeCourse.name, unit: activeUnit }

  const steps = activeCourse ? [
    { label: 'Collect', detail: unitNotes.length ? `${unitNotes.length} ${unitNotes.length === 1 ? 'source' : 'sources'}` : 'No notes yet', done: unitNotes.length > 0 },
    { label: 'Build', detail: unitNotes.length ? 'Flashcards ready' : 'Waiting for notes', done: unitNotes.length > 0 },
    { label: 'Prove', detail: (() => { const unit = pulses.find((pulse) => pulse.course.name === activeCourse.name)?.units.find((item) => item.name === activeUnit); return unit?.attempts ? `${Math.round(unit.mastery)}% mastery` : 'Not quizzed yet' })(), done: Boolean(pulses.find((pulse) => pulse.course.name === activeCourse.name)?.units.find((item) => item.name === activeUnit)?.attempts) },
  ] : []

  function openCourse(course: Course, unit?: string) {
    const nextNotebook = { ...data.loadNotebook(), activeCourse: course.name, activeUnit: unit ?? course.units[0] ?? '' }
    data.saveNotebook(nextNotebook)
    setNotebook({ ...nextNotebook, courses: withCourseTones(nextNotebook.courses) })
  }

  // Study sessions are grouped per person per day so a busy afternoon reads as one line.
  const sessions = new Map<string, { id: string; at: string; who: string; xp: number; count: number }>()
  for (const item of social?.activity ?? []) {
    const key = `${item.student_id}|${new Date(parseServerTime(item.created_at)).toDateString()}`
    const entry = sessions.get(key)
    if (entry) { entry.xp += item.xp; entry.count += 1; if (parseServerTime(item.created_at) > parseServerTime(entry.at)) entry.at = item.created_at }
    else sessions.set(key, { id: `xp-${item.id}`, at: item.created_at, who: item.student_id === studentId ? 'You' : item.display_name, xp: item.xp, count: 1 })
  }
  const activity = [
    ...notebook.deposits.map((note) => ({ id: `note-${note.id}`, at: note.createdAt, who: 'You', what: `added ${note.fileName}`, where: `${note.course}${note.unit ? ` · ${note.unit}` : ''}` })),
    ...[...sessions.values()].map((entry) => ({ id: entry.id, at: entry.at, who: entry.who, what: `earned ${entry.xp} XP${entry.count > 1 ? ` in ${entry.count} answers` : ''}`, where: entry.who === 'You' ? 'Practice' : 'Friends' })),
    ...(tasks ?? []).filter((task) => task.status === 'complete').map((task) => ({ id: `task-${task.id}`, at: task.updated_at, who: 'You', what: `finished ${task.title}`, where: task.course || 'Assignments' })),
  ].filter((item) => item.at).toSorted((a, b) => parseServerTime(b.at) - parseServerTime(a.at)).slice(0, 6)

  const group = groups.toSorted((a, b) => b.weekly_xp - a.weekly_xp)[0]

  return (
    <div className="ui-page home">
      <header className="home__header">
        <div>
          <span className="ui-eyebrow">{longDate.format(new Date(now))}</span>
          <h1 className="ui-page-title">{greeting(data.hourOf(now))}{firstName ? <>, <em>{firstName}</em></> : null}.</h1>
        </div>
        <dl className="home__vitals" aria-label="Your study vitals">
          <div><dt>Streak</dt><dd>{streak} {streak === 1 ? 'day' : 'days'}{streak >= 7 ? <img className="ui-mascot-cheer" src="/bindit-mascot-cutout.webp" alt="" width="24" height="29" /> : null}</dd></div>
          <div><dt>Total XP</dt><dd>{xp.toLocaleString()}</dd></div>
          <div><dt>Accuracy</dt><dd>{stats?.attempts ? `${Math.round(stats.accuracy)}%` : '—'}</dd></div>
        </dl>
      </header>

      <div className="home__grid">
        <div className="home__main">
          {tasks === null && token ? (
            <div className="home-next is-loading" aria-busy="true" aria-label="Finding your next step"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
          ) : <section className={`home-next${next.tone === 'urgent' ? ' is-urgent' : ''}${isNew ? ' is-new' : ''}`} aria-labelledby="home-next-title">
            <div className="home-next__copy">
              <span className="home-next__eyebrow">{next.eyebrow}</span>
              <h2 id="home-next-title">{next.title}</h2>
              <p>{next.detail}</p>
              <div className="home-next__actions">
                <a className="ui-button ui-button--primary" href={next.href} onClick={() => { if (next.course) { const course = courses.find((item) => item.name === next.course); if (course) openCourse(course, next.unit) } }}>{next.action}<span aria-hidden="true">→</span></a>
                {courses.length ? <a className="ui-button ui-button--ghost" href="#tutor">Ask the tutor</a> : null}
              </div>
            </div>
            {isNew ? (
              <img className="home-next__mascot" src="/bindit-mascot-cutout.webp" alt="" width="120" height="144" />
            ) : activeCourse ? (
              <ol className="home-next__binding" data-label="Active unit" aria-label={`${activeUnit || 'No unit'} in ${activeCourse.name}`}>
                <li className="home-next__unit" style={{ '--course': activeCourse.tone } as CSSProperties}>
                  <span className="ui-course-mark ui-course-mark--sm">{courseInitial(activeCourse.name)}</span>
                  <span><b>{activeUnit || 'No units yet'}</b><small>{activeCourse.name}</small></span>
                </li>
                {steps.map((step, index) => (
                  <li key={step.label} className={step.done ? 'is-done' : ''}>
                    <i aria-hidden="true">{step.done ? <svg viewBox="0 0 16 16"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg> : index + 1}</i>
                    <span><b>{step.label}</b><small>{step.detail}</small></span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>}

          <section className="home-section" aria-labelledby="home-upcoming">
            <div className="home-section__head">
              <h2 id="home-upcoming">Upcoming</h2>
              <a className="ui-link" href="#goals">All assignments</a>
            </div>
            {tasks === null ? (
              <div className="home-list"><span className="ui-skeleton home-skeleton-row" /><span className="ui-skeleton home-skeleton-row" /><span className="ui-skeleton home-skeleton-row" /></div>
            ) : upcoming.length ? (
              <ul className="home-list">
                {upcoming.map((task) => {
                  const course = courses.find((item) => item.name === task.course)
                  const late = overdue.includes(task)
                  return (
                    <li key={task.id}>
                      <a href="#goals" className="home-task">
                        <span className="ui-course-mark ui-course-mark--sm" style={{ '--course': course?.tone ?? 'var(--color-text-tertiary)' } as CSSProperties} aria-hidden="true">{courseInitial(task.course || '•')}</span>
                        <span className="home-task__main"><b>{task.title}</b><small>{task.course || 'Personal'}{task.unit ? ` · ${task.unit}` : ''}</small></span>
                        {task.priority === 'high' ? <span className="ui-badge ui-badge--warning">High</span> : null}
                        <span className={`home-task__due${late ? ' is-late' : ''}`}>{dueText(task.due_at, now)}</span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="home-empty">
                <p><b>Nothing due.</b> Add assignments as they are handed out and bindit will keep them in order.</p>
                <a className="ui-button ui-button--sm" href="#goals?new">Add an assignment</a>
              </div>
            )}
          </section>

          <section className="home-section" aria-labelledby="home-courses">
            <div className="home-section__head">
              <h2 id="home-courses">Courses</h2>
              <a className="ui-link" href="#tools">Open study</a>
            </div>
            {pulses.length ? (
              <ul className="home-courses">
                {pulses.map((pulse) => {
                  const noteCount = notebook.deposits.filter((note) => note.course === pulse.course.name).length
                  return (
                    <li key={pulse.course.name} style={{ '--course': pulse.course.tone } as CSSProperties}>
                      <a href="#tools" onClick={() => openCourse(pulse.course)}>
                        <span className="home-courses__spine" aria-hidden="true" />
                        <span className="home-courses__name">{pulse.course.name}</span>
                        <span className="home-courses__meta">{pulse.course.units.length} {pulse.course.units.length === 1 ? 'unit' : 'units'} · {noteCount} {noteCount === 1 ? 'note' : 'notes'}</span>
                        <span className="home-courses__mastery">
                          <span className="ui-meter"><span style={{ width: `${pulse.live ? Math.round(pulse.mastery) : 0}%`, background: 'var(--course)' }} /></span>
                          <small>{pulse.live ? `${Math.round(pulse.mastery)}% · ${VERDICT_COPY[pulse.verdict].label}` : VERDICT_COPY[pulse.verdict].label}</small>
                        </span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="home-empty">
                <p><b>No courses yet.</b> A course holds units, and each unit holds the notes your study sets are built from.</p>
                <a className="ui-button ui-button--sm" href="#tools">Create a course</a>
              </div>
            )}
          </section>
        </div>

        <aside className="home__side" aria-label="Today">
          <section className="home-card" aria-labelledby="home-goal">
            <div className="home-section__head"><h2 id="home-goal">Today’s goal</h2><a className="ui-link" href="#settings">Change</a></div>
            <div className="home-goal">
              <svg viewBox="0 0 44 44" className="home-goal__ring" role="img" aria-label={`${todayXp} of ${dailyGoal} XP today`}>
                <circle cx="22" cy="22" r="19" className="home-goal__track" />
                <circle cx="22" cy="22" r="19" className="home-goal__fill" style={{ strokeDasharray: `${goalPercent * 1.194} 119.4` }} />
              </svg>
              <div><strong>{todayXp}<span> / {dailyGoal} XP</span></strong><small>{goalPercent >= 100 ? 'Goal met. Nice work.' : `${dailyGoal - todayXp} XP to go`}</small></div>
            </div>
            {week.length ? (
              <ol className="home-week" aria-label="XP this week">
                {week.map((day) => {
                  const height = Math.max(6, Math.min(100, day.xp / dailyGoal * 100))
                  return (
                    <li key={day.day} title={`${day.xp} XP`} className={day.xp >= dailyGoal ? 'is-met' : day.xp ? 'is-some' : ''}>
                      <span><i style={{ height: `${height}%` }} /></span>
                      <small>{weekdayShort.format(new Date(`${day.day}T12:00:00`))}</small>
                    </li>
                  )
                })}
              </ol>
            ) : null}
          </section>

          {group ? (
            <section className="home-card" aria-labelledby="home-group">
              <div className="home-section__head"><h2 id="home-group">{group.name}</h2><a className="ui-link" href="#chat">Open</a></div>
              <p className="home-card__meta">{group.members.length} {group.members.length === 1 ? 'member' : 'members'} · {group.weekly_xp} of {group.weekly_goal_xp} XP this week</p>
              <div className="ui-meter"><span style={{ width: `${Math.min(100, group.weekly_xp / group.weekly_goal_xp * 100)}%` }} /></div>
              <ul className="home-people" aria-label="Members">
                {group.members.slice(0, 5).map((member) => <li key={member.student_id} title={`${member.display_name} · ${member.weekly_xp} XP`}>{member.display_name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2)}</li>)}
              </ul>
            </section>
          ) : null}

          <section className="home-card" aria-labelledby="home-activity">
            <div className="home-section__head"><h2 id="home-activity">Recent activity</h2></div>
            {activity.length ? (
              <ol className="home-activity">
                {activity.map((item) => (
                  <li key={item.id}><p><b>{item.who}</b> {item.what}</p><small>{item.where} · {timeAgo(item.at, now)}</small></li>
                ))}
              </ol>
            ) : <p className="home-card__meta">Uploads, finished assignments, and your friends’ study sessions will show up here.</p>}
          </section>
        </aside>
      </div>
    </div>
  )
}
