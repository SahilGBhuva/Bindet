import { useEffect, useMemo, useState } from 'react'
import type { FriendsHub, Profile, Progress } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { useData } from '../lib/dataSource'
import './Dashboard.css'

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function firstName(profile: Profile | null, session: AuthSession | null) {
  return profile?.display_name?.split(/\s+/)[0] || session?.user.user_metadata?.username || 'there'
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'B'
}

export function Home({ session }: { session: AuthSession | null }) {
  const data = useData()
  const studentId = session?.user.id ?? data.getStudentId()
  const token = session?.access_token
  const notebook = useMemo(() => data.loadNotebook(), [data])
  const [stats, setStats] = useState<Progress | null>(() => data.getCachedProgress(studentId))
  const [profile, setProfile] = useState<Profile | null>(() => token ? data.getCachedProfile(token) : null)
  const [social, setSocial] = useState<FriendsHub | null>(() => token ? data.getCachedFriends(token) : null)
  const [now] = useState(() => data.now())

  useEffect(() => {
    void data.getProgress(studentId, token, true).then(setStats).catch(() => undefined)
    if (!token) return
    void Promise.allSettled([
      data.getAccountProfile(token, true).then(setProfile),
      data.getFriends(token, true).then(setSocial),
    ])
  }, [data, studentId, token])

  const courses = notebook.courses
  const activeCourse = courses.find((course) => course.name === notebook.activeCourse) ?? courses[0]
  const activeUnit = notebook.activeUnit || activeCourse?.units[0] || 'First unit'
  const notes = notebook.deposits.filter((note) => !activeCourse || note.course === activeCourse.name)
  const recentNotes = [...notebook.deposits].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 3)
  const members = (social?.leaderboard ?? []).slice(0, 4)
  const accuracy = stats?.accuracy ?? 0
  const xp = profile?.total_xp ?? stats?.total_xp ?? 0
  const progress = notes.length ? Math.min(88, 28 + notes.length * 12) : 12

  return (
    <div className="workspace-home">
      <header className="workspace-home__header">
        <div><span className="workspace-home__date">{dateFormat.format(now)}</span><h1>Hello, {firstName(profile, session)}.</h1><p>Everything you are learning, bound into one focused workspace.</p></div>
        <div className="workspace-home__header-actions"><button type="button" className="workspace-icon-button" aria-label="Notifications">⌁</button><a className="workspace-avatar" href="#profile" aria-label="Open profile">{initials(profile?.display_name || 'Bindit')}</a></div>
      </header>

      <main className="workspace-home__canvas">
        <section className="assignment" aria-labelledby="assignment-title">
          <div className="assignment__eyebrow"><span>Project assignment</span><b>{activeCourse?.name || 'Your first course'}</b></div>
          <div className="assignment__head"><div><span className="assignment__kicker">Current focus</span><h2 id="assignment-title">{activeUnit}</h2></div><a href="#tools" className="workspace-primary">Open workspace <span>→</span></a></div>
          <div className="assignment__body">
            <div className="assignment__visual" aria-hidden="true"><div className="binding-stack"><span /><span /><span /><span /><span /></div><div className="assignment__progress-label"><b>{progress}%</b><span>ready to master</span></div></div>
            <div className="assignment__steps">
              <a href="#tools" className={notes.length ? 'is-done' : 'is-current'}><i>01</i><span><b>Collect source material</b><small>{notes.length} {notes.length === 1 ? 'note' : 'notes'} bound</small></span><em>{notes.length ? '✓' : '→'}</em></a>
              <a href="#tools" className={notes.length ? 'is-current' : ''}><i>02</i><span><b>Build your study set</b><small>Flashcards generated from your notes</small></span><em>→</em></a>
              <a href="#tools"><i>03</i><span><b>Prove mastery</b><small>Adaptive quiz and instant feedback</small></span><em>→</em></a>
            </div>
          </div>
        </section>

        <aside className="group-card" aria-label="Study group">
          <div className="group-card__head"><span>Study group</span><a href="#profile">•••</a></div><h3>{activeCourse?.name || 'My group'}</h3><p>{members.length ? `${members.length} people learning together` : 'Invite friends to learn together'}</p>
          <div className="group-card__members">{members.length ? members.map((member) => <span key={member.student_id} title={member.display_name}>{initials(member.display_name)}</span>) : <span>+</span>}</div>
          <dl><div><dt>Group XP</dt><dd>{members.reduce((total, member) => total + member.weekly_xp, 0).toLocaleString()}</dd></div><div><dt>Your XP</dt><dd>{xp.toLocaleString()}</dd></div><div><dt>Accuracy</dt><dd>{accuracy}%</dd></div></dl>
          <a className="group-card__action" href="#profile">Open group <span>↗</span></a>
        </aside>

        <section className="workspace-recent" aria-labelledby="recent-title">
          <div className="workspace-section-heading"><div><span>Recent and upcoming</span><h2 id="recent-title">Keep moving</h2></div><a href="#goals">View all →</a></div>
          <div className="workspace-recent__list">{recentNotes.length ? recentNotes.map((note, index) => <a href="#tools" key={note.id}><span className="workspace-recent__type">{index === 0 ? 'Review' : 'Source'}</span><div><b>{note.fileName}</b><small>{note.course} · {note.unit || 'Unsorted'}</small></div><time>{index === 0 ? timeFormat.format(now) : 'Ready'}</time></a>) : <a href="#tools" className="is-empty"><span className="workspace-recent__type">Start</span><div><b>Upload your first notes</b><small>PDF, image, or document</small></div><time>Now</time></a>}</div>
        </section>
      </main>
    </div>
  )
}
