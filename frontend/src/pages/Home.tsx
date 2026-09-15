import { useEffect, useMemo, useState } from 'react'
import { getAccountProfile, getCachedFriends, getCachedProfile, getCachedProgress, getFriends, getProgress, type FriendsHub, type Profile, type Progress } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import type { Notebook } from '../lib/types'
import { getStudentId, loadNotebook } from '../lib/session'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import { Icons } from '../components/Icons'
import './Dashboard.css'

const STREAK_MILESTONE = 7
const GOOD_ACCURACY = 70

const numberFormat = new Intl.NumberFormat()
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function greeting(date: Date) {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function relativeTime(iso: string, now: number) {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return shortDateFormat.format(then)
}

function daysUntil(iso: string, now: number) {
  const days = Math.ceil((Date.parse(iso) - now) / 86_400_000)
  if (Number.isNaN(days)) return ''
  if (days <= 0) return 'Ends today'
  return days === 1 ? 'Ends tomorrow' : `Ends in ${days} days`
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

/*
 * Demo data for rendering the real dashboard outside the app (the landing page preview).
 * When present, nothing is read from storage and no requests are made.
 */
export type HomePreview = {
  studentId: string
  signedIn: boolean
  stats: Progress
  profile: Profile
  social: FriendsHub
  notebook: Notebook
  now: number
}

export function Home({ session, preview }: { session: AuthSession | null; preview?: HomePreview }) {
  const studentId = preview?.studentId ?? session?.user.id ?? getStudentId()
  const accessToken = preview ? undefined : session?.access_token
  const [stats, setStats] = useState<Progress | null>(() => preview?.stats ?? getCachedProgress(studentId))
  const [profile, setProfile] = useState<Profile | null>(() => preview?.profile ?? (accessToken ? getCachedProfile(accessToken) : null))
  const [social, setSocial] = useState<FriendsHub | null>(() => preview?.social ?? (accessToken ? getCachedFriends(accessToken) : null))
  const notebook = useMemo(() => preview?.notebook ?? loadNotebook(), [preview?.notebook])
  const [now] = useState(() => preview?.now ?? Date.now())
  const signedIn = preview ? preview.signedIn : Boolean(session)

  useEffect(() => {
    if (preview) return
    void getProgress(studentId, accessToken, true).then(setStats).catch(() => undefined)
    if (accessToken) {
      void Promise.allSettled([
        getAccountProfile(accessToken, true).then(setProfile),
        getFriends(accessToken, true).then(setSocial),
      ])
    }
  }, [studentId, accessToken, preview])

  const xp = profile?.total_xp ?? stats?.total_xp ?? 0
  const streak = profile?.login_streak ?? stats?.login_streak ?? 0
  const bestStreak = profile?.best_login_streak ?? stats?.best_login_streak ?? 0
  const dailyGoal = profile?.daily_goal ?? 20
  const todayXp = Math.min(xp, dailyGoal)
  const goalProgress = Math.min(100, (todayXp / dailyGoal) * 100)
  const accuracy = stats?.accuracy ?? 0
  const attempts = stats?.attempts ?? 0
  const correct = stats?.correct_answers ?? 0
  const name = profile?.display_name?.split(' ')[0]

  const courses = notebook.courses
  const activeCourse = notebook.activeCourse || courses[0]?.name
  const noteCount = notebook.deposits.filter((note) => note.course === activeCourse).length
  const recentNotes = [...notebook.deposits].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5)
  const newestActiveNote = recentNotes.find((note) => note.course === activeCourse)
  const weakestTopic = stats?.topics.length ? [...stats.topics].sort((a, b) => a.accuracy - b.accuracy)[0] : null

  const nextStep = weakestTopic
    ? { title: `Strengthen ${weakestTopic.topic.replaceAll('_', ' ')}`, meta: `${weakestTopic.accuracy}% accuracy. A short quiz will target the gaps.`, action: 'Practice' }
    : noteCount
      ? { title: 'Turn your newest notes into a quiz', meta: newestActiveNote ? `${newestActiveNote.fileName} is ready for grounded questions.` : 'Your notes are ready for grounded questions.', action: 'Build quiz' }
      : { title: 'Add your first set of notes', meta: 'Scan a page or upload a file and bindit will build your study path.', action: 'Upload notes' }

  const leaderboard = (social?.leaderboard ?? []).slice(0, 5)
  const requestCount = social?.requests.length ?? 0
  const quest = social?.quests[0]

  return (
    <div className="ui-page dashboard">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">{greeting(new Date(now))}{name ? `, ${name}` : ''}</h1>
          <p className="ui-page-subtitle">{dateFormat.format(now)}</p>
        </div>
        <nav className="dashboard__actions" aria-label="Study actions">
          <a className="ui-button" href="#tools">Upload notes</a>
          <a className="ui-button" href="#tools">Review flashcards</a>
          <a className="ui-button ui-button--primary" href="#tools">Start a quiz</a>
        </nav>
      </header>

      <section className="ui-panel ui-stats" aria-label="Your progress">
        <div className="ui-stat ui-tone--blue">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.target}</span>Daily goal</span>
          <span className="ui-stat__value">{todayXp}<span className="ui-stat__unit">/ {dailyGoal} XP</span></span>
          <div className="ui-meter" role="progressbar" aria-label="Daily goal" aria-valuemin={0} aria-valuemax={dailyGoal} aria-valuenow={todayXp}>
            <span style={{ width: `${goalProgress}%` }} />
          </div>
        </div>
        <div className="ui-stat ui-tone--orange">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.flame}</span>Streak</span>
          <span className="ui-stat__value dashboard__streak">
            {streak}<span className="ui-stat__unit">{streak === 1 ? 'day' : 'days'}</span>
            {streak >= STREAK_MILESTONE ? <img className="ui-mascot-cheer dashboard__streak-mascot" src="/bindit-mascot-cutout.webp" alt="" title={`${streak}-day streak`} /> : null}
          </span>
          <span className="ui-stat__meta">Best {bestStreak} {bestStreak === 1 ? 'day' : 'days'}</span>
        </div>
        <div className="ui-stat ui-tone--violet">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.sparkle}</span>Total XP</span>
          <span className="ui-stat__value">{numberFormat.format(xp)}</span>
          <span className="ui-stat__meta">{numberFormat.format(attempts)} {attempts === 1 ? 'answer' : 'answers'}</span>
        </div>
        <div className={`ui-stat ${attempts && accuracy < GOOD_ACCURACY ? 'ui-tone--amber' : 'ui-tone--green'}`}>
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.check}</span>Accuracy</span>
          <span className="ui-stat__value">{accuracy}%</span>
          <span className="ui-stat__meta">{numberFormat.format(correct)} of {numberFormat.format(attempts)} correct</span>
        </div>
      </section>

      <div className="dashboard__grid">
        <div className="dashboard__main">
          <section className="ui-section" aria-labelledby="dashboard-next">
            <div className="ui-section-head"><h2 className="ui-section-title" id="dashboard-next">Up next</h2></div>
            <div className="ui-panel">
              <div className="ui-row dashboard__next">
                <div className="ui-row__main">
                  <span className="ui-row__title">{nextStep.title}</span>
                  <span className="ui-row__meta">{nextStep.meta}</span>
                </div>
                <a className="ui-button" href="#tools">{nextStep.action}</a>
              </div>
            </div>
          </section>

          <section className="ui-section" aria-labelledby="dashboard-courses">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="dashboard-courses">Courses</h2>
              {courses.length ? <a className="ui-link" href="#tools">Open in Tools</a> : null}
            </div>
            <div className="ui-panel">
              {courses.length ? (
                <ul className="ui-list">
                  {courses.map((course) => {
                    const notes = notebook.deposits.filter((note) => note.course === course.name).length
                    return (
                      <li key={course.name} className="ui-row ui-course-row" style={{ ['--course' as string]: course.tone }}>
                        <span className="ui-course-mark" aria-hidden="true">{courseInitial(course.name)}</span>
                        <div className="ui-row__main">
                          <span className="ui-row__title">{course.name}</span>
                          <span className="ui-row__meta">
                            {course.units.length} {course.units.length === 1 ? 'unit' : 'units'} · {notes} {notes === 1 ? 'note' : 'notes'}
                          </span>
                        </div>
                        {course.name === activeCourse ? <span className="ui-badge ui-badge--course">Current</span> : null}
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <div className="ui-empty">
                  <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" />
                  <p className="ui-empty__title">No courses yet</p>
                  <p className="ui-empty__copy">Add a course in Tools, then upload notes to get quizzes and flashcards built from them.</p>
                  <a className="ui-button ui-button--primary" href="#tools">Add a course</a>
                </div>
              )}
            </div>
          </section>

          {courses.length ? (
            <section className="ui-section" aria-labelledby="dashboard-notes">
              <div className="ui-section-head"><h2 className="ui-section-title" id="dashboard-notes">Recent notes</h2></div>
              <div className="ui-panel">
                {recentNotes.length ? (
                  <ul className="ui-list">
                    {recentNotes.map((note) => (
                      <li key={note.id} className="ui-row">
                        <div className="ui-row__main">
                          <span className="ui-row__title">{note.fileName}</span>
                          <span className="ui-row__meta">{note.course}{note.unit ? ` · ${note.unit}` : ''}</span>
                        </div>
                        <span className="ui-row__aside">{relativeTime(note.createdAt, now)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="dashboard__inline-empty">No notes uploaded yet.</p>
                )}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="dashboard__side">
          <section className="ui-section" aria-labelledby="dashboard-friends">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="dashboard-friends">Friends this week</h2>
              {signedIn ? (
                <a className="ui-link" href="#profile">
                  {requestCount ? `${requestCount} ${requestCount === 1 ? 'request' : 'requests'}` : 'View all'}
                </a>
              ) : null}
            </div>
            <div className="ui-panel">
              {leaderboard.length ? (
                <ol className="ui-list">
                  {leaderboard.map((friend, index) => {
                    const isYou = friend.student_id === studentId
                    return (
                      <li key={friend.student_id} className={`ui-row dashboard__friend${isYou ? ' is-you' : ''}`}>
                        <span className="dashboard__rank">{index + 1}</span>
                        <span className={`ui-avatar ${toneClass(toneForName(friend.display_name))}`} aria-hidden="true">{initials(friend.display_name)}</span>
                        <div className="ui-row__main">
                          <span className="ui-row__title">{isYou ? 'You' : friend.display_name}</span>
                          <span className="ui-row__meta">
                            {friend.active_today ? 'Active today' : friend.streak ? `${friend.streak}-day streak` : 'No activity today'}
                          </span>
                        </div>
                        <span className="ui-row__aside">{numberFormat.format(friend.weekly_xp)} XP</span>
                      </li>
                    )
                  })}
                </ol>
              ) : (
                <div className="ui-empty">
                  <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" />
                  <p className="ui-empty__title">No friends yet</p>
                  <p className="ui-empty__copy">
                    {signedIn ? 'Add friends from your profile to compare weekly XP.' : 'Create an account to add friends and compare weekly XP.'}
                  </p>
                  <a className="ui-button ui-button--primary" href={signedIn ? '#profile' : '#settings'}>{signedIn ? 'Find friends' : 'Create an account'}</a>
                </div>
              )}
            </div>
          </section>

          {quest ? (
            <section className="ui-section" aria-labelledby="dashboard-quest">
              <div className="ui-section-head">
                <h2 className="ui-section-title" id="dashboard-quest">Friend quest</h2>
                <a className="ui-link" href="#profile">Details</a>
              </div>
              <div className="ui-panel ui-panel--padded">
                <div className="dashboard__quest-line">
                  <span className="ui-row__title">With {quest.friend_name}</span>
                  <span className="ui-row__aside">{quest.progress_xp} / {quest.target_xp} XP</span>
                </div>
                <div className="ui-meter" role="progressbar" aria-label={`Quest with ${quest.friend_name}`} aria-valuemin={0} aria-valuemax={quest.target_xp} aria-valuenow={quest.progress_xp}>
                  <span style={{ width: `${Math.min(100, (quest.progress_xp / Math.max(quest.target_xp, 1)) * 100)}%` }} />
                </div>
                <span className="ui-row__meta dashboard__quest-meta">{daysUntil(quest.expires_at, now)}</span>
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}
