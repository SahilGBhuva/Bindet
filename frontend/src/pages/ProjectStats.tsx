import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AuthSession } from '../lib/auth'
import {
  createMilestone,
  deleteMilestone,
  getCachedGroupAnalytics,
  getCachedStudyGroups,
  getGroupAnalytics,
  getStudyGroups,
  notifyGroup,
  parseServerTime,
  type GroupAnalytics,
  type StudyGroup,
} from '../lib/api'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import './ProjectStats.css'

type Pace = GroupAnalytics['pace']
type Member = GroupAnalytics['members'][number]

const PACE: Record<Pace, { label: string; badge: string; note: string }> = {
  on_track: { label: 'On track', badge: 'ui-badge--positive', note: 'The group is finishing work fast enough to meet the target.' },
  at_risk: { label: 'At risk', badge: 'ui-badge--warning', note: 'At this pace the group will finish close to or after the target.' },
  behind: { label: 'Unacceptable', badge: 'ui-badge--danger', note: 'At this pace the group will miss the target date.' },
  stalled: { label: 'Stalled', badge: 'ui-badge--warning', note: 'No tasks were finished recently.' },
  done: { label: 'Done', badge: 'ui-badge--positive', note: 'Every task in this project is finished.' },
  not_started: { label: 'Not started', badge: '', note: 'No group tasks have been finished yet.' },
}

const NOTIFY_MESSAGE: Record<Pace, string> = {
  behind: "We're behind schedule — please check your tasks and set urgent ones first.",
  at_risk: "We're at risk of missing our date — please check your tasks and finish urgent ones first.",
  stalled: 'Nothing has moved recently — please check your tasks and update their status.',
  on_track: "We're on track — keep going and mark tasks done as you finish them.",
  done: 'Everything is finished — great work, everyone.',
  not_started: "Let's get started — please check the board and pick up your tasks.",
}

/* Read the optional group id from "#stats?group=<id>". */
function groupFromHash() {
  const query = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('group') ?? ''
}

function formatDate(value: string | null | undefined, withWeekday = false) {
  if (!value) return ''
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00`) : parseServerTime(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleDateString(undefined, { month: 'long', day: 'numeric', ...(withWeekday ? { weekday: 'short' } : {}) })
}

function timeAgo(value: string) {
  const time = parseServerTime(value)
  if (Number.isNaN(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : formatDate(value)
}

function percent(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span className={`ui-avatar ${large ? 'ui-avatar--lg' : ''} ${toneClass(toneForName(name))}`} aria-hidden="true">
      {courseInitial(name)}
    </span>
  )
}

export function ProjectStats({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const myId = session?.user.id ?? ''

  const [groups, setGroups] = useState<StudyGroup[] | null>(() => (token ? getCachedStudyGroups(token) : null))
  const [groupsError, setGroupsError] = useState('')
  const [groupsReload, setGroupsReload] = useState(0)
  const [hashGroup, setHashGroup] = useState(groupFromHash)

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

  const groupId = groups?.some((group) => group.id === hashGroup) ? hashGroup : groups?.[0]?.id ?? ''

  useEffect(() => {
    if (!token || !groupId) return
    let active = true
    getGroupAnalytics(groupId, token)
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
    <header className="ui-page-header pstats-header">
      <div>
        <p className="ui-eyebrow">Study groups</p>
        <h1 className="ui-page-title">Project statistics</h1>
      </div>
      {groups && groups.length > 0 ? (
        <label className="pstats-group-chip">
          <span>Group</span>
          <select className="ui-select" value={groupId} onChange={(event) => chooseGroup(event.target.value)}>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
      ) : null}
    </header>
  )

  if (!session) {
    return (
      <div className="ui-page pstats">
        {header}
        <div className="ui-empty"><p className="ui-empty__copy">Sign in to see statistics for your study groups.</p></div>
      </div>
    )
  }

  if (!groups) {
    return (
      <div className="ui-page pstats">
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
      <div className="ui-page pstats">
        {header}
        <div className="ui-empty">
          <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" width={240} height={288} alt="" />
          <h2 className="ui-empty__title">No group projects yet</h2>
          <p className="ui-empty__copy">Project statistics show how a study group is doing on its shared tasks. Create or join a group to see them here.</p>
          <a className="ui-button ui-button--primary" href="#profile">Create or join a group</a>
        </div>
      </div>
    )
  }

  return (
    <div className="ui-page pstats">
      {header}
      {error ? (
        <div className="ui-alert pstats-alert" role="alert">
          <span>{data ? 'Could not refresh these statistics; showing the last loaded numbers.' : 'Could not load project statistics.'} {error}</span>
          <button type="button" className="ui-button ui-button--sm" onClick={refresh}>Try again</button>
        </div>
      ) : null}
      {data ? (
        <StatsBody key={groupId} data={data} groupId={groupId} token={token} myId={myId} onChanged={refresh} />
      ) : error ? null : <StatsSkeleton />}
    </div>
  )
}

function StatsBody({ data, groupId, token, myId, onChanged }: { data: GroupAnalytics; groupId: string; token: string; myId: string; onChanged: () => void }) {
  const isOwner = data.group.role === 'owner'
  const active = data.members.filter((member) => member.active)
  const inactive = data.members.filter((member) => !member.active)
  const me = data.members.find((member) => member.student_id === myId)

  return (
    <div className="pstats-grid">
      <section className="pstats-members" aria-labelledby="pstats-members-title">
        <h2 id="pstats-members-title" className="sr-only">Members</h2>
        <MemberBox title="Active members" members={active} empty="No one has finished a task recently." />
        <MemberBox title="Inactive members" members={inactive} empty="Everyone is active." />
      </section>

      <aside className="ui-panel pstats-me" aria-label="Your summary">
        {me ? (
          <>
            <Avatar name={me.display_name} large />
            <div className="pstats-me__name">{me.display_name}</div>
            <div className="pstats-me__role">{me.role === 'owner' ? 'Group owner' : 'Member'} · {data.group.name}</div>
            <dl className="pstats-me__stats">
              <div><dt>Assigned</dt><dd>{me.assigned}</dd></div>
              <div><dt>Completed</dt><dd>{me.completed}</dd></div>
              <div><dt>Done</dt><dd>{percent(me.completed, me.assigned)}%</dd></div>
            </dl>
            <span className={`ui-badge ${me.active ? 'ui-badge--positive' : 'ui-badge--warning'}`}>{me.active ? 'Active' : 'Inactive'}</span>
            <a className="ui-link pstats-me__link" href="#goals">Open my tasks</a>
          </>
        ) : (
          <p className="ui-muted">You are not listed as a member of this project.</p>
        )}
      </aside>

      <ProjectProgress data={data} groupId={groupId} token={token} isOwner={isOwner} onChanged={onChanged} />

      <PaceRow data={data} groupId={groupId} token={token} isOwner={isOwner} />

      <CompletionChart completion={data.completion} />

      <MemberReports members={data.members} />

      <section className="ui-panel pstats-overview" aria-labelledby="pstats-overview-title">
        <h2 id="pstats-overview-title" className="ui-section-title">Overview</h2>
        {data.overview.length ? (
          <ul className="pstats-overview__list">{data.overview.map((line, index) => <li key={index}>{line}</li>)}</ul>
        ) : <p className="ui-muted pstats-empty-line">Nothing to summarize yet.</p>}
        <p className="pstats-overview__note">Summarized from this group's task numbers.</p>
        {data.activity.length ? (
          <>
            <h3 className="pstats-subtitle">Recent activity</h3>
            <ul className="pstats-activity">
              {data.activity.slice(0, 6).map((item) => (
                <li key={item.id}>
                  <span>
                    <strong>{item.actor_name}</strong> {item.detail || item.kind.replace(/_/g, ' ')}
                    {item.task_title ? <> · <span className="pstats-activity__task">{item.task_title}</span></> : null}
                  </span>
                  <time dateTime={item.created_at}>{timeAgo(item.created_at)}</time>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  )
}

function MemberBox({ title, members, empty }: { title: string; members: Member[]; empty: string }) {
  return (
    <div className="ui-panel pstats-box">
      <div className="pstats-box__head">
        <h3>{title} <span className="pstats-box__count">{members.length}</span></h3>
        <span className="pstats-box__col" aria-hidden="true">Done</span>
      </div>
      {members.length ? (
        <ul className="pstats-box__list">
          {members.map((member) => {
            const complete = member.assigned > 0 && member.completed >= member.assigned
            return (
              <li key={member.student_id}>
                <Avatar name={member.display_name} />
                <span className="pstats-box__name">{member.display_name}{member.role === 'owner' ? <span className="pstats-box__role"> · owner</span> : null}</span>
                <span className={`pstats-done ${complete ? 'is-complete' : ''}`}>
                  <span className="sr-only">{member.completed} of {member.assigned} tasks done</span>
                  <span aria-hidden="true">{member.completed}/{member.assigned}</span>
                </span>
              </li>
            )
          })}
        </ul>
      ) : <p className="pstats-box__empty">{empty}</p>}
    </div>
  )
}

function ProjectProgress({ data, groupId, token, isOwner, onChanged }: { data: GroupAnalytics; groupId: string; token: string; isOwner: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [message, setMessage] = useState('')

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
    <section className="ui-panel pstats-progress" aria-labelledby="pstats-progress-title">
      <div className="pstats-card-head">
        <h2 id="pstats-progress-title" className="ui-section-title">Project progress</h2>
        {isOwner && !adding ? <button type="button" className="ui-button ui-button--sm" onClick={() => setAdding(true)}>Add section</button> : null}
      </div>
      {data.milestones.length ? (
        <div className="pstats-table-wrap">
          <table className="pstats-table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">Percentage finished</th>
                <th scope="col" className="pstats-num">Check status</th>
                {isOwner ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((milestone) => {
                const complete = milestone.total > 0 && milestone.percent >= 100
                return (
                  <tr key={milestone.id}>
                    <th scope="row">
                      <span className="pstats-section">
                        <span className={`pstats-check ${complete ? 'is-complete' : ''}`} aria-hidden="true">{complete ? <CheckMark /> : null}</span>
                        <span className="pstats-section__title">
                          {milestone.title}
                          {complete ? <span className="sr-only"> (finished)</span> : null}
                          {milestone.due_date ? <small>Due {formatDate(milestone.due_date)}</small> : null}
                        </span>
                      </span>
                    </th>
                    <td>
                      <span className="pstats-pct">
                        <span className="ui-meter pstats-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, milestone.percent))}%` }} /></span>
                        {Math.round(milestone.percent)}%
                      </span>
                    </td>
                    <td className="pstats-num">{milestone.done}/{milestone.total}</td>
                    {isOwner ? (
                      <td className="pstats-actions">
                        {confirmId === milestone.id ? (
                          <span className="pstats-confirm">
                            <button type="button" className={`ui-button ui-button--danger ui-button--sm ${busy ? 'is-busy' : ''}`} disabled={busy} onClick={() => remove(milestone.id)}>Delete</button>
                            <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => setConfirmId(null)}>Keep</button>
                          </span>
                        ) : (
                          <button type="button" className="ui-button ui-button--ghost ui-button--sm" aria-label={`Delete section ${milestone.title}`} onClick={() => setConfirmId(milestone.id)}>Delete</button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="pstats-empty-line">{isOwner ? 'Split the project into sections to track each part. Tasks linked to a section count toward it.' : 'The group owner has not split this project into sections yet.'}</p>
      )}
      {adding ? (
        <form className="pstats-inline-form" onSubmit={add}>
          <label className="ui-field">
            <span>Section name</span>
            <input className="ui-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus placeholder="e.g. Slide one" />
          </label>
          <label className="ui-field">
            <span>Due date (optional)</span>
            <input className="ui-input" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <div className="pstats-inline-form__actions">
            <button type="submit" className={`ui-button ${busy ? 'is-busy' : ''}`} disabled={busy || !title.trim()}>Add section</button>
            <button type="button" className="ui-button ui-button--ghost" onClick={() => { setAdding(false); setMessage('') }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {message ? <p className="pstats-error" role="alert">{message}</p> : null}
    </section>
  )
}

function PaceRow({ data, groupId, token, isOwner }: { data: GroupAnalytics; groupId: string; token: string; isOwner: boolean }) {
  const pace = PACE[data.pace] ?? PACE.not_started
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState(() => NOTIFY_MESSAGE[data.pace] ?? NOTIFY_MESSAGE.behind)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!message.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const response = await notifyGroup(groupId, message.trim(), token)
      setResult({ ok: true, text: `Sent to ${response.notified} ${response.notified === 1 ? 'member' : 'members'}.` })
      setOpen(false)
    } catch (error) {
      setResult({ ok: false, text: `Could not send the message. ${errorText(error, '')}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ui-panel pstats-pace" aria-labelledby="pstats-pace-title">
      <h2 id="pstats-pace-title" className="sr-only">Schedule</h2>
      <div className="pstats-pace__row">
        <dl className="pstats-pace__facts">
          <div>
            <dt>Projected finish date</dt>
            <dd>{data.pace === 'done' ? 'Finished' : data.projected_finish ? formatDate(data.projected_finish, true) : <span className="ui-muted">Not enough finished work yet</span>}</dd>
          </div>
          {data.target_date ? (
            <div>
              <dt>Target</dt>
              <dd>{formatDate(data.target_date, true)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Pace</dt>
            <dd><span className={`ui-badge pstats-pace__badge ${pace.badge}`}>{pace.label}</span></dd>
          </div>
          <div>
            <dt>Velocity</dt>
            <dd>{Math.round(data.velocity_per_week * 10) / 10} tasks/week</dd>
          </div>
        </dl>
        {isOwner && !open ? (
          <button type="button" className="ui-button ui-button--sm pstats-notify__open" onClick={() => { setOpen(true); setResult(null) }}>Notify all members</button>
        ) : null}
      </div>
      <p className="pstats-pace__note">{pace.note}</p>
      {isOwner && open ? (
        <form className="pstats-notify__form" onSubmit={send}>
          <label className="ui-field">
            <span>Message to every member</span>
            <textarea className="ui-textarea" rows={3} maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} autoFocus />
          </label>
          <div className="pstats-inline-form__actions">
            <button type="submit" className={`ui-button ui-button--primary ${busy ? 'is-busy' : ''}`} disabled={busy || !message.trim()}>Send to all members</button>
            <button type="button" className="ui-button ui-button--ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      {isOwner && result ? <p className={result.ok ? 'pstats-success' : 'pstats-error'} role={result.ok ? 'status' : 'alert'}>{result.text}</p> : null}
    </section>
  )
}

/* Half-donut ("fan") chart for task completion, ordered left to right like the sketch. */
const SEGMENTS = [
  { key: 'unfinished', label: 'Unfinished', className: 'is-unfinished' },
  { key: 'completed', label: 'Completed', className: 'is-completed' },
  { key: 'no_response', label: 'No response', className: 'is-none' },
] as const
type SegmentKey = (typeof SEGMENTS)[number]['key']

const CX = 200
const CY = 190
const R_OUT = 150
const R_IN = 92

function point(t: number, radius: number) {
  const angle = Math.PI * (1 - t)
  return [CX + radius * Math.cos(angle), CY - radius * Math.sin(angle)] as const
}

function arcPath(t0: number, t1: number) {
  const end = Math.min(t1, 0.99999)
  const [x0, y0] = point(t0, R_OUT)
  const [x1, y1] = point(end, R_OUT)
  const [x2, y2] = point(end, R_IN)
  const [x3, y3] = point(t0, R_IN)
  const f = (n: number) => n.toFixed(2)
  return `M${f(x0)} ${f(y0)} A${R_OUT} ${R_OUT} 0 0 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${R_IN} ${R_IN} 0 0 0 ${f(x3)} ${f(y3)} Z`
}

function CompletionChart({ completion }: { completion: GroupAnalytics['completion'] }) {
  const [activeKey, setActiveKey] = useState<SegmentKey | null>(null)
  const total = completion.completed + completion.unfinished + completion.no_response

  const segments = useMemo(() => {
    const shares = SEGMENTS.map((segment) => (total > 0 ? completion[segment.key] / total : 0))
    return SEGMENTS.map((segment, index) => {
      const share = shares[index]
      const t0 = shares.slice(0, index).reduce((sum, value) => sum + value, 0)
      return { ...segment, value: completion[segment.key], share, pct: Math.round(share * 100), t0, t1: t0 + share }
    })
  }, [completion, total])

  const active = segments.find((segment) => segment.key === activeKey) ?? null
  const shown = active ?? segments[1]

  return (
    <section className="ui-panel pstats-chart" aria-labelledby="pstats-chart-title">
      <h2 id="pstats-chart-title" className="ui-section-title">Task completion</h2>
      <p className="pstats-chart__caption">{total > 0 ? `${total} assigned ${total === 1 ? 'task' : 'tasks'} · hover or focus a segment for details` : 'No tasks assigned yet'}</p>
      <figure className="pstats-chart__figure">
        <svg viewBox="0 0 400 200" className="pstats-fan" role="group" aria-labelledby="pstats-chart-title">
          {total > 0 ? (
            <>
              {segments.filter((segment) => segment.value > 0).map((segment) => (
                <path
                  key={segment.key}
                  d={arcPath(segment.t0, segment.t1)}
                  className={`pstats-fan__seg ${segment.className} ${activeKey && activeKey !== segment.key ? 'is-dimmed' : ''}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${segment.label}: ${segment.value} ${segment.value === 1 ? 'task' : 'tasks'}, ${segment.pct}%`}
                  onMouseEnter={() => setActiveKey(segment.key)}
                  onMouseLeave={() => setActiveKey(null)}
                  onFocus={() => setActiveKey(segment.key)}
                  onBlur={() => setActiveKey(null)}
                />
              ))}
              {segments.filter((segment) => segment.share >= 0.04).map((segment) => {
                const mid = (segment.t0 + segment.t1) / 2
                const [x, y] = point(mid, R_OUT + 14)
                const anchor = mid < 0.35 ? 'end' : mid > 0.65 ? 'start' : 'middle'
                return (
                  <text key={segment.key} x={x} y={Math.min(y + 4, CY)} textAnchor={anchor} className="pstats-fan__label" aria-hidden="true">
                    {segment.pct}%
                  </text>
                )
              })}
            </>
          ) : (
            <path d={arcPath(0, 1)} className="pstats-fan__track" aria-hidden="true" />
          )}
          <text x={CX} y={CY - 30} textAnchor="middle" className="pstats-fan__value" aria-hidden="true">
            {total > 0 ? `${shown.pct}%` : '0'}
          </text>
          <text x={CX} y={CY - 8} textAnchor="middle" className="pstats-fan__key" aria-hidden="true">
            {total > 0 ? `${shown.label.toLowerCase()} · ${shown.value} ${shown.value === 1 ? 'task' : 'tasks'}` : 'tasks yet'}
          </text>
        </svg>
        <figcaption className="pstats-legend">
          {segments.map((segment) => (
            <span key={segment.key} className="pstats-legend__item">
              <span className={`pstats-legend__swatch ${segment.className}`} aria-hidden="true" />
              {segment.label}
              <span className="pstats-legend__value">{segment.value} · {segment.pct}%</span>
            </span>
          ))}
        </figcaption>
      </figure>
      <table className="sr-only">
        <caption>Task completion by status</caption>
        <thead><tr><th scope="col">Status</th><th scope="col">Tasks</th><th scope="col">Share</th></tr></thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.key}><th scope="row">{segment.label}</th><td>{segment.value}</td><td>{segment.pct}%</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function MemberReports({ members }: { members: Member[] }) {
  const sorted = [...members].sort((a, b) => percent(b.completed, b.assigned) - percent(a.completed, a.assigned) || b.completed - a.completed)
  return (
    <section className="ui-panel pstats-reports" aria-labelledby="pstats-reports-title">
      <h2 id="pstats-reports-title" className="ui-section-title">Member reports</h2>
      {sorted.length ? (
        <div className="pstats-table-wrap">
          <table className="pstats-table pstats-table--compact">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col" className="pstats-num">Assigned</th>
                <th scope="col" className="pstats-num">Done</th>
                <th scope="col" className="pstats-num">%</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((member) => (
                <tr key={member.student_id}>
                  <th scope="row"><span className="pstats-report-name"><Avatar name={member.display_name} /><span>{member.display_name}</span></span></th>
                  <td className="pstats-num">{member.assigned}</td>
                  <td className="pstats-num">{member.completed}</td>
                  <td className="pstats-num">{member.assigned ? `${percent(member.completed, member.assigned)}%` : '—'}</td>
                  <td><span className={`ui-badge ${member.active ? 'ui-badge--positive' : 'ui-badge--warning'}`}>{member.active ? 'Active' : 'Inactive'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="ui-muted pstats-empty-line">No members yet.</p>}
    </section>
  )
}

function CheckMark() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
}

function StatsSkeleton() {
  return (
    <div className="pstats-grid" aria-busy="true" aria-label="Loading project statistics">
      <div className="pstats-members">
        {[0, 1].map((box) => (
          <div key={box} className="ui-panel pstats-box pstats-skel">
            <span className="ui-skeleton pstats-skel__title" />
            {[0, 1, 2, 3].map((row) => <span key={row} className="ui-skeleton pstats-skel__row" />)}
          </div>
        ))}
      </div>
      <div className="ui-panel pstats-me">
        <span className="ui-skeleton pstats-skel__avatar" />
        <span className="ui-skeleton pstats-skel__title" />
        <span className="ui-skeleton pstats-skel__block" />
      </div>
      <div className="ui-panel pstats-progress pstats-skel">
        <span className="ui-skeleton pstats-skel__title" />
        {[0, 1, 2].map((row) => <span key={row} className="ui-skeleton pstats-skel__row" />)}
      </div>
      <div className="ui-panel pstats-pace pstats-skel"><span className="ui-skeleton pstats-skel__row" /></div>
      <div className="ui-panel pstats-chart pstats-skel">
        <span className="ui-skeleton pstats-skel__title" />
        <span className="ui-skeleton pstats-skel__fan" />
      </div>
      <div className="ui-panel pstats-reports pstats-skel">
        <span className="ui-skeleton pstats-skel__title" />
        {[0, 1, 2].map((row) => <span key={row} className="ui-skeleton pstats-skel__row" />)}
      </div>
      <div className="ui-panel pstats-overview pstats-skel">
        <span className="ui-skeleton pstats-skel__title" />
        {[0, 1, 2].map((row) => <span key={row} className="ui-skeleton pstats-skel__row" />)}
      </div>
    </div>
  )
}
