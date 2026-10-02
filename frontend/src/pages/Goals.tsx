import { type FormEvent, startTransition, useEffect, useMemo, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import { createTask, deleteTask, getTasks, updateTask, type StudyTask } from '../lib/api'
import { useData } from '../lib/dataSource'
import './Goals.css'

const columns: { id: StudyTask['status']; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'complete', label: 'Complete' },
]
const nextStatus: Record<StudyTask['status'], StudyTask['status']> = { todo: 'in_progress', in_progress: 'review', review: 'complete', complete: 'todo' }
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

export function Goals({ session }: { session: AuthSession | null }) {
  const token = session?.access_token
  const notebook = useData().loadNotebook()
  const [tasks, setTasks] = useState<StudyTask[]>([])
  const [loading, setLoading] = useState(Boolean(token))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [composerOpen, setComposerOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [course, setCourse] = useState(notebook.activeCourse || notebook.courses[0]?.name || '')
  const [due, setDue] = useState('')

  useEffect(() => {
    if (!token) return
    let active = true
    void getTasks(token).then((items) => { if (active) startTransition(() => setTasks(items)) }).catch(() => { if (active) setError('Could not load your assignments.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token])

  const counts = useMemo(() => Object.fromEntries(columns.map((column) => [column.id, tasks.filter((task) => task.status === column.id).length])), [tasks])
  const finished = counts.complete ?? 0
  const percent = tasks.length ? Math.round(finished / tasks.length * 100) : 0

  async function addTask(event: FormEvent) {
    event.preventDefault()
    if (!token || !title.trim() || saving) return
    setSaving(true); setError('')
    try {
      const task = await createTask({ title: title.trim(), description: '', course, unit: '', status: 'todo', priority: 'medium', due_at: due ? new Date(`${due}T23:59:00`).toISOString() : null }, token)
      setTasks((current) => [task, ...current]); setTitle(''); setDue(''); setComposerOpen(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create that assignment.') }
    finally { setSaving(false) }
  }

  async function moveTask(task: StudyTask) {
    if (!token) return
    const status = nextStatus[task.status]
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status } : item))
    try {
      const saved = await updateTask(task.id, { status }, token)
      setTasks((current) => current.map((item) => item.id === saved.id ? saved : item))
    } catch { setTasks((current) => current.map((item) => item.id === task.id ? task : item)); setError('Could not update that assignment.') }
  }

  async function removeTask(task: StudyTask) {
    if (!token) return
    setTasks((current) => current.filter((item) => item.id !== task.id))
    try { await deleteTask(task.id, token) }
    catch { setTasks((current) => [task, ...current]); setError('Could not delete that assignment.') }
  }

  return (
    <div className="tasks-page">
      <header className="tasks-page__header">
        <div><span className="tasks-page__eyebrow">My tasks</span><h1>What needs your attention?</h1><p>Assignments are saved to your account and stay in sync across devices.</p></div>
        <button className="tasks-page__new" type="button" onClick={() => setComposerOpen((open) => !open)}>+ New assignment</button>
      </header>

      <section className="tasks-page__summary" aria-label="Task progress">
        <div><strong>{tasks.length - finished}</strong><span>Open assignments</span></div><div><strong>{finished}</strong><span>Completed</span></div>
        <div className="tasks-page__progress"><span><b style={{ width: `${percent}%` }} /></span><small>{percent}% complete</small></div>
      </section>

      {composerOpen ? <form className="task-composer" onSubmit={addTask}>
        <label><span>Assignment</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Finish cellular respiration review" maxLength={120} /></label>
        <label><span>Course</span><select value={course} onChange={(event) => setCourse(event.target.value)}><option value="">No course</option>{notebook.courses.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
        <label><span>Due date</span><input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>
        <button type="submit" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Add task'}</button>
      </form> : null}
      {error ? <p className="tasks-page__error" role="status">{error}</p> : null}

      <section className="task-board" aria-label="Assignment board">
        {columns.map((column) => <div className="task-column" key={column.id}>
          <header><span>{column.label}</span><b>{counts[column.id] ?? 0}</b></header>
          <div className="task-column__body">
            {loading ? <div className="task-card is-loading" /> : tasks.filter((task) => task.status === column.id).map((task) => <article className="task-card" key={task.id}>
              <div className="task-card__meta"><span className={`is-${task.priority}`}>{task.priority}</span>{task.due_at ? <time>{dateFormat.format(new Date(task.due_at))}</time> : null}</div>
              <h2>{task.title}</h2>{task.course ? <p>{task.course}{task.unit ? ` · ${task.unit}` : ''}</p> : <p>Personal assignment</p>}
              <footer><button type="button" onClick={() => void moveTask(task)}>{task.status === 'complete' ? 'Reopen' : 'Move forward'} <span>→</span></button><button type="button" className="task-card__delete" onClick={() => void removeTask(task)} aria-label={`Delete ${task.title}`}>×</button></footer>
            </article>)}
            {!loading && !tasks.some((task) => task.status === column.id) ? <button className="task-column__empty" type="button" onClick={() => setComposerOpen(true)}>+ Add task</button> : null}
          </div>
        </div>)}
      </section>
    </div>
  )
}
