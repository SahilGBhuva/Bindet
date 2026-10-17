import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../lib/api'
import { useAnnounce } from '../../lib/announce'
import type { AuthSession } from '../../lib/auth'
import {
  checkClassroomLink, connectClassroom, disconnectClassroom, LINK_HINTS, listClassroomFeeds,
  notebookWithClassroomCourse, setClassroomNotes, syncClassroom, type ClassroomFeed,
} from '../../lib/classroom'
import { loadNotebook, onNotebookChange, saveNotebook, sameName } from '../../lib/session'
import { useDrawer } from '../../lib/useDrawer'
import './ClassroomConnections.css'

const NEW_COURSE = '__new__'

const Icon = {
  calendar: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17M8 14h3" /></svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
  ),
  sync: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16" /><path d="M20 20v-4h-4" /></svg>
  ),
}

function errorText(caught: unknown, fallback: string) {
  if (caught instanceof ApiError) return caught.message
  if (caught instanceof Error && caught.name === 'OfflineError') return caught.message
  return fallback
}

function ago(value: string | null, now = Date.now()) {
  if (!value) return 'Not synced yet'
  const then = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`)
  if (Number.isNaN(then)) return 'Not synced yet'
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return 'Synced just now'
  if (minutes < 60) return `Synced ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Synced ${hours} h ago`
  return `Synced ${new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

const STATUS_PROBLEM: Partial<Record<ClassroomFeed['last_status'], string>> = {
  private: 'The last sync failed: that calendar is private or the link was reset. Disconnect and paste the new secret address.',
  unreachable: 'The last sync failed: Google didn’t answer. Try Sync now in a minute.',
  invalid: 'The last sync didn’t return a calendar.',
}

function courseInitial(name: string) {
  return (name.trim()[0] ?? '?').toUpperCase()
}

/* Settings → Google Classroom: how to get the link, connect a class, and the connected classes. */
export function ClassroomConnections({ session }: { session: AuthSession }) {
  const token = session.access_token
  const [feeds, setFeeds] = useState<ClassroomFeed[] | null>(null)
  const [maxFeeds, setMaxFeeds] = useState(15)
  const [loadError, setLoadError] = useState('')
  const [notebook, setNotebook] = useState(loadNotebook)
  const [link, setLink] = useState('')
  const [touched, setTouched] = useState(false)
  const [course, setCourse] = useState(() => loadNotebook().activeCourse || NEW_COURSE)
  const [newCourse, setNewCourse] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [status, setStatus] = useState('')
  const [rowBusy, setRowBusy] = useState<Record<string, string>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [leaving, setLeaving] = useState<ClassroomFeed | null>(null)
  const ids = { link: useId(), linkHint: useId(), course: useId(), newCourse: useId(), steps: useId() }
  useAnnounce(status)
  useAnnounce(formError, { error: true })

  useEffect(() => onNotebookChange(() => setNotebook(loadNotebook())), [])

  useEffect(() => {
    let live = true
    listClassroomFeeds(token)
      .then((data) => { if (live) { setFeeds(data.feeds); setMaxFeeds(data.max_feeds) } })
      .catch((caught) => { if (live) setLoadError(errorText(caught, 'Could not load your connected classes.')) })
    return () => { live = false }
  }, [token])

  const courses = notebook.courses
  const tones = useMemo(() => new Map(courses.map((item) => [item.name.trim(), item.tone])), [courses])
  const check = checkClassroomLink(link)
  const hint = check === 'empty' || check === 'ok' ? '' : LINK_HINTS[check]
  const chosenCourse = (course === NEW_COURSE || !courses.some((item) => item.name === course) ? newCourse : course).trim()
  const full = feeds !== null && feeds.length >= maxFeeds
  const canConnect = check === 'ok' && chosenCourse.length > 0 && !busy && !full

  async function connect(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (!canConnect) return
    setBusy(true)
    setFormError('')
    setStatus('')
    try {
      const feed = await connectClassroom(link, chosenCourse, token)
      saveNotebook(notebookWithClassroomCourse(loadNotebook(), feed.course, (feed.sync?.notes ?? 0) > 0))
      setFeeds((current) => [...(current ?? []), feed])
      setLink('')
      setTouched(false)
      setNewCourse('')
      setCourse(feed.course)
      const created = feed.sync?.created ?? 0
      setStatus(`Connected ${feed.course}. ${created === 1 ? '1 assignment' : `${created} assignments`} added to Tasks.`)
    } catch (caught) {
      setFormError(errorText(caught, 'Could not connect that class. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function runRow(feed: ClassroomFeed, label: string, action: () => Promise<ClassroomFeed | null>) {
    setRowBusy((current) => ({ ...current, [feed.id]: label }))
    setRowError((current) => ({ ...current, [feed.id]: '' }))
    try {
      const updated = await action()
      if (updated) setFeeds((current) => (current ?? []).map((item) => (item.id === feed.id ? updated : item)))
      return updated
    } catch (caught) {
      setRowError((current) => ({ ...current, [feed.id]: errorText(caught, 'That didn’t work. Try again.') }))
      return null
    } finally {
      setRowBusy((current) => ({ ...current, [feed.id]: '' }))
    }
  }

  async function syncNow(feed: ClassroomFeed) {
    const updated = await runRow(feed, 'sync', () => syncClassroom(feed.id, token))
    if (!updated) {
      // The server recorded why it failed; show it on the row.
      void listClassroomFeeds(token).then((data) => setFeeds(data.feeds)).catch(() => undefined)
      return
    }
    if ((updated.sync?.notes ?? 0) > 0) saveNotebook(notebookWithClassroomCourse(loadNotebook(), updated.course, true))
    const changed = (updated.sync?.created ?? 0) + (updated.sync?.updated ?? 0)
    setStatus(`${updated.course} is up to date${changed ? `: ${changed} ${changed === 1 ? 'assignment' : 'assignments'} added or changed` : ''}.`)
  }

  function toggleNotes(feed: ClassroomFeed) {
    void runRow(feed, 'notes', () => setClassroomNotes(feed.id, !feed.save_notes, token))
  }

  async function disconnect(feed: ClassroomFeed, deleteTasks: boolean) {
    const done = await runRow(feed, 'disconnect', async () => {
      const result = await disconnectClassroom(feed.id, deleteTasks, token)
      setFeeds((current) => (current ?? []).filter((item) => item.id !== feed.id))
      setStatus(deleteTasks
        ? `Disconnected ${feed.course} and deleted ${result.tasks_deleted === 1 ? '1 imported task' : `${result.tasks_deleted} imported tasks`}.`
        : `Disconnected ${feed.course}. Its tasks stay in Tasks.`)
      return null
    })
    void done
    setLeaving(null)
  }

  return (
    <div className="classroom">
      <div className="ui-panel classroom__how ui-tone--blue">
        <div className="classroom__how-head">
          <span className="ui-icon classroom__icon">{Icon.calendar}</span>
          <div>
            <h3 className="classroom__title" id={ids.steps}>Get your class’s calendar link</h3>
            <p className="classroom__copy">Google Classroom puts every class’s assignments on a Google Calendar. Do this once per class.</p>
          </div>
        </div>
        <ol className="classroom__steps" aria-labelledby={ids.steps}>
          <li>Open <b>Google Calendar</b> on a computer.</li>
          <li>Click <b>⋮</b> next to the class calendar under “My calendars”.</li>
          <li>Choose <b>Settings and sharing</b>.</li>
          <li>Copy the <b>Secret address in iCal format</b> and paste it below.</li>
        </ol>
        <ul className="classroom__features">
          <li><span className="ui-badge ui-badge--tone ui-tone--violet">Tasks</span> Each assignment becomes a task with its due date, kept in sync. Its priority follows how soon it’s due until you change it yourself.</li>
          <li><span className="ui-badge ui-badge--tone ui-tone--green">Notes</span> Longer instructions are saved as a note in the course’s “Classroom” unit, ready for Otto, guides and flashcards. You can turn this off per class.</li>
        </ul>
        <p className="classroom__secret">Treat the link like a password: anyone who has it can see that calendar. bindet keeps it private and never shows it again.</p>
      </div>

      <form className="ui-panel classroom__form" onSubmit={(event) => void connect(event)} noValidate>
        <label className="classroom__field" htmlFor={ids.link}>
          <span className="settings__label">Secret address in iCal format</span>
          <span className={`classroom__input-wrap${check === 'ok' ? ' is-ok' : ''}`}>
            <span className="classroom__input-icon" aria-hidden="true">{check === 'ok' ? Icon.check : Icon.link}</span>
            <input
              id={ids.link}
              className="ui-input classroom__input"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              value={link}
              aria-invalid={touched && check !== 'ok' && check !== 'empty' ? true : undefined}
              aria-describedby={ids.linkHint}
              onChange={(event) => { setLink(event.target.value); setTouched(true); setFormError('') }}
              disabled={busy}
            />
          </span>
          <span id={ids.linkHint} className={`classroom__hint${hint && touched ? ' is-error' : ''}${check === 'ok' ? ' is-ok' : ''}`} aria-live="polite">
            {check === 'ok' ? 'Looks right.' : touched && hint ? hint : 'It starts with https://calendar.google.com/calendar/ical/'}
          </span>
        </label>

        <div className="classroom__course">
          <label className="classroom__field" htmlFor={ids.course}>
            <span className="settings__label">Add assignments to</span>
            <select id={ids.course} className="ui-select classroom__input" value={courses.some((item) => item.name === course) ? course : NEW_COURSE} onChange={(event) => setCourse(event.target.value)} disabled={busy}>
              {courses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
              <option value={NEW_COURSE}>New course…</option>
            </select>
          </label>
          {course === NEW_COURSE || !courses.some((item) => item.name === course) ? (
            <label className="classroom__field" htmlFor={ids.newCourse}>
              <span className="settings__label">New course name</span>
              <input id={ids.newCourse} className="ui-input classroom__input" value={newCourse} maxLength={120} placeholder="e.g. AP Biology" autoComplete="off" onChange={(event) => setNewCourse(event.target.value)} disabled={busy} />
            </label>
          ) : null}
        </div>

        {formError ? <div className="ui-alert" role="alert"><span>{formError}</span></div> : null}
        {full ? <p className="settings__hint">You’ve connected {maxFeeds} classes, the most bindet allows. Disconnect one to add another.</p> : null}
        <div className="classroom__actions">
          {status ? <p className="settings__status" role="status">{status}</p> : null}
          <button type="submit" className={`ui-button ui-button--primary classroom__connect${busy ? ' is-busy' : ''}`} disabled={!canConnect}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>

      <section className="classroom__list" aria-label="Connected classes">
        <h3 className="classroom__list-title">Connected classes{feeds?.length ? <span className="ui-count">{feeds.length}</span> : null}</h3>
        {loadError ? <div className="ui-alert" role="alert"><span>{loadError}</span></div> : null}
        {feeds === null && !loadError ? <div className="ui-skeleton classroom__skeleton" aria-label="Loading connected classes" /> : null}
        {feeds?.length === 0 ? <p className="classroom__empty">No classes connected yet. Paste a link above to bring in your assignments.</p> : null}
        {feeds?.length ? (
          <ul className="classroom__feeds">
            {feeds.map((feed) => {
              const tone = tones.get(feed.course.trim()) ?? [...tones.entries()].find(([name]) => sameName(name, feed.course))?.[1]
              const working = rowBusy[feed.id] ?? ''
              const problem = STATUS_PROBLEM[feed.last_status]
              return (
                <li key={feed.id} className="ui-panel ui-course-row classroom__feed" style={tone ? { ['--course' as string]: tone } : undefined}>
                  <div className="classroom__feed-head">
                    <span className="ui-course-mark" aria-hidden="true">{courseInitial(feed.course)}</span>
                    <div className="classroom__feed-text">
                      <span className="classroom__feed-course">{feed.course}</span>
                      <span className="classroom__feed-url" title="Your secret link is hidden">{feed.masked_url}</span>
                      <span className="classroom__feed-meta">
                        <span className="ui-badge ui-badge--tone ui-tone--blue">{feed.imported_count === 1 ? '1 assignment' : `${feed.imported_count} assignments`}</span>
                        <span>{ago(feed.last_synced_at)}</span>
                      </span>
                    </div>
                  </div>
                  {problem ? <p className="classroom__problem">{problem}</p> : null}
                  <label className="classroom__toggle">
                    <input className="ui-checkbox" type="checkbox" checked={feed.save_notes} disabled={Boolean(working)} onChange={() => toggleNotes(feed)} />
                    <span>Save assignment instructions as notes</span>
                  </label>
                  {rowError[feed.id] ? <div className="ui-alert" role="alert"><span>{rowError[feed.id]}</span></div> : null}
                  <div className="classroom__feed-actions">
                    <button type="button" className={`ui-button ui-button--primary ui-button--sm${working === 'sync' ? ' is-busy' : ''}`} disabled={Boolean(working)} onClick={() => void syncNow(feed)}>
                      {Icon.sync}{working === 'sync' ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button type="button" className="ui-button ui-button--ghost ui-button--sm" disabled={Boolean(working)} onClick={() => setLeaving(feed)}>Disconnect</button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
      {leaving ? <DisconnectDialog feed={leaving} onCancel={() => setLeaving(null)} onChoose={(deleteTasks) => void disconnect(leaving, deleteTasks)} busy={Boolean(rowBusy[leaving.id])} /> : null}
    </div>
  )
}

function DisconnectDialog({ feed, onCancel, onChoose, busy }: { feed: ClassroomFeed; onCancel: () => void; onChoose: (deleteTasks: boolean) => void; busy: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  const cancel = () => { if (!busy) onCancel() }
  useDrawer({ open: true, onClose: cancel, panel })
  const count = feed.imported_count
  return (
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel() }}>
      <div ref={panel} className="ui-dialog classroom__dialog" role="alertdialog" aria-modal="true" aria-labelledby="classroom-leave-title" aria-describedby="classroom-leave-copy">
        <header className="ui-dialog__header">
          <h2 className="ui-dialog__title" id="classroom-leave-title">Disconnect {feed.course}?</h2>
        </header>
        <div className="classroom__dialog-body">
          <p id="classroom-leave-copy">
            bindet stops syncing this class. What should happen to the {count === 1 ? 'task' : `${count} tasks`} it imported?
            Instruction notes stay in Study either way.
          </p>
        </div>
        <footer className="ui-dialog__footer classroom__dialog-footer">
          <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={cancel}>Cancel</button>
          <button type="button" className="ui-button ui-button--danger" disabled={busy} onClick={() => onChoose(true)}>Delete imported tasks</button>
          <button type="button" className="ui-button ui-button--primary" disabled={busy} onClick={() => onChoose(false)}>Keep tasks</button>
        </footer>
      </div>
    </div>
  )
}
