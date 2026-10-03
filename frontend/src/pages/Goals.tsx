import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type HTMLAttributes, type ReactNode } from 'react'
import {
  addTaskChecklistItem, addTaskComment, addTaskLink, createTask, deleteTask, deleteTaskAttachment, deleteTaskChecklistItem,
  getCachedFriends, getCachedStudyGroups, getCachedTasks, getFriends, getStudyGroups, getTask, getTasks, parseServerTime,
  setCachedTasks, updateTask, updateTaskChecklistItem,
  type SocialNotification, type StudyGroup, type Task, type TaskDetail, type TaskInput, type TaskPriority, type TaskStatus,
} from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { loadNotebook, withCourseTones } from '../lib/session'
import { toneForName } from '../lib/tones'
import './Goals.css'

/*
 * Tasks: personal to-dos, tasks study groups assign to the student, and a calendar.
 * Everything is server data. The server checks ownership and group permissions
 * (can_edit / can_delete on each task) and the UI follows those flags. Cached lists
 * render first and refresh in the background; edits apply optimistically and roll
 * back with a message on failure. Deletes wait a few seconds so they can be undone.
 * This page is not part of the landing demo, so it talks to the API directly.
 */

type Tab = 'mine' | 'group' | 'calendar'
type View = 'list' | 'board'
type Draft = { due_date?: string; status?: TaskStatus; group_id?: string | null }
type Toast = { text: string; undo?: () => void; error?: boolean }
type Counts = Partial<Pick<Task, 'checklist_total' | 'checklist_done' | 'comment_count' | 'attachment_count'>>

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'mine', label: 'My Tasks', icon: 'check' },
  { id: 'group', label: 'Group Tasks', icon: 'people' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
]
const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
]
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent']
const PRIORITY_LABEL: Record<TaskPriority, string> = { low: 'Low priority', medium: 'Medium priority', high: 'High priority', urgent: 'Urgent' }
const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
const UNDO_MS = 5000
const DRAWER_QUERY = '(max-width: 1180px)'

const monthDay = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const weekdayDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/* ---------- dates ---------- */

function isoDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseDay(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function addDays(value: string, days: number) {
  const date = parseDay(value)
  date.setDate(date.getDate() + days)
  return isoDay(date)
}

function timeLabel(value: string | null) {
  if (!value) return ''
  const [hours, minutes] = value.split(':').map(Number)
  const date = new Date()
  date.setHours(hours || 0, minutes || 0, 0, 0)
  return clock.format(date).toLowerCase()
}

/* Short label for rows: Today, Tomorrow, Friday, Sep 22. */
function dueLabel(task: Task, today: string) {
  if (!task.due_date) return ''
  const time = task.due_time ? ` · ${timeLabel(task.due_time)}` : ''
  if (task.due_date === today) return `Today${time}`
  if (task.due_date === addDays(today, 1)) return `Tomorrow${time}`
  if (task.due_date < today) return `${task.status === 'done' ? '' : 'Overdue · '}${shortDate.format(parseDay(task.due_date))}`
  if (task.due_date <= addDays(today, 6)) return `${weekdayLong.format(parseDay(task.due_date))}${time}`
  return shortDate.format(parseDay(task.due_date))
}

/* Longer label for the details panel: "Monday · 4:30 pm". */
function whenLabel(task: Task, today: string) {
  if (!task.due_date) return 'No date'
  const day = parseDay(task.due_date)
  const nearby = task.due_date >= today && task.due_date <= addDays(today, 6)
  const date = task.due_date === today ? 'Today' : task.due_date === addDays(today, 1) ? 'Tomorrow' : nearby ? weekdayLong.format(day) : weekdayDate.format(day)
  return task.due_time ? `${date} · ${timeLabel(task.due_time)}` : date
}

function isOverdue(task: Task, today: string) {
  return task.status !== 'done' && !!task.due_date && task.due_date < today
}

function sortTasks(list: Task[]) {
  return list.toSorted((a, b) =>
    (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
    || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')
    || (a.due_time ?? '99').localeCompare(b.due_time ?? '99')
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || b.created_at.localeCompare(a.created_at))
}

/* ---------- small helpers ---------- */

function errorText(error: unknown) {
  // fetch rejects with a TypeError when the network or server can't be reached.
  if (error instanceof TypeError) return 'bindit couldn’t be reached, so that change was undone. Check your connection and try again.'
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.'
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch { return fallback }
}

function writePref(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Preferences are a convenience only. */ }
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
}

function activityText(item: { kind: string; detail: string }) {
  return item.kind === 'created' ? 'created the task' : item.detail || item.kind.replace(/_/g, ' ')
}

function latestTaskNotice(list: SocialNotification[] | undefined) {
  return (list ?? [])
    .filter((item) => item.kind.startsWith('task_') || item.kind === 'group_notice')
    .toSorted((a, b) => parseServerTime(b.created_at) - parseServerTime(a.created_at))[0] ?? null
}

type IconName = 'check' | 'people' | 'calendar' | 'plus' | 'compose' | 'list' | 'board' | 'settings' | 'close' | 'clock' | 'pin' | 'bell' | 'trash' | 'chevron-left' | 'chevron-right' | 'link'
const ICONS: Record<IconName, ReactNode> = {
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><path d="M16 5.3a3 3 0 0 1 0 5.4M18 14.4c1.6.7 2.7 2.3 3 4.6" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  compose: <><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /><path d="m17.5 3.5 3 3L12 15l-4 1 1-4z" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  board: <><rect x="3.5" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="16.5" y="4" width="4" height="7" rx="1.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  trash: <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />,
  'chevron-left': <path d="m14.5 6-6 6 6 6" />,
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
}

function Icon({ name }: { name: IconName }) {
  return <svg className="tasks-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[name]}</svg>
}

function Avatar({ name }: { name: string }) {
  return <span className={`ui-avatar tasks-avatar ui-tone--${toneForName(name)}`} title={name} aria-hidden="true">{initials(name)}</span>
}

/* ---------- page ---------- */

export function Goals({ session }: { session: AuthSession | null }) {
  const token = session?.access_token ?? ''
  const me = session?.user.id ?? ''
  const [tasks, setTasks] = useState<Task[]>(() => token ? getCachedTasks(token) ?? [] : [])
  const [groups, setGroups] = useState<StudyGroup[]>(() => token ? getCachedStudyGroups(token) ?? [] : [])
  const [loaded, setLoaded] = useState(() => !!(token && getCachedTasks(token)))
  const [loadError, setLoadError] = useState('')
  const [tab, setTabState] = useState<Tab>(() => readPref('bindit:tasks:tab', ['mine', 'group', 'calendar'] as const, 'mine'))
  const [view, setViewState] = useState<View>(() => readPref('bindit:tasks:view', ['list', 'board'] as const, 'list'))
  const [showDone, setShowDoneState] = useState(() => readPref('bindit:tasks:show-done', ['yes', 'no'] as const, 'no') === 'yes')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [details, setDetails] = useState<Record<string, TaskDetail>>({})
  const [toast, setToast] = useState<Toast | null>(null)
  const [notice, setNotice] = useState<SocialNotification | null>(() => token ? latestTaskNotice(getCachedFriends(token)?.notifications) : null)
  const [dismissedNotice, setDismissedNotice] = useState(() => { try { return localStorage.getItem('bindit:tasks:dismissed-notice') ?? '' } catch { return '' } })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [today] = useState(() => isoDay(new Date()))
  const [reload, setReload] = useState(0)
  const pendingDetails = useRef(new Set<string>())
  const pendingDeletes = useRef(new Map<string, { timer: number; task: Task }>())
  const panelRef = useRef<HTMLElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const courses = useMemo(() => withCourseTones(loadNotebook().courses), [])

  const setTab = (next: Tab) => { setTabState(next); writePref('bindit:tasks:tab', next) }
  const setView = (next: View) => { setViewState(next); writePref('bindit:tasks:view', next) }
  const setShowDone = (next: boolean) => { setShowDoneState(next); writePref('bindit:tasks:show-done', next ? 'yes' : 'no') }

  /* Background refresh: tasks, groups, and the latest task notification. */
  useEffect(() => {
    if (!token) return
    let cancelled = false
    void Promise.allSettled([getTasks(token, true), getStudyGroups(token), getFriends(token)]).then(([nextTasks, nextGroups, social]) => {
      if (cancelled) return
      if (nextTasks.status === 'fulfilled') {
        setTasks(nextTasks.value.filter((task) => !pendingDeletes.current.has(task.id)))
        setLoadError('')
      } else setLoadError(errorText(nextTasks.reason))
      if (nextGroups.status === 'fulfilled') setGroups(nextGroups.value)
      if (social.status === 'fulfilled') setNotice(latestTaskNotice(social.value.notifications))
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [token, reload])

  useEffect(() => {
    if (token && loaded) setCachedTasks(token, tasks.filter((task) => !task.id.startsWith('temp-')))
  }, [token, loaded, tasks])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.undo ? UNDO_MS : 6000)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* Leaving the page commits any delete still waiting for Undo. */
  useEffect(() => {
    const pending = pendingDeletes.current
    return () => {
      for (const [id, entry] of pending) {
        window.clearTimeout(entry.timer)
        if (token) void deleteTask(id, token).catch(() => undefined)
      }
      pending.clear()
    }
  }, [token])

  /* The settings menu closes on an outside click. */
  useEffect(() => {
    if (!settingsOpen) return
    const onPointer = (event: PointerEvent) => { if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false) }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [settingsOpen])

  const closePanel = useCallback(() => { setSelectedId(null); setDraft(null) }, [])

  useEffect(() => {
    if (!selectedId && !draft) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closePanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, draft, closePanel])

  /* In drawer mode, move focus into the drawer when it opens. */
  const panelKey = draft ? 'draft' : selectedId
  useEffect(() => {
    if (!panelKey || draft) return
    if (window.matchMedia(DRAWER_QUERY).matches) panelRef.current?.focus()
  }, [panelKey, draft])

  const loadDetail = useCallback((taskId: string) => {
    if (!token || taskId.startsWith('temp-') || pendingDetails.current.has(taskId)) return
    pendingDetails.current.add(taskId)
    void getTask(taskId, token)
      .then((detail) => setDetails((current) => ({ ...current, [taskId]: detail })))
      .catch(() => undefined)
      .finally(() => pendingDetails.current.delete(taskId))
  }, [token])

  const select = useCallback((taskId: string) => {
    setDraft(null)
    setSelectedId(taskId)
    loadDetail(taskId)
  }, [loadDetail])

  const compose = useCallback((next: Draft) => { setSelectedId(null); setDraft(next) }, [])

  const membersByGroup = useMemo(() => new Map(groups.map((group) => [group.id, group.members])), [groups])

  const replaceTask = useCallback((taskId: string, next: Task | null) => {
    setTasks((current) => next ? current.map((task) => task.id === taskId ? next : task) : current.filter((task) => task.id !== taskId))
    setDetails((current) => {
      if (!current[taskId]) return current
      const copy = { ...current }
      if (next) copy[taskId] = { ...copy[taskId], ...next }
      else delete copy[taskId]
      return copy
    })
  }, [])

  const patchTask = useCallback(async (taskId: string, changes: TaskInput) => {
    const previous = tasks.find((task) => task.id === taskId)
    if (!previous || !token || !previous.can_edit) return
    const members = previous.group_id ? membersByGroup.get(previous.group_id) ?? [] : []
    const optimistic: Task = {
      ...previous,
      ...changes,
      assignees: changes.assignee_ids
        ? changes.assignee_ids.map((id) => ({ student_id: id, display_name: members.find((member) => member.student_id === id)?.display_name ?? previous.owner.display_name }))
        : previous.assignees,
      completed_at: changes.status ? (changes.status === 'done' ? new Date().toISOString() : null) : previous.completed_at,
    } as Task
    replaceTask(taskId, optimistic)
    try {
      replaceTask(taskId, await updateTask(taskId, changes, token))
      if (details[taskId]) {
        pendingDetails.current.delete(taskId)
        loadDetail(taskId)
      }
    } catch (error) {
      replaceTask(taskId, previous)
      setToast({ text: errorText(error), error: true })
    }
  }, [tasks, token, membersByGroup, replaceTask, details, loadDetail])

  const toggleDone = useCallback((task: Task) => {
    void patchTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' })
  }, [patchTask])

  const removeTask = useCallback((task: Task) => {
    if (!token || !task.can_delete) return
    replaceTask(task.id, null)
    setSelectedId(null)
    const timer = window.setTimeout(() => {
      pendingDeletes.current.delete(task.id)
      void deleteTask(task.id, token).catch((error: unknown) => {
        setTasks((current) => [task, ...current])
        setToast({ text: `“${task.title}” couldn’t be deleted. ${errorText(error)}`, error: true })
      })
    }, UNDO_MS)
    pendingDeletes.current.set(task.id, { timer, task })
    setToast({
      text: `Deleted “${task.title}”.`,
      undo: () => {
        const entry = pendingDeletes.current.get(task.id)
        if (!entry) return
        window.clearTimeout(entry.timer)
        pendingDeletes.current.delete(task.id)
        setTasks((current) => [task, ...current])
      },
    })
  }, [token, replaceTask])

  const create = useCallback(async (input: TaskInput & { title: string }) => {
    if (!token) return
    const tempId = `temp-${Date.now()}`
    const group = groups.find((item) => item.id === input.group_id)
    const assigneeIds = input.assignee_ids ?? [me]
    const now = new Date().toISOString()
    const placeholder: Task = {
      id: tempId, title: input.title, description: input.description ?? '', course: input.course ?? '', project: input.project ?? '',
      status: input.status ?? 'todo', priority: input.priority ?? 'medium', due_date: input.due_date ?? null, due_time: input.due_time ?? null,
      kind: input.kind ?? 'task', location: input.location ?? '',
      milestone_id: input.milestone_id ?? null, sort_order: 0, group_id: input.group_id ?? null, group_name: group?.name ?? null,
      owner: { student_id: me, display_name: 'You' },
      assignees: assigneeIds.map((id) => ({ student_id: id, display_name: group?.members.find((member) => member.student_id === id)?.display_name ?? 'You' })),
      checklist_total: 0, checklist_done: 0, comment_count: 0, attachment_count: 0, created_at: now, updated_at: now,
      completed_at: null, can_edit: false, can_delete: false,
    }
    setTasks((current) => [placeholder, ...current])
    setDraft(null)
    try {
      const saved = await createTask(input, token)
      setTasks((current) => current.map((task) => task.id === tempId ? saved : task))
    } catch (error) {
      setTasks((current) => current.filter((task) => task.id !== tempId))
      setToast({ text: `“${input.title}” wasn’t saved. ${errorText(error)}`, error: true })
    }
  }, [token, groups, me])

  const updateDetail = useCallback((taskId: string, change: (detail: TaskDetail) => TaskDetail) => {
    setDetails((current) => current[taskId] ? { ...current, [taskId]: change(current[taskId]) } : current)
  }, [])

  const bumpCounts = useCallback((taskId: string, change: Counts) => {
    setTasks((current) => current.map((task) => {
      if (task.id !== taskId) return task
      const next = { ...task }
      for (const [key, delta] of Object.entries(change) as [keyof Counts, number][]) next[key] = Math.max(0, task[key] + delta)
      return next
    }))
  }, [])

  const dismissNotice = () => {
    if (!notice) return
    const id = String(notice.id)
    setDismissedNotice(id)
    try { localStorage.setItem('bindit:tasks:dismissed-notice', id) } catch { /* convenience only */ }
  }

  const courseTone = useCallback((name: string) => courses.find((item) => item.name === name)?.tone, [courses])
  const mine = useMemo(() => tasks.filter((task) => !task.group_id || task.assignees.some((person) => person.student_id === me) || task.owner.student_id === me), [tasks, me])
  const groupTasks = useMemo(() => tasks.filter((task) => task.group_id), [tasks])
  const selected = tasks.find((task) => task.id === selectedId) ?? null
  const visibleNotice = notice && String(notice.id) !== dismissedNotice ? notice : null
  const todayDate = parseDay(today)
  const openCount = mine.filter((task) => task.status !== 'done').length
  const scoped = tab === 'group' ? groupTasks : mine
  const visible = showDone || tab === 'calendar' ? scoped : scoped.filter((task) => task.status !== 'done')
  const hiddenDone = scoped.length - visible.length
  const defaultGroup = tab === 'group' ? groups[0]?.id ?? null : null

  const panel = draft
    ? <TaskComposer draft={draft} groups={groups} courses={courses.map((item) => item.name)} me={me} onCancel={closePanel} onCreate={(input) => void create(input)} />
    : selected
      ? <TaskPanel
          key={selected.id}
          task={selected}
          detail={details[selected.id]}
          groups={groups}
          today={today}
          token={token}
          onClose={closePanel}
          onPatch={(changes) => void patchTask(selected.id, changes)}
          onToggle={() => toggleDone(selected)}
          onDelete={() => removeTask(selected)}
          onDetail={(change) => updateDetail(selected.id, change)}
          onCounts={(change) => bumpCounts(selected.id, change)}
          onError={(text) => setToast({ text, error: true })}
        />
      : null

  const rowProps: RowProps = { today, selectedId, onSelect: select, onPrefetch: loadDetail, onToggle: toggleDone, courseTone }

  return (
    <div className={`ui-page tasks-page${panel ? ' has-panel' : ''}`}>
      <header className="tasks-head">
        <div className="tasks-head__title">
          <span className="ui-eyebrow">Tasks</span>
          <h1 className="ui-page-title tasks-date">
            <span className="tasks-date__tile" aria-hidden="true">{todayDate.getDate()}</span>
            <span className="sr-only">Tasks for </span>{monthDay.format(todayDate)}
          </h1>
          <p className="tasks-head__summary">{openCount ? `${openCount} open ${openCount === 1 ? 'task' : 'tasks'}` : loaded ? 'Nothing open right now.' : ' '}</p>
        </div>
        <div className="tasks-head__aside">
          {visibleNotice ? (
            <div className="tasks-notice" role="status">
              <Icon name="bell" />
              <p>{visibleNotice.message}<time dateTime={visibleNotice.created_at}>{stamp.format(new Date(parseServerTime(visibleNotice.created_at)))}</time></p>
              <button type="button" className="tasks-icon-button" onClick={dismissNotice} aria-label="Dismiss notification"><Icon name="close" /></button>
            </div>
          ) : null}
          <div className="tasks-tools">
            {tab !== 'calendar' ? (
              <div className="ui-segmented" role="group" aria-label="Layout">
                <button type="button" className="ui-segmented__item tasks-tool" aria-pressed={view === 'list'} onClick={() => setView('list')} aria-label="List view" title="List view"><Icon name="list" /></button>
                <button type="button" className="ui-segmented__item tasks-tool" aria-pressed={view === 'board'} onClick={() => setView('board')} aria-label="Board view" title="Board view"><Icon name="board" /></button>
              </div>
            ) : null}
            <div className="tasks-settings" ref={settingsRef}>
              <button type="button" className="tasks-icon-button" aria-label="Task settings" title="Task settings" aria-expanded={settingsOpen} aria-controls="tasks-settings-menu" onClick={() => setSettingsOpen((open) => !open)}><Icon name="settings" /></button>
              {settingsOpen ? (
                <div id="tasks-settings-menu" className="ui-menu tasks-settings__menu" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSettingsOpen(false) } }}>
                  <label className="tasks-settings__option">
                    <input type="checkbox" className="ui-checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} autoFocus />
                    Show completed tasks
                  </label>
                  <button type="button" className="ui-menu__item" onClick={() => { setSettingsOpen(false); setReload((count) => count + 1) }}>Refresh tasks</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div className="tasks-tabbar">
        <div className="ui-tabs tasks-tabs" role="tablist" aria-label="Task views">
          {TABS.map((item) => (
            <button key={item.id} id={`tasks-tab-${item.id}`} type="button" role="tab" className="ui-tab" aria-selected={tab === item.id} aria-controls="tasks-tabpanel" onClick={() => setTab(item.id)}>
              <Icon name={item.icon} />{item.label}
            </button>
          ))}
        </div>
        <button type="button" className="ui-button ui-button--sm tasks-new" onClick={() => compose({ group_id: defaultGroup })} aria-label="New task" title="New task">
          <Icon name="plus" />
        </button>
      </div>

      {loadError ? (
        <div className="ui-alert tasks-alert" role="alert"><span>{tasks.length ? 'Showing saved tasks. ' : ''}{loadError}</span><button type="button" className="ui-button ui-button--sm" onClick={() => setReload((count) => count + 1)}>Try again</button></div>
      ) : null}

      <div className="tasks-body">
        <section className="tasks-main" id="tasks-tabpanel" role="tabpanel" aria-labelledby={`tasks-tab-${tab}`}>
          <div className="tasks-fit">
            {!loaded && !tasks.length ? <TasksSkeleton /> : (
              tab === 'calendar' ? <CalendarView tasks={visible} today={today} selectedId={selectedId} onSelect={select} onPrefetch={loadDetail} onCompose={(date) => compose({ due_date: date })} />
                : view === 'board' ? <BoardView tasks={visible} row={rowProps} onMove={(id, status) => void patchTask(id, { status })} onCompose={(status) => compose({ status, group_id: defaultGroup })} />
                  : tab === 'mine' ? <MyColumns tasks={visible} me={me} row={rowProps} onQuickAdd={(title) => void create({ title })} onCompose={() => compose({ group_id: null })} />
                    : <GroupList tasks={visible} groups={groups} row={rowProps} onCompose={(groupId) => compose({ group_id: groupId })} />
            )}
            {hiddenDone ? (
              <p className="tasks-hidden-done">{hiddenDone} completed {hiddenDone === 1 ? 'task' : 'tasks'} hidden · <button type="button" className="ui-link" onClick={() => setShowDone(true)}>Show</button></p>
            ) : null}
          </div>
        </section>
        {panel ? (
          <>
            <div className="tasks-scrim" aria-hidden="true" onClick={closePanel} />
            <aside ref={panelRef} className="tasks-panel" aria-label={draft ? 'New task' : 'Task details'} tabIndex={-1}>{panel}</aside>
          </>
        ) : null}
      </div>

      {toast ? (
        <div className="app-toast" role={toast.error ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          {toast.undo ? <button type="button" className="tasks-toast__undo" onClick={() => { toast.undo?.(); setToast(null) }}>Undo</button> : null}
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
    </div>
  )
}

function TasksSkeleton() {
  return (
    <div className="tasks-columns" aria-busy="true" aria-label="Loading tasks">
      {[0, 1].map((column) => (
        <div key={column} className="tasks-column">
          <span className="ui-skeleton tasks-skeleton__head" />
          <span className="ui-skeleton tasks-skeleton__card" />
          <span className="ui-skeleton tasks-skeleton__card" />
        </div>
      ))}
    </div>
  )
}

/* ---------- rows ---------- */

type RowProps = {
  today: string; selectedId: string | null
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onToggle: (task: Task) => void
  courseTone: (name: string) => string | undefined
}

function TaskCard({ task, row, showSource = false, dragProps }: { task: Task; row: RowProps; showSource?: boolean; dragProps?: HTMLAttributes<HTMLLIElement> & { draggable?: boolean; dragging?: boolean } }) {
  const { today, selectedId, onSelect, onPrefetch, onToggle, courseTone } = row
  const pending = task.id.startsWith('temp-')
  const done = task.status === 'done'
  const isSelected = task.id === selectedId
  const due = dueLabel(task, today)
  const tone = task.course ? courseTone(task.course) : undefined
  const important = task.priority === 'high' || task.priority === 'urgent'
  const { dragging, ...liProps } = dragProps ?? {}
  return (
    <li {...liProps} className={`task-card${isSelected ? ' is-selected' : ''}${done ? ' is-done' : ''}${pending ? ' is-pending' : ''}${dragging ? ' is-dragging' : ''}`}>
      <button type="button" className="task-check" disabled={!task.can_edit} aria-pressed={done} aria-label={`${done ? 'Reopen' : 'Complete'} ${task.title}`} onClick={() => onToggle(task)}>
        {done ? <Icon name="check" /> : null}
      </button>
      <button type="button" className="task-card__main" disabled={pending} aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(task.id)} onMouseEnter={() => onPrefetch(task.id)} onFocus={() => onPrefetch(task.id)}>
        <span className="task-card__title">{task.title}</span>
        {due || task.course || task.kind === 'event' || important || (showSource && task.group_name) || task.checklist_total ? (
          <span className="task-card__meta">
            {task.kind === 'event' ? <span className="ui-badge ui-badge--accent">Event</span> : null}
            {important ? <span className={`ui-badge ${task.priority === 'urgent' ? 'ui-badge--danger' : 'ui-badge--warning'}`}>{task.priority === 'urgent' ? 'Urgent' : 'High'}</span> : null}
            {due ? <span className={isOverdue(task, today) ? 'task-due is-overdue' : 'task-due'}>{due}</span> : null}
            {task.course ? <span className="task-course" style={tone ? { '--course': tone } as CSSProperties : undefined}>{task.course}</span> : null}
            {showSource && task.group_name ? <span>{task.group_name}</span> : null}
            {task.checklist_total ? <span aria-label={`${task.checklist_done} of ${task.checklist_total} steps done`}>{task.checklist_done}/{task.checklist_total}</span> : null}
          </span>
        ) : null}
      </button>
      {task.group_id && task.assignees.length ? <span className="task-card__people">{task.assignees.slice(0, 3).map((person) => <Avatar key={person.student_id} name={person.display_name} />)}</span> : null}
    </li>
  )
}

function QuickAdd({ onAdd, label }: { onAdd: (title: string) => void; label: string }) {
  const [value, setValue] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!value.trim()) return
    onAdd(value.trim())
    setValue('')
  }
  return (
    <form className="tasks-quick-add" onSubmit={submit}>
      <Icon name="plus" />
      <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={label} aria-label={label} maxLength={140}
        onKeyDown={(event) => { if (event.key === 'Escape' && value) { event.preventDefault(); setValue('') } }} />
    </form>
  )
}

function MyColumns({ tasks, me, row, onQuickAdd, onCompose }: { tasks: Task[]; me: string; row: RowProps; onQuickAdd: (title: string) => void; onCompose: () => void }) {
  const isAssigned = (task: Task) => !!task.group_id && task.assignees.some((person) => person.student_id === me)
  const todo = sortTasks(tasks.filter((task) => !isAssigned(task)))
  const assigned = sortTasks(tasks.filter(isAssigned))
  const openTodo = todo.filter((task) => task.status !== 'done').length
  const openAssigned = assigned.filter((task) => task.status !== 'done').length
  return (
    <div className="tasks-columns">
      <section className="tasks-column" aria-labelledby="tasks-todo-heading">
        <header className="tasks-column__head">
          <h2 id="tasks-todo-heading"><Icon name="check" />To-Do</h2>
          <span className="ui-count" aria-label={`${openTodo} open`}>{openTodo}</span>
          <button type="button" className="tasks-icon-button" onClick={onCompose} aria-label="New task with details" title="New task with details"><Icon name="compose" /></button>
        </header>
        {todo.length ? <ul className="task-cards">{todo.map((task) => <TaskCard key={task.id} task={task} row={row} showSource />)}</ul>
          : <p className="tasks-column__empty">Add an assignment, a reading, or anything else you need to get done.</p>}
        <QuickAdd onAdd={onQuickAdd} label="Add a task" />
      </section>
      <section className="tasks-column" aria-labelledby="tasks-assigned-heading">
        <header className="tasks-column__head">
          <h2 id="tasks-assigned-heading"><Icon name="people" />Assigned</h2>
          <span className="ui-count" aria-label={`${openAssigned} open`}>{openAssigned}</span>
        </header>
        {assigned.length ? <ul className="task-cards">{assigned.map((task) => <TaskCard key={task.id} task={task} row={row} showSource />)}</ul>
          : <p className="tasks-column__empty is-cheer">None! Good work.</p>}
      </section>
    </div>
  )
}

function GroupList({ tasks, groups, row, onCompose }: { tasks: Task[]; groups: StudyGroup[]; row: RowProps; onCompose: (groupId: string) => void }) {
  if (!groups.length) {
    return (
      <div className="ui-empty">
        <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width={104} height={125} />
        <h2 className="ui-empty__title">No study groups yet</h2>
        <p className="ui-empty__copy">Create or join a group to share tasks, assign work, and track progress together.</p>
        <a className="ui-button" href="#profile">Find a group</a>
      </div>
    )
  }
  return (
    <div className="tasks-groups">
      {groups.map((group) => {
        const items = sortTasks(tasks.filter((task) => task.group_id === group.id))
        const open = items.filter((task) => task.status !== 'done').length
        return (
          <section key={group.id} className="tasks-column" aria-labelledby={`tasks-group-${group.id}`}>
            <header className="tasks-column__head">
              <h2 id={`tasks-group-${group.id}`}><span className={`tasks-group-dot ui-tone--${toneForName(group.name)}`} aria-hidden="true" />{group.name}</h2>
              <span className="ui-count" aria-label={`${open} open`}>{open}</span>
              <button type="button" className="tasks-icon-button" onClick={() => onCompose(group.id)} aria-label={`New task for ${group.name}`} title="New group task"><Icon name="compose" /></button>
            </header>
            {items.length ? <ul className="task-cards">{items.map((task) => <TaskCard key={task.id} task={task} row={row} />)}</ul>
              : <p className="tasks-column__empty">No open tasks in this group.</p>}
          </section>
        )
      })}
    </div>
  )
}

/* Drag and drop moves cards between statuses; the Status field in the details panel is the keyboard alternative. */
function BoardView({ tasks, row, onMove, onCompose }: { tasks: Task[]; row: RowProps; onMove: (id: string, status: TaskStatus) => void; onCompose: (status: TaskStatus) => void }) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<TaskStatus | null>(null)
  const drop = (event: DragEvent, status: TaskStatus) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    const task = tasks.find((item) => item.id === id)
    if (task && task.status !== status && task.can_edit) onMove(id, status)
    setDragging(null)
    setOver(null)
  }
  return (
    <div className="tasks-board">
      {STATUSES.map((status) => {
        const items = sortTasks(tasks.filter((task) => task.status === status.id))
        return (
          <section key={status.id} className={`tasks-column tasks-board__column${over === status.id ? ' is-over' : ''}`} aria-labelledby={`tasks-board-${status.id}`}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); setOver(status.id) } }}
            onDragLeave={() => setOver((current) => current === status.id ? null : current)}
            onDrop={(event) => drop(event, status.id)}>
            <header className="tasks-column__head">
              <h2 id={`tasks-board-${status.id}`}><span className={`tasks-status-dot is-${status.id}`} aria-hidden="true" />{status.label}</h2>
              <span className="ui-count">{items.length}</span>
              <button type="button" className="tasks-icon-button" aria-label={`Add task to ${status.label}`} onClick={() => onCompose(status.id)}><Icon name="plus" /></button>
            </header>
            {items.length ? (
              <ul className="task-cards">
                {items.map((task) => (
                  <TaskCard key={task.id} task={task} row={row} showSource dragProps={{
                    draggable: task.can_edit,
                    dragging: dragging === task.id,
                    onDragStart: (event) => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; setDragging(task.id) },
                    onDragEnd: () => { setDragging(null); setOver(null) },
                  }} />
                ))}
              </ul>
            ) : <p className="tasks-column__empty">{dragging ? 'Drop here' : 'Nothing here'}</p>}
          </section>
        )
      })}
    </div>
  )
}

/* ---------- calendar ---------- */

function CalendarView({ tasks, today, selectedId, onSelect, onPrefetch, onCompose }: {
  tasks: Task[]; today: string; selectedId: string | null
  onSelect: (id: string) => void; onPrefetch: (id: string) => void; onCompose: (date: string) => void
}) {
  const [cursor, setCursor] = useState(() => { const date = parseDay(today); return new Date(date.getFullYear(), date.getMonth(), 1) })
  const start = new Date(cursor)
  start.setDate(1 - cursor.getDay())
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day })
  const byDay = new Map<string, Task[]>()
  for (const task of sortTasks(tasks)) if (task.due_date) byDay.set(task.due_date, [...(byDay.get(task.due_date) ?? []), task])
  const undated = tasks.filter((task) => !task.due_date && task.status !== 'done').length
  const shift = (months: number) => setCursor((current) => new Date(current.getFullYear(), current.getMonth() + months, 1))
  const monthDays = days.filter((day) => day.getMonth() === cursor.getMonth() && byDay.has(isoDay(day)))
  const chip = (task: Task) => (
    <button key={task.id} type="button" className={`tasks-calendar__chip${task.kind === 'event' ? ' is-event' : ''}${task.status === 'done' ? ' is-done' : ''}${task.id === selectedId ? ' is-selected' : ''}`}
      onClick={() => onSelect(task.id)} onMouseEnter={() => onPrefetch(task.id)} onFocus={() => onPrefetch(task.id)}>
      {task.due_time ? <time>{timeLabel(task.due_time)}</time> : null}<span>{task.title}</span>
    </button>
  )
  return (
    <div className="tasks-calendar">
      <header className="tasks-calendar__head">
        <h2>{monthTitle.format(cursor)}</h2>
        <div className="tasks-calendar__nav">
          <button type="button" className="ui-button ui-button--sm" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevron-left" /></button>
          <button type="button" className="ui-button ui-button--sm" onClick={() => { const date = parseDay(today); setCursor(new Date(date.getFullYear(), date.getMonth(), 1)) }}>Today</button>
          <button type="button" className="ui-button ui-button--sm" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron-right" /></button>
        </div>
        {undated ? <span className="tasks-calendar__undated">{undated} open {undated === 1 ? 'task has' : 'tasks have'} no date</span> : null}
      </header>
      <div className="tasks-calendar__grid" role="grid" aria-label={monthTitle.format(cursor)}>
        <div role="row" className="tasks-calendar__row is-weekdays">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day} className="tasks-calendar__weekday" role="columnheader">{day}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="tasks-calendar__row">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const key = isoDay(day)
              const items = byDay.get(key) ?? []
              return (
                <div key={key} role="gridcell" className={`tasks-calendar__day${day.getMonth() !== cursor.getMonth() ? ' is-outside' : ''}${key === today ? ' is-today' : ''}`}>
                  <button type="button" className="tasks-calendar__date" onClick={() => onCompose(key)} aria-label={`Add a task on ${longDate.format(day)}`}>{day.getDate()}</button>
                  {items.slice(0, 3).map(chip)}
                  {items.length > 3 ? <span className="tasks-calendar__more">+{items.length - 3} more</span> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <ol className="tasks-agenda" aria-label={`${monthTitle.format(cursor)} agenda`}>
        {monthDays.length ? monthDays.map((day) => {
          const key = isoDay(day)
          return (
            <li key={key} className={key === today ? 'is-today' : ''}>
              <h3>{longDate.format(day)}</h3>
              <div>{(byDay.get(key) ?? []).map(chip)}</div>
            </li>
          )
        }) : <li className="tasks-agenda__empty">Nothing scheduled this month.</li>}
      </ol>
    </div>
  )
}

/* ---------- composer ---------- */

function KindToggle({ value, onChange }: { value: Task['kind']; onChange: (kind: Task['kind']) => void }) {
  return (
    <div className="ui-segmented" role="group" aria-label="Type">
      <button type="button" className="ui-segmented__item" aria-pressed={value === 'task'} onClick={() => onChange('task')}>Task</button>
      <button type="button" className="ui-segmented__item" aria-pressed={value === 'event'} onClick={() => onChange('event')}>Event</button>
    </div>
  )
}

function TaskComposer({ draft, groups, courses, me, onCancel, onCreate }: {
  draft: Draft; groups: StudyGroup[]; courses: string[]; me: string
  onCancel: () => void; onCreate: (input: TaskInput & { title: string }) => void
}) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Task['kind']>('task')
  const [dueDate, setDueDate] = useState(draft.due_date ?? '')
  const [dueTime, setDueTime] = useState('')
  const [location, setLocation] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [course, setCourse] = useState('')
  const [groupId, setGroupId] = useState(draft.group_id ?? '')
  const [assignees, setAssignees] = useState<string[]>([me])
  const [description, setDescription] = useState('')
  const group = groups.find((item) => item.id === groupId)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    onCreate({
      title: title.trim(), kind, description, course: course.trim(), priority, location: location.trim(), status: draft.status ?? 'todo',
      due_date: dueDate || null, due_time: dueDate && dueTime ? dueTime : null,
      group_id: groupId || null, assignee_ids: groupId && assignees.length ? assignees : [me],
    })
  }
  return (
    <form className="task-panel" onSubmit={submit}>
      <header className="task-panel__bar">
        <span className="ui-eyebrow">New {kind}</span>
        <button type="button" className="tasks-icon-button" onClick={onCancel} aria-label="Cancel new task"><Icon name="close" /></button>
      </header>
      <input className="task-panel__title-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'event' ? 'Event name' : 'Task name'} aria-label="Title" maxLength={140} autoFocus required />
      <KindToggle value={kind} onChange={setKind} />
      <div className="task-form">
        <label className="ui-field"><span>Date</span><input className="ui-input" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        <label className="ui-field"><span>Time</span><input className="ui-input" type="time" value={dueTime} disabled={!dueDate} onChange={(event) => setDueTime(event.target.value)} /></label>
        <label className="ui-field is-wide"><span>Location</span><input className="ui-input" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="e.g. Room 204, the library" maxLength={200} /></label>
        <label className="ui-field"><span>Priority</span>
          <select className="ui-select" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
            {PRIORITIES.map((item) => <option key={item} value={item}>{PRIORITY_LABEL[item]}</option>)}
          </select>
        </label>
        <label className="ui-field"><span>Course</span>
          <input className="ui-input" value={course} onChange={(event) => setCourse(event.target.value)} list="tasks-course-options" placeholder="Optional" maxLength={120} />
          <datalist id="tasks-course-options">{courses.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="ui-field is-wide"><span>Source</span>
          <select className="ui-select" value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssignees([me]) }}>
            <option value="">Personal</option>
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {group ? <div className="ui-field is-wide"><span id="new-assignees">Assign to</span><AssigneePicker labelledBy="new-assignees" members={group.members} value={assignees} onChange={setAssignees} /></div> : null}
        <label className="ui-field is-wide"><span>Details</span><textarea className="ui-textarea" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Start typing…" rows={4} maxLength={4000} /></label>
      </div>
      <div className="task-panel__actions">
        <button type="button" className="ui-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="ui-button ui-button--primary" disabled={!title.trim()}>Create {kind}</button>
      </div>
    </form>
  )
}

function AssigneePicker({ members, value, onChange, labelledBy }: { members: StudyGroup['members']; value: string[]; onChange: (next: string[]) => void; labelledBy: string }) {
  return (
    <div className="assignee-picker" role="group" aria-labelledby={labelledBy}>
      {members.map((member) => {
        const on = value.includes(member.student_id)
        return (
          <button key={member.student_id} type="button" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((id) => id !== member.student_id) : [...value, member.student_id])}>
            <Avatar name={member.display_name} />{member.display_name}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- details panel ---------- */

function TaskPanel({ task, detail, groups, today, token, onClose, onPatch, onToggle, onDelete, onDetail, onCounts, onError }: {
  task: Task; detail?: TaskDetail; groups: StudyGroup[]; today: string; token: string
  onClose: () => void; onPatch: (changes: TaskInput) => void; onToggle: () => void; onDelete: () => void
  onDetail: (change: (detail: TaskDetail) => TaskDetail) => void
  onCounts: (change: Counts) => void
  onError: (message: string) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [location, setLocation] = useState(task.location)
  const [course, setCourse] = useState(task.course)
  const [editing, setEditing] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [comment, setComment] = useState('')
  const [link, setLink] = useState('')
  const [sending, setSending] = useState(false)
  const group = groups.find((item) => item.id === task.group_id)
  const editable = task.can_edit
  const done = task.status === 'done'
  const pending = task.id.startsWith('temp-')
  const overdue = isOverdue(task, today)

  const addItem = async (event: FormEvent) => {
    event.preventDefault()
    const text = newItem.trim()
    if (!text) return
    setNewItem('')
    try {
      const item = await addTaskChecklistItem(task.id, text, token)
      onDetail((current) => ({ ...current, checklist: [...current.checklist, item] }))
      onCounts({ checklist_total: 1 })
    } catch (error) { setNewItem(text); onError(errorText(error)) }
  }

  const toggleItem = async (itemId: number, value: boolean) => {
    onDetail((current) => ({ ...current, checklist: current.checklist.map((item) => item.id === itemId ? { ...item, done: value } : item) }))
    onCounts({ checklist_done: value ? 1 : -1 })
    try { await updateTaskChecklistItem(task.id, itemId, { done: value }, token) } catch (error) {
      onDetail((current) => ({ ...current, checklist: current.checklist.map((item) => item.id === itemId ? { ...item, done: !value } : item) }))
      onCounts({ checklist_done: value ? -1 : 1 })
      onError(errorText(error))
    }
  }

  const removeItem = async (itemId: number, wasDone: boolean) => {
    try {
      await deleteTaskChecklistItem(task.id, itemId, token)
      onDetail((current) => ({ ...current, checklist: current.checklist.filter((item) => item.id !== itemId) }))
      onCounts({ checklist_total: -1, checklist_done: wasDone ? -1 : 0 })
    } catch (error) { onError(errorText(error)) }
  }

  const sendComment = async (event: FormEvent) => {
    event.preventDefault()
    const body = comment.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const saved = await addTaskComment(task.id, body, token)
      setComment('')
      onDetail((current) => ({ ...current, comments: [...current.comments, saved] }))
      onCounts({ comment_count: 1 })
    } catch (error) { onError(errorText(error)) } finally { setSending(false) }
  }

  const addLink = async (event: FormEvent) => {
    event.preventDefault()
    const url = link.trim()
    if (!url) return
    try {
      const saved = await addTaskLink(task.id, /^https?:\/\//i.test(url) ? url : `https://${url}`, '', token)
      setLink('')
      onDetail((current) => ({ ...current, attachments: [...current.attachments, saved] }))
      onCounts({ attachment_count: 1 })
    } catch (error) { onError(errorText(error)) }
  }

  const removeAttachment = async (attachmentId: number) => {
    try {
      await deleteTaskAttachment(task.id, attachmentId, token)
      onDetail((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachmentId) }))
      onCounts({ attachment_count: -1 })
    } catch (error) { onError(errorText(error)) }
  }

  const saveLocation = () => { if (location.trim() !== task.location) onPatch({ location: location.trim() }) }

  return (
    <div className="task-panel">
      <header className="task-panel__bar">
        <button type="button" className="tasks-icon-button" onClick={onClose} aria-label="Close details"><Icon name="close" /></button>
        <span className="ui-eyebrow task-panel__source">{task.group_name ?? 'Personal'}</span>
        {task.can_delete ? <button type="button" className="tasks-icon-button is-danger" onClick={onDelete} aria-label={`Delete ${task.title}`} title="Delete"><Icon name="trash" /></button> : null}
      </header>

      <div className="task-summary">
        <div className="task-summary__top">
          {editable ? (
            <input className="task-panel__title-input" value={title} aria-label="Title" maxLength={140}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => { if (title.trim() && title.trim() !== task.title) onPatch({ title: title.trim() }); else setTitle(task.title) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') { event.preventDefault(); setTitle(task.title); event.currentTarget.blur() }
              }} />
          ) : <h2 className="task-panel__title">{task.title}</h2>}
          <button type="button" className={`ui-button ui-button--sm task-complete${done ? '' : ' ui-button--primary'}`} disabled={!editable || pending} aria-pressed={done} onClick={onToggle}>
            {done ? <><Icon name="check" />Completed</> : 'Complete'}
          </button>
        </div>
        <p className={`task-summary__when${overdue ? ' is-overdue' : ''}`}><Icon name="clock" />{whenLabel(task, today)}{overdue ? ' · Overdue' : ''}</p>
        <div className="task-summary__chips">
          <span className={`ui-badge${task.kind === 'event' ? ' ui-badge--accent' : ''}`}>{task.kind === 'event' ? 'Event' : 'Task'}</span>
          <span className={`ui-badge${task.priority === 'urgent' ? ' ui-badge--danger' : task.priority === 'high' ? ' ui-badge--warning' : ''}`}>{PRIORITY_LABEL[task.priority]}</span>
          {task.status === 'in_progress' || task.status === 'review' ? <span className="ui-badge">{STATUSES.find((item) => item.id === task.status)?.label}</span> : null}
          {task.course ? <span className="ui-badge">{task.course}</span> : null}
        </div>
        <div className="task-summary__location">
          <Icon name="pin" />
          {editable ? (
            <>
              <label className="task-summary__label" htmlFor="task-location">Location</label>
              <input id="task-location" className="task-inline-input" value={location} placeholder="Add a place" maxLength={200}
                onChange={(event) => setLocation(event.target.value)} onBlur={saveLocation}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') { event.preventDefault(); setLocation(task.location); event.currentTarget.blur() }
                }} />
            </>
          ) : <><span className="task-summary__label">Location</span><span>{task.location || 'None'}</span></>}
        </div>
        {editable ? (
          <button type="button" className="ui-link task-summary__more" aria-expanded={editing} aria-controls="task-edit-fields" onClick={() => setEditing((open) => !open)}>
            {editing ? '− Fewer details' : '+ Details'}
          </button>
        ) : <p className="task-panel__hint">Only the creator, assignees or the group owner can edit this task. You can still comment.</p>}

        {editing && editable ? (
          <div className="task-form" id="task-edit-fields">
            <div className="ui-field is-wide"><span>Type</span><KindToggle value={task.kind} onChange={(kind) => onPatch({ kind })} /></div>
            <label className="ui-field"><span>Date</span><input className="ui-input" type="date" value={task.due_date ?? ''} onChange={(event) => onPatch({ due_date: event.target.value || null, ...(event.target.value ? {} : { due_time: null }) })} /></label>
            <label className="ui-field"><span>Time</span><input className="ui-input" type="time" value={task.due_time ?? ''} disabled={!task.due_date} onChange={(event) => onPatch({ due_time: event.target.value || null })} /></label>
            <label className="ui-field"><span>Priority</span>
              <select className="ui-select" value={task.priority} onChange={(event) => onPatch({ priority: event.target.value as TaskPriority })}>
                {PRIORITIES.map((item) => <option key={item} value={item}>{PRIORITY_LABEL[item]}</option>)}
              </select>
            </label>
            <label className="ui-field"><span>Status</span>
              <select className="ui-select" value={task.status} onChange={(event) => onPatch({ status: event.target.value as TaskStatus })}>
                {STATUSES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="ui-field is-wide"><span>Course</span>
              <input className="ui-input" value={course} maxLength={120} placeholder="Add a course" onChange={(event) => setCourse(event.target.value)} onBlur={() => { if (course.trim() !== task.course) onPatch({ course: course.trim() }) }} />
            </label>
            {group ? <div className="ui-field is-wide"><span id="task-assignees">Assigned to</span><AssigneePicker labelledBy="task-assignees" members={group.members} value={task.assignees.map((person) => person.student_id)} onChange={(next) => { if (next.length) onPatch({ assignee_ids: next }) }} /></div> : null}
          </div>
        ) : null}
      </div>

      <label className="task-section-label" htmlFor="task-details">Details</label>
      <textarea id="task-details" className="ui-textarea task-details" value={description} disabled={!editable} rows={5} maxLength={4000} placeholder={editable ? 'Start typing…' : 'No details'}
        onChange={(event) => setDescription(event.target.value)} onBlur={() => { if (description !== task.description) onPatch({ description }) }} />

      {task.group_id ? (
        <div className="task-people">
          <span>Created by {task.owner.display_name}</span>
          {task.assignees.length ? <span className="task-people__list">{task.assignees.map((person) => <span key={person.student_id}><Avatar name={person.display_name} />{person.display_name}</span>)}</span> : null}
        </div>
      ) : null}

      <details className="task-section" open={task.checklist_total > 0}>
        <summary><h3>Checklist</h3><span className="ui-count">{task.checklist_total ? `${task.checklist_done}/${task.checklist_total}` : ''}</span></summary>
        {task.checklist_total ? <div className="ui-meter"><span style={{ width: `${task.checklist_done / task.checklist_total * 100}%` }} /></div> : null}
        {detail?.checklist.length ? (
          <ul className="task-checklist">
            {detail.checklist.map((item) => (
              <li key={item.id}>
                <label><input type="checkbox" className="ui-checkbox" checked={item.done} disabled={!editable} onChange={(event) => void toggleItem(item.id, event.target.checked)} /><span>{item.text}</span></label>
                {editable ? <button type="button" className="tasks-icon-button" aria-label={`Remove ${item.text}`} onClick={() => void removeItem(item.id, item.done)}><Icon name="close" /></button> : null}
              </li>
            ))}
          </ul>
        ) : !detail && !pending && task.checklist_total ? <span className="ui-skeleton task-section__loading" /> : null}
        {editable && !pending ? <form onSubmit={addItem} className="tasks-quick-add"><Icon name="plus" /><input value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="Add a step" aria-label="Add a checklist step" maxLength={200} /></form> : null}
      </details>

      <details className="task-section" open={task.attachment_count > 0}>
        <summary><h3>Links</h3><span className="ui-count">{task.attachment_count || ''}</span></summary>
        {detail?.attachments.length ? (
          <ul className="task-links">
            {detail.attachments.map((item) => (
              <li key={item.id}>
                {item.kind === 'link' ? <a className="ui-link" href={item.url} target="_blank" rel="noopener noreferrer"><Icon name="link" />{item.label || item.url}</a> : <span>{item.label} <small>note</small></span>}
                <small>{item.added_by_name}</small>
                {item.mine || task.can_delete ? <button type="button" className="tasks-icon-button" aria-label={`Remove ${item.label || item.url}`} onClick={() => void removeAttachment(item.id)}><Icon name="close" /></button> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {editable && !pending ? <form onSubmit={addLink} className="tasks-quick-add"><Icon name="link" /><input value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a link" aria-label="Attach a link" type="url" inputMode="url" maxLength={500} /></form> : null}
      </details>

      {task.group_id ? (
        <details className="task-section" open>
          <summary><h3>Comments</h3><span className="ui-count">{task.comment_count || ''}</span></summary>
          {detail?.comments.length ? (
            <ol className="task-comments">
              {detail.comments.map((item) => (
                <li key={item.id}><Avatar name={item.author_name} /><div><strong>{item.author_name}</strong><time dateTime={item.created_at}>{stamp.format(new Date(parseServerTime(item.created_at)))}</time><p>{item.body}</p></div></li>
              ))}
            </ol>
          ) : null}
          {!pending ? (
            <form onSubmit={sendComment} className="task-comment-form">
              <textarea className="ui-textarea" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Write a comment" aria-label="Write a comment" rows={2} maxLength={2000}
                onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit() }} />
              <button type="submit" className={`ui-button ui-button--sm${sending ? ' is-busy' : ''}`} disabled={!comment.trim()}>Comment</button>
            </form>
          ) : null}
        </details>
      ) : null}

      {task.group_id && detail?.activity.length ? (
        <details className="task-section">
          <summary><h3>Activity</h3><span className="ui-count">{detail.activity.length}</span></summary>
          <ol className="task-activity">
            {detail.activity.map((item) => <li key={item.id}><span><strong>{item.actor_name}</strong> {activityText(item)}</span><time dateTime={item.created_at}>{stamp.format(new Date(parseServerTime(item.created_at)))}</time></li>)}
          </ol>
        </details>
      ) : null}
    </div>
  )
}
