import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { AuthSession } from '../lib/auth'
import {
  createMilestone,
  deleteMilestone,
  getAccountProfile,
  getCachedGroupAnalytics,
  getCachedProfile,
  getCachedStudyGroups,
  getGroupAnalytics,
  localDay,
  getStudyGroups,
  getTasks,
  notifyGroup,
  parseServerTime,
  updateTask,
  type GroupAnalytics,
  type Profile,
  type StudyGroup,
} from '../lib/api'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import './ProjectStats.css'

type Pace = GroupAnalytics['pace']
type Member = GroupAnalytics['members'][number]

const PACE_LABEL: Record<Pace, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  behind: 'Unacceptable',
  stalled: 'Stalled',
  done: 'Done',
  not_started: 'Not started',
}

const PACE_TONE: Record<Pace, string> = {
  on_track: 'is-good',
  done: 'is-good',
  at_risk: 'is-warn',
  stalled: 'is-warn',
  behind: 'is-bad',
  not_started: '',
}

const NOTIFY_MESSAGE: Record<Pace, string> = {
  behind: "We're behind schedule. Please check your tasks and finish the urgent ones first.",
  at_risk: "We're at risk of missing our date. Please check your tasks and finish the urgent ones first.",
  stalled: 'Nothing has moved recently. Please check your tasks and update their status.',
  on_track: "We're on track. Keep going and mark tasks done as you finish them.",
  done: 'Everything is finished. Great work, everyone.',
  not_started: "Let's get started. Please check the board and pick up your tasks.",
}

const WORKRATE_MESSAGE = 'We need to pick up the pace. Please aim to finish at least one more task this week and update your task status as you go.'

const INACTIVE_PER_COLUMN = 4

/* Read the optional group id from "#stats?group=<id>". */
function groupFromHash() {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('group') ?? ''
}

function ordinal(day: number) {
  const tens = day % 100
  if (tens >= 11 && tens <= 13) return `${day}th`
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`
}

/* "November 2nd" — the sketch's sentence form. */
function longDate(value: string | null | undefined) {
  if (!value) return ''
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00`) : parseServerTime(value)
  if (Number.isNaN(time)) return ''
  const date = new Date(time)
  return `${date.toLocaleDateString('en-US', { month: 'long' })} ${ordinal(date.getDate())}`
}

function localISODate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function percent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function finishedAll(member: Member) {
  return member.assigned > 0 && member.completed >= member.assigned
}

export function ProjectStats({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const myId = session?.user.id ?? ''

  const [groups, setGroups] = useState<StudyGroup[] | null>(() => (token ? getCachedStudyGroups(token) : null))
  const [groupsError, setGroupsError] = useState('')
  const [groupsReload, setGroupsReload] = useState(0)
  const [hashGroup, setHashGroup] = useState(groupFromHash)
  const [profile, setProfile] = useState<Profile | null>(() => (token ? getCachedProfile(token) : null))

  const [analytics, setAnalytics] = useState<Record<string, GroupAnalytics>>({})
  const [analyticsError, setAnalyticsError] = useState<Record<string, string>>({})
  const [analyticsReload, setAnalyticsReload] = useState(0)

  useEffect(() => {
    const sync = () => setHashGroup(groupFromHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  useEffect(() => {
    if (!token) return
    let active = true
    getStudyGroups(token, groupsReload > 0)
      .then((data) => { if (active) { setGroups(data); setGroupsError('') } })
      .catch((error: unknown) => { if (active) setGroupsError(errorText(error, 'Please check your connection.')) })
    return () => { active = false }
  }, [token, groupsReload])

  useEffect(() => {
    if (!token) return
    let active = true
    getAccountProfile(token).then((data) => { if (active) setProfile(data) }).catch(() => { /* the card falls back to the member name */ })
    return () => { active = false }
  }, [token])

  const groupId = groups?.some((group) => group.id === hashGroup) ? hashGroup : groups?.[0]?.id ?? ''

  useEffect(() => {
    if (!token || !groupId) return
    let active = true
    getGroupAnalytics(groupId, token, localDay())
      .then((data) => {
        if (!active) return
        setAnalytics((current) => ({ ...current, [groupId]: data }))
        setAnalyticsError((current) => ({ ...current, [groupId]: '' }))
      })
      .catch((error: unknown) => {
        if (active) setAnalyticsError((current) => ({ ...current, [groupId]: errorText(error, 'Please check your connection.') }))
      })
    return () => { active = false }
  }, [token, groupId, analyticsReload])

  const refresh = useCallback(() => setAnalyticsReload((value) => value + 1), [])
  const data = groupId ? analytics[groupId] ?? getCachedGroupAnalytics(groupId) : null
  const error = groupId ? analyticsError[groupId] ?? '' : ''

  const chooseGroup = (id: string) => {
    setHashGroup(id)
    window.location.hash = `stats?group=${encodeURIComponent(id)}`
  }

  const header = (
    <header className="pst-head">
      <h1 className="pst-title">Project statistics</h1>
      {groups && groups.length > 0 ? (
        <label className="pst-group">
          <span>Group</span>
          <select className="pst-chip pst-group__select" value={groupId} onChange={(event) => chooseGroup(event.target.value)}>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
      ) : null}
    </header>
  )

  if (!session) {
    return (
      <div className="ui-page pst">
        {header}
        <p className="pst-empty">Sign in to see statistics for your study groups.</p>
      </div>
    )
  }

  if (!groups) {
    return (
      <div className="ui-page pst">
        {header}
        {groupsError ? (
          <div className="ui-alert" role="alert">
            <span>Could not load your study groups. {groupsError}</span>
            <button type="button" className="ui-button ui-button--sm" onClick={() => { setGroupsError(''); setGroupsReload((value) => value + 1) }}>Try again</button>
          </div>
        ) : <StatsSkeleton />}
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="ui-page pst">
        {header}
        <div className="ui-empty">
          <h2 className="ui-empty__title">No group projects yet</h2>
          <p className="ui-empty__copy">Project statistics show how a study group is doing on its shared tasks. Create or join a group to see them here.</p>
          <a className="ui-button ui-button--primary" href="#profile">Create or join a group</a>
        </div>
      </div>
    )
  }

  return (
    <div className="ui-page pst">
      {header}
      {error ? (
        <div className="ui-alert pst-alert" role="alert">
          <span>{data ? 'Could not refresh these statistics; showing the last loaded numbers.' : 'Could not load project statistics.'} {error}</span>
          <button type="button" className="ui-button ui-button--sm" onClick={refresh}>Try again</button>
        </div>
      ) : null}
      {data ? (
        <StatsBody key={groupId} data={data} groupId={groupId} token={token} myId={myId} profile={profile} onChanged={refresh} />
      ) : error ? null : <StatsSkeleton />}
    </div>
  )
}

function StatsBody({ data, groupId, token, myId, profile, onChanged }: {
  data: GroupAnalytics
  groupId: string
  token: string
  myId: string
  profile: Profile | null
  onChanged: () => void
}) {
  const isOwner = data.group.role === 'owner'
  const me = data.members.find((member) => member.student_id === myId)

  return (
    <>
      <div className="pst-top">
        <MembersBlock members={data.members} />
        <MeCard me={me} profile={profile} role={data.group.role} />
        <ProjectProgress data={data} groupId={groupId} token={token} isOwner={isOwner} onChanged={onChanged} />
      </div>

      <p className="pst-line">
        Projected finish date: {data.projected_finish ? `${longDate(data.projected_finish)}.` : '—'}
      </p>

      <PaceLine data={data} groupId={groupId} token={token} isOwner={isOwner} onChanged={onChanged} />

      <ReportsArea data={data} />
    </>
  )
}

/* ---------- Members: three bracketed columns ---------- */

function PersonGlyph() {
  return (
    <svg className="pst-person" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5" r="2.6" />
      <path d="M3.2 14c.4-2.9 2.3-4.6 4.8-4.6s4.4 1.7 4.8 4.6" />
    </svg>
  )
}

function MembersBlock({ members }: { members: Member[] }) {
  const [showAll, setShowAll] = useState(false)
  const active = members.filter((member) => member.active)
  const inactive = members.filter((member) => !member.active)
  const second = inactive.slice(0, INACTIVE_PER_COLUMN)
  const overflow = inactive.slice(INACTIVE_PER_COLUMN)
  const third = showAll ? overflow : overflow.slice(0, INACTIVE_PER_COLUMN)
  const hidden = overflow.length - third.length

  return (
    <section className="pst-members" aria-label="Members">
      <div className="pst-mcol pst-mcol--first">
        <div className="pst-mcol__head">
          <div>
            <h2 className="pst-chip pst-chip--static">Active members</h2>
            <span className="pst-sublabel" aria-hidden="true">member</span>
          </div>
          <span className="pst-done-head">Done?</span>
        </div>
        {active.length ? (
          <ul className="pst-mlist">
            {active.map((member) => {
              const done = finishedAll(member)
              return (
                <li key={member.student_id}>
                  <PersonGlyph />
                  <span className="pst-mname" title={member.display_name}>{member.display_name}</span>
                  <span
                    className={`pst-box ${done ? 'is-checked' : ''}`}
                    role="img"
                    aria-label={done ? `Finished all ${plural(member.assigned, 'task')}` : `${member.completed} of ${plural(member.assigned, 'task')} done`}
                    title={`${member.completed}/${member.assigned} tasks done`}
                  >
                    {done ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.2 2.3 2.3 4.7-5" /></svg> : null}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : <p className="pst-mempty">No one is active yet.</p>}
      </div>

      <div className="pst-mcol">
        <div className="pst-mcol__head">
          <h2 className="pst-chip pst-chip--static">Inactive members</h2>
        </div>
        {second.length ? <InactiveList members={second} /> : <p className="pst-mempty">Everyone is active.</p>}
      </div>

      <div className="pst-mcol pst-mcol--overflow">
        <div className="pst-mcol__head" aria-hidden="true" />
        {third.length ? <InactiveList members={third} label="More inactive members" /> : null}
        {hidden > 0 ? (
          <button type="button" className="pst-textbtn pst-more" onClick={() => setShowAll(true)}>+{hidden} more</button>
        ) : null}
      </div>
    </section>
  )
}

function InactiveList({ members, label }: { members: Member[]; label?: string }) {
  return (
    <ul className="pst-mlist" aria-label={label}>
      {members.map((member) => (
        <li key={member.student_id}>
          <PersonGlyph />
          <span className="pst-mname" title={member.display_name}>{member.display_name}</span>
          <span className="pst-ring" role="img" aria-label={`Inactive, ${member.completed} of ${plural(member.assigned, 'task')} done`} title={`${member.completed}/${member.assigned} tasks done`} />
        </li>
      ))}
    </ul>
  )
}

/* ---------- Signed-in student's card (tall bracket on the right) ---------- */

function MeCard({ me, profile, role }: { me: Member | undefined; profile: Profile | null; role: 'owner' | 'member' }) {
  const name = profile?.display_name || me?.display_name || 'You'
  return (
    <aside className="pst-me" aria-label="Your card">
      <div className="pst-me__row">
        <span className={`pst-me__avatar ${toneClass(toneForName(name))}`} aria-hidden="true">{courseInitial(name)}</span>
        <div className="pst-me__text">
          <div className="pst-me__name">{name}</div>
          <div className="pst-me__sub">
            {role === 'owner' ? 'Group owner' : 'Member'}
            {me ? ` · ${me.completed}/${me.assigned} tasks done` : ''}
          </div>
        </div>
      </div>
    </aside>
  )
}

/* ---------- Project progress (sections = milestones) ---------- */

function ProjectProgress({ data, groupId, token, isOwner, onChanged }: { data: GroupAnalytics; groupId: string; token: string; isOwner: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const headingId = useId()

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    setMessage('')
    try {
      await createMilestone(groupId, { title: title.trim(), due_date: due || null }, token)
      setTitle('')
      setDue('')
      setAdding(false)
      onChanged()
    } catch (error) {
      setMessage(`Could not add the section. ${errorText(error, '')}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: number) => {
    setBusy(true)
    setMessage('')
    try {
      await deleteMilestone(groupId, id, token)
      setConfirmId(null)
      onChanged()
    } catch (error) {
      setMessage(`Could not delete the section. ${errorText(error, '')}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pst-progress" aria-labelledby={headingId}>
      <h2 id={headingId} className="pst-h">Project progress</h2>
      {data.milestones.length ? (
        <table className="pst-ptable">
          <thead>
            <tr>
              <td className="pst-ptable__tick" />
              <th scope="col">Section</th>
              <th scope="col" className="pst-c">Percentage finished</th>
              <th scope="col" className="pst-c">Check status</th>
              {isOwner ? <td className="pst-ptable__act" /> : null}
            </tr>
          </thead>
          <tbody>
            {data.milestones.map((milestone) => {
              const complete = milestone.total > 0 && milestone.percent >= 100
              return (
                <tr key={milestone.id}>
                  <td className="pst-ptable__tick" aria-hidden="true">{complete ? '✓' : ''}</td>
                  <th scope="row">
                    {milestone.title}:
                    {complete ? <span className="sr-only"> (finished)</span> : null}
                  </th>
                  <td className="pst-c pst-num">{Math.round(milestone.percent)}%</td>
                  <td className="pst-c pst-num">{milestone.done}/{milestone.total}</td>
                  {isOwner ? (
                    <td className="pst-ptable__act">
                      {confirmId === milestone.id ? (
                        <span className="pst-confirm">
                          <button type="button" className="pst-textbtn pst-textbtn--danger" disabled={busy} onClick={() => remove(milestone.id)}>Delete</button>
                          <button type="button" className="pst-textbtn" onClick={() => setConfirmId(null)}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className="pst-x" aria-label={`Delete section ${milestone.title}`} title="Delete section" onClick={() => setConfirmId(milestone.id)}>×</button>
                      )}
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p className="pst-muted">{isOwner ? 'No sections yet. Add one to track each part of the project.' : 'The group owner has not split this project into sections yet.'}</p>
      )}
      {isOwner && !adding ? (
        <button type="button" className="pst-textbtn pst-add" onClick={() => { setAdding(true); setMessage('') }}>+ Add section</button>
      ) : null}
      {adding ? (
        <form className="pst-addform" onSubmit={add}>
          <input className="ui-input" aria-label="Section name" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus placeholder="Section name, e.g. Slide one" />
          <input className="ui-input" aria-label="Due date (optional)" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          <button type="submit" className={`ui-button ui-button--sm ${busy ? 'is-busy' : ''}`} disabled={busy || !title.trim()}>Add</button>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => { setAdding(false); setMessage('') }}>Cancel</button>
        </form>
      ) : null}
      {message ? <p className="pst-error" role="alert">{message}</p> : null}
    </section>
  )
}

/* ---------- Pace sentence with three owner actions ---------- */

type PaceMode = null | 'notify' | 'urgent' | 'workrate'
type UrgentPlan = { ids: string[]; locked: number }

function PaceLine({ data, groupId, token, isOwner, onChanged }: { data: GroupAnalytics; groupId: string; token: string; isOwner: boolean; onChanged: () => void }) {
  const [mode, setMode] = useState<PaceMode>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [plan, setPlan] = useState<UrgentPlan | null>(null)
  const [note, setNote] = useState(WORKRATE_MESSAGE)
  const notifyText = NOTIFY_MESSAGE[data.pace] ?? NOTIFY_MESSAGE.behind
  const memberCount = data.members.length

  const open = (next: PaceMode) => {
    setResult(null)
    setPlan(null)
    setMode((current) => (current === next ? null : next))
  }

  const send = async (message: string) => {
    if (!message.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const response = await notifyGroup(groupId, message.trim(), token)
      setResult({ ok: true, text: `Sent to ${plural(response.notified, 'member')}.` })
      setMode(null)
    } catch (error) {
      setResult({ ok: false, text: `Could not send the message. ${errorText(error, '')}` })
    } finally {
      setBusy(false)
    }
  }

  const planUrgent = async () => {
    open('urgent')
    if (mode === 'urgent') return
    setBusy(true)
    try {
      const tasks = await getTasks(token, true)
      const soon = new Date()
      soon.setDate(soon.getDate() + 3)
      const cutoff = localISODate(soon)
      const candidates = tasks.filter((task) => task.group_id === groupId && task.status !== 'done' && task.priority !== 'urgent' && task.due_date && task.due_date <= cutoff)
      setPlan({ ids: candidates.filter((task) => task.can_edit).map((task) => task.id), locked: candidates.filter((task) => !task.can_edit).length })
    } catch (error) {
      setMode(null)
      setResult({ ok: false, text: `Could not load the group's tasks. ${errorText(error, '')}` })
    } finally {
      setBusy(false)
    }
  }

  const applyUrgent = async () => {
    if (!plan) return
    setBusy(true)
    const outcomes = await Promise.allSettled(plan.ids.map((id) => updateTask(id, { priority: 'urgent' }, token)))
    const done = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
    const failed = outcomes.length - done
    setBusy(false)
    setMode(null)
    setPlan(null)
    setResult({
      ok: failed === 0,
      text: `Marked ${plural(done, 'task')} urgent.${failed ? ` ${failed} could not be updated.` : ''}${plan.locked ? ` ${plan.locked} you can't edit ${plan.locked === 1 ? 'was' : 'were'} left as is.` : ''}`,
    })
    if (done) onChanged()
  }

  return (
    <div className="pst-pace">
      <p className="pst-line pst-pace__line">
        <span>Pace:</span>
        <span className={`pst-chip pst-chip--static pst-pill ${PACE_TONE[data.pace] ?? ''}`}>{PACE_LABEL[data.pace] ?? 'Not started'}</span>
        {isOwner ? (
          <span className="pst-pace__actions">
            <button type="button" className="pst-link" aria-expanded={mode === 'notify'} onClick={() => open('notify')}>Notify all members</button>,{' '}
            <button type="button" className="pst-link" aria-expanded={mode === 'urgent'} onClick={planUrgent}>set urgent precedence</button>,{' '}
            <button type="button" className="pst-link" aria-expanded={mode === 'workrate'} onClick={() => open('workrate')}>increase workrate</button>
          </span>
        ) : null}
      </p>

      {isOwner && mode === 'notify' ? (
        <div className="pst-inline">
          <p className="pst-inline__text">Send to all {plural(memberCount, 'member')}: “{notifyText}”</p>
          <div className="pst-inline__actions">
            <button type="button" className={`ui-button ui-button--primary ui-button--sm ${busy ? 'is-busy' : ''}`} disabled={busy} onClick={() => send(notifyText)}>Send</button>
            <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {isOwner && mode === 'urgent' ? (
        <div className="pst-inline" aria-busy={busy}>
          {!plan ? <p className="pst-inline__text">Checking the group's open tasks…</p> : plan.ids.length ? (
            <>
              <p className="pst-inline__text">
                Mark {plural(plan.ids.length, 'open task')} that {plan.ids.length === 1 ? 'is' : 'are'} overdue or due within 3 days as urgent?
                {plan.locked ? ` (${plan.locked} more you can't edit will be skipped.)` : ''}
              </p>
              <div className="pst-inline__actions">
                <button type="button" className={`ui-button ui-button--primary ui-button--sm ${busy ? 'is-busy' : ''}`} disabled={busy} onClick={applyUrgent}>Mark urgent</button>
                <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => setMode(null)}>Cancel</button>
              </div>
            </>
          ) : (
            <p className="pst-inline__text">
              No open tasks you can edit are overdue or due within 3 days{plan.locked ? ` (${plan.locked} belong to others)` : ''}.
              {' '}<button type="button" className="pst-textbtn" onClick={() => setMode(null)}>Close</button>
            </p>
          )}
        </div>
      ) : null}

      {isOwner && mode === 'workrate' ? (
        <form className="pst-inline" onSubmit={(event) => { event.preventDefault(); void send(note) }}>
          <label className="pst-inline__text" htmlFor="pst-workrate">Note to all {plural(memberCount, 'member')}</label>
          <textarea id="pst-workrate" className="ui-textarea pst-inline__area" rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
          <div className="pst-inline__actions">
            <button type="submit" className={`ui-button ui-button--primary ui-button--sm ${busy ? 'is-busy' : ''}`} disabled={busy || !note.trim()}>Send note</button>
            <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {result ? <p className={result.ok ? 'pst-success' : 'pst-error'} role={result.ok ? 'status' : 'alert'}>{result.text}</p> : null}
    </div>
  )
}

/* ---------- Member reports, fan chart, AI overview ---------- */

type View = 'completion' | 'workload'
type Wedge = { key: string; label: string; value: number; fill: string }

const COMPLETION: { key: keyof GroupAnalytics['completion']; label: string; fill: string }[] = [
  { key: 'unfinished', label: 'Unfinished', fill: 'is-amber' },
  { key: 'completed', label: 'Completed', fill: 'is-green' },
  { key: 'no_response', label: 'No response', fill: 'is-gray' },
]
const MEMBER_FILLS = ['is-blue', 'is-violet', 'is-teal', 'is-orange', 'is-pink', 'is-green', 'is-amber']

function ReportsArea({ data }: { data: GroupAnalytics }) {
  const [view, setView] = useState<View>('completion')
  const [reportsOpen, setReportsOpen] = useState(false)
  const reportsId = useId()
  const overviewId = useId()

  const wedges = useMemo<Wedge[]>(() => {
    if (view === 'completion') return COMPLETION.map((item) => ({ key: item.key, label: item.label, value: data.completion[item.key], fill: item.fill }))
    // Members keep their roster order so a member's color doesn't change with their rank.
    const assigned = data.members.filter((member) => member.assigned > 0)
    const shown = assigned.length > MEMBER_FILLS.length ? assigned.slice(0, MEMBER_FILLS.length - 1) : assigned
    const rest = assigned.slice(shown.length)
    const list: Wedge[] = shown.map((member, index) => ({ key: member.student_id, label: member.display_name.split(' ')[0] || member.display_name, value: member.assigned, fill: MEMBER_FILLS[index] }))
    if (rest.length) list.push({ key: 'other', label: `${rest.length} others`, value: rest.reduce((sum, member) => sum + member.assigned, 0), fill: 'is-gray' })
    return list
  }, [view, data])

  return (
    <section className="pst-bottom" aria-label="Reports">
      <div className="pst-bottom__left">
        <button type="button" className="pst-reports-toggle" aria-expanded={reportsOpen} aria-controls={reportsId} onClick={() => setReportsOpen((value) => !value)}>
          Member reports
        </button>
      </div>

      <div className="pst-bottom__chart">
        <label className="pst-chip pst-view">
          <span className="sr-only">Chart</span>
          <select value={view} onChange={(event) => setView(event.target.value as View)}>
            <option value="completion">Task completion</option>
            <option value="workload">Workload by member</option>
          </select>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
        </label>
        <FanChart wedges={wedges} title={view === 'completion' ? 'Task completion' : 'Workload by member (assigned tasks)'} unit={view === 'completion' ? 'task' : 'assigned task'} />
      </div>

      <aside className="pst-bottom__right" aria-labelledby={overviewId}>
        <h2 id={overviewId} className="pst-h">AI overview</h2>
        {data.overview.length ? (
          <ul className="pst-overview">{data.overview.map((line, index) => <li key={index}>{line}</li>)}</ul>
        ) : <p className="pst-muted">Nothing to summarize yet.</p>}
        <p className="pst-note">(summary from task data)</p>
      </aside>

      <div id={reportsId} className="pst-reports" hidden={!reportsOpen}>
        <MemberReports members={data.members} />
      </div>
    </section>
  )
}

const CX = 260
const CY = 250
const R = 220
const LABEL_R = R * 0.6

function polar(t: number, radius: number) {
  const angle = Math.PI * (1 - t)
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)] as const
}

function wedgePath(t0: number, t1: number) {
  const f = (n: number) => n.toFixed(2)
  const [x0, y0] = polar(t0, R)
  const [x1, y1] = polar(t1, R)
  return `M${CX} ${CY} L${f(x0)} ${f(y0)} A${R} ${R} 0 0 1 ${f(x1)} ${f(y1)} Z`
}

/* Rough text width for 12–13px Inter, used only to decide inside vs. outside labels. */
function textWidth(text: string, size: number) {
  return text.length * size * 0.56
}

const VIEW_WIDTH = 560

function FanChart({ wedges, title, unit }: { wedges: Wedge[]; title: string; unit: string }) {
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // Label size in chart units, so the printed text stays about 12px however small the chart is drawn.
  const [font, setFont] = useState(13)
  const figure = useRef<HTMLElement>(null)
  const titleId = useId()
  const total = wedges.reduce((sum, wedge) => sum + wedge.value, 0)

  useEffect(() => {
    const node = figure.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (width > 0) setFont(Math.min(22, Math.max(13, Math.round((12 * VIEW_WIDTH) / width))))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const laid = useMemo(() => {
    const shares = wedges.map((wedge) => (total > 0 ? wedge.value / total : 0))
    return wedges.map((wedge, index) => {
      const share = shares[index]
      const t0 = shares.slice(0, index).reduce((sum, value) => sum + value, 0)
      const t1 = t0 + share
      const mid = (t0 + t1) / 2
      const span = share * Math.PI
      const pct = Math.round(share * 100)
      const inside = span * LABEL_R > Math.max(textWidth(wedge.label, font), textWidth(`${pct}%`, font)) + 14
      return { ...wedge, share, pct, t0, t1, mid, inside }
    })
  }, [wedges, total, font])

  const active = laid.find((wedge) => wedge.key === activeKey) ?? null

  return (
    <figure className="pst-fan" aria-labelledby={titleId} ref={figure}>
      <figcaption id={titleId} className="sr-only">{title}</figcaption>
      <svg viewBox={`-20 -24 ${VIEW_WIDTH} 280`} className="pst-fan__svg" role="group" aria-labelledby={titleId} style={{ '--fan-font': `${font}px` } as CSSProperties}>
        {total > 0 ? laid.filter((wedge) => wedge.value > 0).map((wedge) => (
          <path
            key={wedge.key}
            d={wedgePath(wedge.t0, wedge.t1)}
            className={`pst-fan__wedge ${wedge.fill} ${activeKey && activeKey !== wedge.key ? 'is-dimmed' : ''}`}
            tabIndex={0}
            role="img"
            aria-label={`${wedge.label}: ${plural(wedge.value, unit)}, ${wedge.pct}%`}
            onMouseEnter={() => setActiveKey(wedge.key)}
            onMouseLeave={() => setActiveKey(null)}
            onFocus={() => setActiveKey(wedge.key)}
            onBlur={() => setActiveKey(null)}
          />
        )) : <path d={wedgePath(0, 1)} className="pst-fan__wedge is-empty" aria-hidden="true" />}
        <path d={`M${CX - R} ${CY} A${R} ${R} 0 0 1 ${CX + R} ${CY}`} className="pst-fan__arch" aria-hidden="true" />

        {total > 0 ? laid.filter((wedge) => wedge.value > 0).map((wedge) => {
          // Text runs along the arch (perpendicular to the wedge's radius), so it never reads upside down.
          const rotate = 90 - (1 - wedge.mid) * 180
          if (wedge.inside) {
            const [x, y] = polar(wedge.mid, LABEL_R)
            return (
              <g key={wedge.key} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotate.toFixed(2)})`} className="pst-fan__text" aria-hidden="true">
                <text y={-font * 0.3} textAnchor="middle" className="pst-fan__label">{wedge.label}</text>
                <text y={font * 1.08} textAnchor="middle" className="pst-fan__pct">{wedge.pct}%</text>
              </g>
            )
          }
          const [x, y] = polar(wedge.mid, R + 12)
          return (
            <g key={wedge.key} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rotate.toFixed(2)})`} className="pst-fan__text" aria-hidden="true">
              <text y={0} textAnchor={wedge.mid < 0.2 ? 'start' : wedge.mid > 0.8 ? 'end' : 'middle'} className="pst-fan__label pst-fan__label--out">{wedge.label} {wedge.pct}%</text>
            </g>
          )
        }) : (
          <text x={CX} y={CY - 70} textAnchor="middle" className="pst-fan__label" aria-hidden="true">No tasks yet</text>
        )}
      </svg>
      <p className="pst-fan__readout" aria-live="polite">
        {active ? `${active.label}: ${plural(active.value, unit)} (${active.pct}%)` : total > 0 ? `${plural(total, unit)} · hover or tap a wedge for details` : 'No tasks assigned yet'}
      </p>
      <div className="sr-only"><table>
        <caption>{title}</caption>
        <thead><tr><th scope="col">Part</th><th scope="col">Tasks</th><th scope="col">Share</th></tr></thead>
        <tbody>
          {laid.map((wedge) => (
            <tr key={wedge.key}><th scope="row">{wedge.label}</th><td>{wedge.value}</td><td>{wedge.pct}%</td></tr>
          ))}
        </tbody>
      </table></div>
    </figure>
  )
}

function MemberReports({ members }: { members: Member[] }) {
  const sorted = [...members].sort((a, b) => percent(b.completed, b.assigned) - percent(a.completed, a.assigned) || b.completed - a.completed)
  if (!sorted.length) return <p className="pst-muted">No members yet.</p>
  return (
    <table className="pst-rtable">
      <caption className="sr-only">Member reports</caption>
      <thead>
        <tr>
          <th scope="col">Member</th>
          <th scope="col" className="pst-num">Assigned</th>
          <th scope="col" className="pst-num">Done</th>
          <th scope="col" className="pst-num">%</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((member) => (
          <tr key={member.student_id}>
            <th scope="row">{member.display_name}{member.role === 'owner' ? <span className="pst-muted"> · owner</span> : null}</th>
            <td className="pst-num">{member.assigned}</td>
            <td className="pst-num">{member.completed}</td>
            <td className="pst-num">{member.assigned ? `${percent(member.completed, member.assigned)}%` : '—'}</td>
            <td>{member.active ? 'Active' : 'Inactive'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatsSkeleton() {
  return (
    <div className="pst-skel" aria-busy="true" aria-label="Loading project statistics">
      <div className="pst-top">
        <div className="pst-members">
          {[0, 1, 2].map((col) => (
            <div key={col} className="pst-mcol">
              {[0, 1, 2, 3].map((row) => <span key={row} className="ui-skeleton pst-skel__row" />)}
            </div>
          ))}
        </div>
        <div className="pst-me"><span className="ui-skeleton pst-skel__row" /></div>
        <div className="pst-progress">{[0, 1, 2].map((row) => <span key={row} className="ui-skeleton pst-skel__row" />)}</div>
      </div>
      <span className="ui-skeleton pst-skel__fan" />
    </div>
  )
}
