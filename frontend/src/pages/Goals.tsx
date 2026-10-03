import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent } from 'react'
import type { AuthSession } from '../lib/auth'
import { createTask, deleteTask, getCachedTasks, getTasks, parseServerTime, setCachedTasks, updateTask, type StudyTask } from '../lib/api'
import { useData } from '../lib/dataSource'
import { withCourseTones } from '../lib/session'
import './Goals.css'

/*
 * Assignments: persistent, per-account tasks. Every change is applied to the
 * screen first and sent to the API second; a failed request puts the previous
 * version back and says what happened.
 */

type Status = StudyTask['status']
type Priority = StudyTask['priority']
type View = 'board' | 'list'
type Sort = 'due' | 'priority' | 'recent'

const STATUSES: { id: Status; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'complete', label: 'Complete' },
]
const STATUS_LABEL = Object.fromEntries(STATUSES.map((status) => [status.id, status.label])) as Record<Status, string>
const NEXT: Record<Status, Status> = { todo: 'in_progress', in_progress: 'review', review: 'complete', complete: 'todo' }
const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
const DAY = 86_400_000
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayOffset(task: StudyTask, now: number) {
  if (!task.due_at) return null
  return Math.round((startOfDay(parseServerTime(task.due_at)) - startOfDay(now)) / DAY)
}

function dueLabel(task: StudyTask, now: number) {
  const days = dayOffset(task, now)
  if (days === null) return 'No date'
  const date = new Date(parseServerTime(task.due_at))
  if (task.status !== 'complete' && days < 0) return days === -1 ? 'Yesterday' : shortDate.format(date)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days > 1 && days < 7) return weekday.format(date)
  return shortDate.format(date)
}

/* yyyy-mm-dd for a date input, in the student's own time zone. */
function inputDate(dueAt: string | null) {
  if (!dueAt) return ''
  const date = new Date(parseServerTime(dueAt))
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/* A due date means the end of that day where the student is. */
function dueFromInput(value: string) {
  return value ? new Date(`${value}T23:59:00`).toISOString() : null
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof TypeError) return 'bindit couldn’t be reached, so that change was undone. Check your connection and try again.'
  return error instanceof Error && error.message ? error.message : fallback
}

function readView(): View {
  try { return localStorage.getItem('bindit:assignments:view') === 'list' ? 'list' : 'board' } catch { return 'board' }
}

export function Goals({ session }: { session: AuthSession | null }) {
  const token = session?.access_token
  const data = useData()
  const notebook = useMemo(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  }, [data])
  const [tasks, setTasks] = useState<StudyTask[] | null>(() => token ? getCachedTasks(token) : [])
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null)
  const [view, setViewState] = useState<View>(readView)
  const [mobileStatus, setMobileStatus] = useState<Status>('todo')
  const [query, setQuery] = useState('')
  const [course, setCourse] = useState('all')
  const [priority, setPriority] = useState<Priority | 'all'>('all')
  const [sort, setSort] = useState<Sort>('due')
  const [composerOpen, setComposerOpen] = useState(() => window.location.hash.includes('new'))
  const [editing, setEditing] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<Status | null>(null)
  const [now] = useState(() => Date.now())
  const pendingDeletes = useRef(new Map<string, number>())

  const setView = (next: View) => {
    setViewState(next)
    try { localStorage.setItem('bindit:assignments:view', next) } catch { /* per-device convenience only */ }
  }

  const fetchTasks = useCallback(() => {
    if (!token) return
    void getTasks(token, true).then((items) => { setTasks(items); setLoadError('') }).catch((error) => {
      setLoadError(errorText(error, 'Your assignments could not be loaded.'))
      setTasks((current) => current ?? [])
    })
  }, [token])

  useEffect(() => { fetchTasks() }, [fetchTasks])

  const retry = () => { setLoadError(''); fetchTasks() }

  useEffect(() => {
    if (token && tasks) setCachedTasks(token, tasks.filter((task) => !task.id.startsWith('temp-')))
  }, [token, tasks])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 6000 : 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // N opens the composer, Escape closes panels.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'n' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setComposerOpen(true) }
      if (event.key === 'Escape') { setComposerOpen(false); setEditing(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Deletions wait out their undo window; if the page closes first, finish them now.
  useEffect(() => () => {
    for (const [taskId, timer] of pendingDeletes.current) {
      window.clearTimeout(timer)
      if (token) void deleteTask(taskId, token).catch(() => undefined)
    }
  }, [token])

  const all = useMemo(() => tasks ?? [], [tasks])
  const courseNames = useMemo(() => [...new Set([...notebook.courses.map((item) => item.name), ...all.map((task) => task.course).filter(Boolean)])], [notebook.courses, all])
  const toneFor = (name: string) => notebook.courses.find((item) => item.name === name)?.tone ?? 'var(--color-text-tertiary)'

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = all.filter((task) =>
      (course === 'all' || (course === 'none' ? !task.course : task.course === course))
      && (priority === 'all' || task.priority === priority)
      && (!needle || `${task.title} ${task.description} ${task.course} ${task.unit}`.toLowerCase().includes(needle)))
    const byDue = (a: StudyTask, b: StudyTask) => (a.due_at ? parseServerTime(a.due_at) : Infinity) - (b.due_at ? parseServerTime(b.due_at) : Infinity)
    return filtered.toSorted((a, b) => {
      if (sort === 'priority') return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byDue(a, b)
      if (sort === 'recent') return parseServerTime(b.created_at) - parseServerTime(a.created_at)
      return byDue(a, b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    })
  }, [all, query, course, priority, sort])

  const open = all.filter((task) => task.status !== 'complete')
  const overdueCount = open.filter((task) => (dayOffset(task, now) ?? 0) < 0).length
  const weekCount = open.filter((task) => { const days = dayOffset(task, now); return days !== null && days >= 0 && days < 7 }).length
  const filtersActive = Boolean(query.trim()) || course !== 'all' || priority !== 'all'

  const replace = (taskId: string, next: StudyTask | null) => setTasks((current) => (current ?? []).flatMap((task) => task.id === taskId ? (next ? [next] : []) : [task]))

  async function change(task: StudyTask, changes: Partial<Pick<StudyTask, 'title' | 'description' | 'course' | 'unit' | 'status' | 'priority' | 'due_at'>>) {
    if (!token || task.id.startsWith('temp-')) return
    replace(task.id, { ...task, ...changes })
    try {
      replace(task.id, await updateTask(task.id, changes, token))
      if (changes.status === 'complete') setNotice({ text: `Completed “${task.title}”.`, undo: () => void change({ ...task, ...changes }, { status: task.status }) })
    } catch (error) {
      replace(task.id, task)
      setNotice({ text: errorText(error, 'That change could not be saved.') })
    }
  }

  async function add(input: { title: string; course: string; unit: string; priority: Priority; due_at: string | null; status?: Status }) {
    if (!token) return
    const now = new Date().toISOString()
    const tempId = `temp-${Date.now()}`
    const draft: StudyTask = { id: tempId, owner_id: '', description: '', status: input.status ?? 'todo', created_at: now, updated_at: now, ...input }
    setTasks((current) => [draft, ...(current ?? [])])
    try {
      const saved = await createTask({ description: '', status: draft.status, ...input }, token)
      replace(tempId, saved)
    } catch (error) {
      replace(tempId, null)
      setNotice({ text: errorText(error, 'That assignment could not be added.') })
    }
  }

  function remove(task: StudyTask) {
    if (!token) return
    replace(task.id, null)
    setEditing(null)
    const timer = window.setTimeout(() => {
      pendingDeletes.current.delete(task.id)
      void deleteTask(task.id, token).catch((error) => {
        setTasks((current) => [task, ...(current ?? [])])
        setNotice({ text: errorText(error, 'That assignment could not be deleted.') })
      })
    }, 5500)
    pendingDeletes.current.set(task.id, timer)
    setNotice({
      text: `Deleted “${task.title}”.`,
      undo: () => {
        window.clearTimeout(timer)
        pendingDeletes.current.delete(task.id)
        setTasks((current) => [task, ...(current ?? [])])
      },
    })
  }

  function onDrop(event: DragEvent, status: Status) {
    event.preventDefault()
    const task = all.find((item) => item.id === event.dataTransfer.getData('text/plain'))
    setDragging(null)
    setDropTarget(null)
    if (task && task.status !== status) void change(task, { status })
  }

  const editingTask = all.find((task) => task.id === editing) ?? null

  const card = (task: StudyTask) => {
    const days = dayOffset(task, now)
    const late = task.status !== 'complete' && days !== null && days < 0
    const soon = task.status !== 'complete' && days !== null && days >= 0 && days <= 1
    const pending = task.id.startsWith('temp-')
    return (
      <article
        key={task.id}
        className={`assignment-card${late ? ' is-late' : ''}${task.status === 'complete' ? ' is-done' : ''}${pending ? ' is-pending' : ''}${dragging === task.id ? ' is-dragging' : ''}`}
        style={{ '--course': toneFor(task.course) } as CSSProperties}
        draggable={!pending}
        onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; setDragging(task.id) }}
        onDragEnd={() => { setDragging(null); setDropTarget(null) }}
      >
        <button type="button" className="assignment-card__check" aria-pressed={task.status === 'complete'} disabled={pending}
          aria-label={task.status === 'complete' ? `Reopen ${task.title}` : `Mark ${task.title} complete`}
          onClick={() => void change(task, { status: task.status === 'complete' ? 'todo' : 'complete' })}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>
        </button>
        <button type="button" className="assignment-card__body" onClick={() => setEditing(task.id)} disabled={pending}>
          <span className="assignment-card__title">{task.title}</span>
          <span className="assignment-card__context">
            {task.course ? <><i className="assignment-card__dot" aria-hidden="true" />{task.course}{task.unit ? ` · ${task.unit}` : ''}</> : 'Personal'}
          </span>
        </button>
        <footer className="assignment-card__foot">
          <span className={`assignment-due${late ? ' is-late' : soon ? ' is-soon' : ''}`}>
            {late ? <b>Overdue</b> : null}{dueLabel(task, now)}
          </span>
          {task.priority !== 'medium' ? <span className={`assignment-priority is-${task.priority}`}>{task.priority === 'high' ? 'High' : 'Low'}</span> : null}
          {task.status !== 'complete' ? (
            <button type="button" className="assignment-card__advance" disabled={pending} onClick={() => void change(task, { status: NEXT[task.status] })} aria-label={`Move ${task.title} to ${STATUS_LABEL[NEXT[task.status]]}`} title={`Move to ${STATUS_LABEL[NEXT[task.status]]}`}>
              {STATUS_LABEL[NEXT[task.status]]}<span aria-hidden="true">→</span>
            </button>
          ) : null}
        </footer>
      </article>
    )
  }

  const groups = useMemo(() => {
    const buckets: { id: string; label: string; items: StudyTask[] }[] = [
      { id: 'overdue', label: 'Overdue', items: [] },
      { id: 'today', label: 'Today', items: [] },
      { id: 'week', label: 'Next 7 days', items: [] },
      { id: 'later', label: 'Later', items: [] },
      { id: 'none', label: 'No due date', items: [] },
      { id: 'done', label: 'Completed', items: [] },
    ]
    for (const task of visible) {
      const days = dayOffset(task, now)
      const bucket = task.status === 'complete' ? 'done' : days === null ? 'none' : days < 0 ? 'overdue' : days === 0 ? 'today' : days < 7 ? 'week' : 'later'
      buckets.find((item) => item.id === bucket)!.items.push(task)
    }
    return buckets.filter((bucket) => bucket.items.length)
  }, [visible, now])

  return (
    <div className="ui-page assignments">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Assignments</span>
          <h1 className="ui-page-title">What’s due</h1>
          <p className="ui-page-subtitle">
            {tasks === null ? 'Loading your assignments…' : open.length
              ? <>{open.length} open{overdueCount ? <> · <span className="assignments__late">{overdueCount} overdue</span></> : null}{weekCount ? ` · ${weekCount} due this week` : ''}</>
              : 'Nothing open. Saved to your account and synced across devices.'}
          </p>
        </div>
        <button className="ui-button ui-button--primary" type="button" onClick={() => setComposerOpen((value) => !value)} aria-expanded={composerOpen} aria-controls="assignment-composer">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New assignment<kbd className="assignments__kbd">N</kbd>
        </button>
      </header>

      {composerOpen ? <Composer courses={notebook.courses} onCancel={() => setComposerOpen(false)} onAdd={(input) => { void add(input) }} /> : null}

      <div className="assignments__toolbar" role="search">
        <label className="assignments__search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
          <span className="sr-only">Search assignments</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assignments" />
        </label>
        <select className="ui-select" aria-label="Filter by course" value={course} onChange={(event) => setCourse(event.target.value)}>
          <option value="all">All courses</option>
          {courseNames.map((name) => <option key={name} value={name}>{name}</option>)}
          <option value="none">No course</option>
        </select>
        <select className="ui-select" aria-label="Filter by priority" value={priority} onChange={(event) => setPriority(event.target.value as Priority | 'all')}>
          <option value="all">Any priority</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select className="ui-select" aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="due">Sort by due date</option>
          <option value="priority">Sort by priority</option>
          <option value="recent">Newest first</option>
        </select>
        {filtersActive ? <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => { setQuery(''); setCourse('all'); setPriority('all') }}>Clear</button> : null}
        <div className="ui-segmented assignments__view" role="group" aria-label="Layout">
          <button type="button" className="ui-segmented__item" aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
          <button type="button" className="ui-segmented__item" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </div>
      </div>

      {loadError ? <div className="ui-alert" role="alert"><span>{loadError}</span><button type="button" className="ui-button ui-button--sm" onClick={retry}>Try again</button></div> : null}

      {tasks === null ? (
        <div className="assignments__board" aria-busy="true" aria-label="Loading assignments">
          {STATUSES.map((status) => <div key={status.id} className="assignments__column"><header><h2>{status.label}</h2></header><span className="ui-skeleton assignments__skeleton" /><span className="ui-skeleton assignments__skeleton" /></div>)}
        </div>
      ) : !all.length ? (
        <div className="ui-empty assignments__empty">
          <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
          <h2 className="ui-empty__title">A clear desk</h2>
          <p className="ui-empty__copy">Add assignments as they are handed out. Give each a course and a due date and bindit keeps them in order.</p>
          <button type="button" className="ui-button ui-button--primary" onClick={() => setComposerOpen(true)}>Add your first assignment</button>
        </div>
      ) : !visible.length ? (
        <div className="ui-empty"><h2 className="ui-empty__title">No matches</h2><p className="ui-empty__copy">Nothing fits these filters.</p><button type="button" className="ui-button" onClick={() => { setQuery(''); setCourse('all'); setPriority('all') }}>Clear filters</button></div>
      ) : view === 'board' ? (
        <div className="assignments__fit">
          <div className="ui-segmented assignments__status-picker" role="tablist" aria-label="Status">
            {STATUSES.map((status) => (
              <button key={status.id} type="button" role="tab" className="ui-segmented__item" aria-selected={mobileStatus === status.id} onClick={() => setMobileStatus(status.id)}>
                {status.label}<span className="ui-count">{visible.filter((task) => task.status === status.id).length}</span>
              </button>
            ))}
          </div>
          <div className="assignments__board">
            {STATUSES.map((status) => {
              const items = visible.filter((task) => task.status === status.id)
              return (
                <section
                  key={status.id}
                  aria-label={status.label}
                  className={`assignments__column is-${status.id}${dropTarget === status.id ? ' is-target' : ''}${mobileStatus === status.id ? ' is-mobile-active' : ''}`}
                  onDragOver={(event) => { if (dragging) { event.preventDefault(); setDropTarget(status.id) } }}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget((current) => current === status.id ? null : current) }}
                  onDrop={(event) => onDrop(event, status.id)}
                >
                  <header><h2>{status.label}</h2><span className="ui-count">{items.length}</span></header>
                  <div className="assignments__stack">
                    {items.map(card)}
                    {!items.length ? <p className="assignments__column-empty">{dragging ? 'Drop here' : status.id === 'complete' ? 'Finished work lands here.' : 'Nothing here.'}</p> : null}
                  </div>
                </section>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="assignments__list assignments__fit">
          {groups.map((group) => (
            <section key={group.id} className={`assignments__group is-${group.id}`} aria-labelledby={`group-${group.id}`}>
              <h2 id={`group-${group.id}`}>{group.label}<span className="ui-count">{group.items.length}</span></h2>
              <div className="assignments__rows">{group.items.map((task) => (
                <div key={task.id} className="assignments__row-wrap">
                  {card(task)}
                  <span className={`assignments__status is-${task.status}`}>{STATUS_LABEL[task.status]}</span>
                </div>
              ))}</div>
            </section>
          ))}
        </div>
      )}

      {editingTask ? <Editor key={editingTask.id} task={editingTask} courses={notebook.courses} onClose={() => setEditing(null)} onSave={(changes) => void change(editingTask, changes)} onDelete={() => remove(editingTask)} /> : null}

      {notice ? (
        <div className="app-toast" role="status">
          {notice.text}
          {notice.undo ? <button type="button" className="assignments__undo" onClick={() => { notice.undo?.(); setNotice(null) }}>Undo</button> : null}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
    </div>
  )
}

type CourseOption = { name: string; units: string[] }

function CourseFields({ courses, course, unit, onCourse, onUnit, idPrefix }: { courses: CourseOption[]; course: string; unit: string; onCourse: (value: string) => void; onUnit: (value: string) => void; idPrefix: string }) {
  const units = courses.find((item) => item.name === course)?.units ?? []
  return (
    <>
      <label className="ui-field"><span>Course</span>
        <select id={`${idPrefix}-course`} className="ui-select" value={course} onChange={(event) => { onCourse(event.target.value); onUnit('') }}>
          <option value="">No course</option>
          {courses.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          {course && !courses.some((item) => item.name === course) ? <option value={course}>{course}</option> : null}
        </select>
      </label>
      <label className="ui-field"><span>Unit</span>
        <select className="ui-select" value={unit} disabled={!course} onChange={(event) => onUnit(event.target.value)}>
          <option value="">{course ? 'Whole course' : '—'}</option>
          {units.map((item) => <option key={item} value={item}>{item}</option>)}
          {unit && !units.includes(unit) ? <option value={unit}>{unit}</option> : null}
        </select>
      </label>
    </>
  )
}

function Composer({ courses, onAdd, onCancel }: { courses: CourseOption[]; onAdd: (input: { title: string; course: string; unit: string; priority: Priority; due_at: string | null }) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [course, setCourse] = useState('')
  const [unit, setUnit] = useState('')
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [added, setAdded] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    onAdd({ title: title.trim(), course, unit, priority, due_at: dueFromInput(due) })
    setTitle('')
    setAdded((count) => count + 1)
    titleRef.current?.focus()
  }

  return (
    <form className="assignments__composer" id="assignment-composer" onSubmit={submit} aria-label="New assignment">
      <label className="ui-field assignments__composer-title"><span>Assignment</span>
        <input ref={titleRef} className="ui-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Lab report: enzyme activity" maxLength={120} required />
      </label>
      <CourseFields courses={courses} course={course} unit={unit} onCourse={setCourse} onUnit={setUnit} idPrefix="new" />
      <label className="ui-field"><span>Due</span><input className="ui-input" type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
      <label className="ui-field"><span>Priority</span>
        <select className="ui-select" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
          <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
      </label>
      <div className="assignments__composer-actions">
        {added ? <span className="assignments__added" role="status">Added {added}. Keep going or close.</span> : <span className="ui-muted">Press Enter to add. Course and date stay for the next one.</span>}
        <button type="button" className="ui-button ui-button--ghost" onClick={onCancel}>Close</button>
        <button type="submit" className="ui-button ui-button--primary" disabled={!title.trim()}>Add assignment</button>
      </div>
    </form>
  )
}

function Editor({ task, courses, onSave, onDelete, onClose }: { task: StudyTask; courses: CourseOption[]; onSave: (changes: Partial<StudyTask>) => void; onDelete: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [course, setCourse] = useState(task.course)
  const [unit, setUnit] = useState(task.unit)
  const [due, setDue] = useState(inputDate(task.due_at))
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => { panel.current?.querySelector<HTMLInputElement>('input')?.focus() }, [])

  const save = (event?: FormEvent) => {
    event?.preventDefault()
    const changes: Partial<StudyTask> = {}
    if (title.trim() && title.trim() !== task.title) changes.title = title.trim()
    if (description !== task.description) changes.description = description
    if (course !== task.course) changes.course = course
    if (unit !== task.unit) changes.unit = unit
    if (due !== inputDate(task.due_at)) changes.due_at = dueFromInput(due)
    if (Object.keys(changes).length) onSave(changes)
    onClose()
  }

  return (
    <div className="assignments__drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) save() }}>
      <div className="assignments__drawer" role="dialog" aria-modal="true" aria-labelledby="assignment-editor-title" ref={panel}>
        <form onSubmit={save}>
          <header>
            <span className="ui-eyebrow" id="assignment-editor-title">Edit assignment</span>
            <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={onClose} aria-label="Close without saving">Esc</button>
          </header>
          <input className="assignments__drawer-title" value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" maxLength={120} required />
          <div className="assignments__drawer-status" role="group" aria-label="Status">
            {STATUSES.map((status) => (
              <button key={status.id} type="button" className={`ui-segmented__item is-${status.id}`} aria-pressed={task.status === status.id} onClick={() => onSave({ status: status.id })}>{status.label}</button>
            ))}
          </div>
          <div className="assignments__drawer-grid">
            <CourseFields courses={courses} course={course} unit={unit} onCourse={setCourse} onUnit={setUnit} idPrefix="edit" />
            <label className="ui-field"><span>Due</span><input className="ui-input" type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
            <label className="ui-field"><span>Priority</span>
              <select className="ui-select" value={task.priority} onChange={(event) => onSave({ priority: event.target.value as Priority })}>
                <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
              </select>
            </label>
          </div>
          <label className="ui-field"><span>Notes</span>
            <textarea className="ui-textarea" rows={6} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="Requirements, rubric points, links…" />
          </label>
          <footer>
            <button type="button" className="ui-button ui-button--danger" onClick={onDelete}>Delete</button>
            <span />
            <button type="button" className="ui-button ui-button--ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="ui-button ui-button--primary">Save</button>
          </footer>
        </form>
      </div>
    </div>
  )
}
