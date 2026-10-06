import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type FormEvent, type ReactNode } from 'react'
import {
  ApiError, addTaskChecklistItem, addTaskComment, addTaskLink, createTask, deleteTask, deleteTaskAttachment, deleteTaskChecklistItem,
  getCachedFriends, getCachedStudyGroups, getCachedTasks, getFriends, getStudyGroups, getTask, getTasks, parseServerTime,
  setCachedTasks, updateTask, updateTaskChecklistItem,
  type SocialNotification, type StudyGroup, type Task, type TaskDetail, type TaskInput, type TaskPriority, type TaskStatus,
} from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { loadNotebook } from '../lib/session'
import { toneForName } from '../lib/tones'
import './Goals.css'

/*
 * Tasks, drawn after the owner's sketch: a small "Tasks" title, three tiny tools
 * (settings, list/board, show completed), today's date, the My Tasks / Group Tasks /
 * Calendar tabs, two compact boxes (To-Do and Assigned) on the left and the selected
 * task's details card on the right. Everything is server data: the server checks
 * ownership and group permissions (can_edit / can_manage / can_delete) and the UI follows them.
 * Cached lists render first and refresh in the background; edits apply optimistically
 * and roll back with a message on failure. Deletes wait a few seconds for Undo.
 */

type Tab = 'mine' | 'group' | 'calendar'
type View = 'list' | 'board'
type Draft = { due_date?: string; status?: TaskStatus; group_id?: string | null }
type Toast = { text: string; undo?: () => void; error?: boolean }
type Counts = Partial<Pick<Task, 'checklist_total' | 'checklist_done' | 'comment_count' | 'attachment_count'>>

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'mine', label: 'My Tasks', icon: 'triangle' },
  { id: 'group', label: 'Group Tasks', icon: 'people' },
  { id: 'calendar', label: 'Calendar', icon: 'rect' },
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
const PHONE_QUERY = '(max-width: 860px)'

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

/* The day part of "Monday ⏱ 4:30 pm". */
function dayLabel(task: Task, today: string) {
  if (!task.due_date) return 'No date'
  const day = parseDay(task.due_date)
  if (task.due_date === today) return 'Today'
  if (task.due_date === addDays(today, 1)) return 'Tomorrow'
  if (task.due_date > today && task.due_date <= addDays(today, 6)) return weekdayLong.format(day)
  return weekdayDate.format(day)
}

/* Screen-reader summary for a card that only shows its title. */
function cardSummary(task: Task, today: string) {
  const parts = [task.kind === 'event' ? 'Event' : 'Task']
  if (task.due_date) parts.push(`${isOverdue(task, today) ? 'overdue, ' : ''}due ${task.due_date === today ? 'today' : shortDate.format(parseDay(task.due_date))}${task.due_time ? ` at ${timeLabel(task.due_time)}` : ''}`)
  if (task.priority === 'high' || task.priority === 'urgent') parts.push(PRIORITY_LABEL[task.priority].toLowerCase())
  if (task.status === 'done') parts.push('completed')
  return parts.join(', ')
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
    .filter((item) => item.kind.startsWith('task_') || item.kind.startsWith('group_'))
    .toSorted((a, b) => parseServerTime(b.created_at) - parseServerTime(a.created_at))[0] ?? null
}

function subscribePhone(callback: () => void) {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

function usePhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false)
}

/* ---------- icons ---------- */

type IconName = 'triangle' | 'people' | 'rect' | 'square-plus' | 'edit' | 'pencil' | 'list' | 'board' | 'settings' | 'close-box' | 'close'
  | 'clock' | 'pin' | 'bell' | 'dot-circle' | 'check' | 'chevron-left' | 'chevron-right' | 'link'
const ICONS: Record<IconName, ReactNode> = {
  triangle: <path d="M12 5 20 19H4z" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" /><path d="M16 5.3a3 3 0 0 1 0 5.4M18 14.4c1.6.7 2.7 2.3 3 4.6" /></>,
  rect: <rect x="3.5" y="6.5" width="17" height="11" rx="1.5" />,
  'square-plus': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M12 8.5v7M8.5 12h7" /></>,
  edit: <><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /><path d="m17.5 3.5 3 3L12 15l-4 1 1-4z" /></>,
  pencil: <path d="m15.5 4.5 4 4L9 19l-5 1 1-5z" />,
  list: <path d="M5 7h14M5 12h14M5 17h14" />,
  board: <><rect x="3.5" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="16.5" y="4" width="4" height="7" rx="1.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  'close-box': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  'dot-circle': <><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
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
  const phone = usePhone()
  const [tasks, setTasks] = useState<Task[]>(() => token ? getCachedTasks(token) ?? [] : [])
  const [groups, setGroups] = useState<StudyGroup[]>(() => token ? getCachedStudyGroups(token) ?? [] : [])
  const [loaded, setLoaded] = useState(() => !!(token && getCachedTasks(token)))
  const [loadError, setLoadError] = useState('')
  const [tab, setTabState] = useState<Tab>(() => readPref('bindit:tasks:tab', ['mine', 'group', 'calendar'] as const, 'mine'))
  const [view, setViewState] = useState<View>(() => readPref('bindit:tasks:view', ['list', 'board'] as const, 'list'))
  const [showDone, setShowDoneState] = useState(() => readPref('bindit:tasks:show-done', ['yes', 'no'] as const, 'no') === 'yes')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panelClosed, setPanelClosed] = useState(false)
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
  const courses = useMemo(() => loadNotebook().courses.map((item) => item.name), [])

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

  const closePanel = useCallback(() => { setSelectedId(null); setDraft(null); setPanelClosed(true) }, [])

  useEffect(() => {
    if (!selectedId && !draft) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closePanel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, draft, closePanel])

  /* On phones the panel is a drawer: move focus into it when a task opens. */
  useEffect(() => {
    if (phone && selectedId && !draft) panelRef.current?.focus()
  }, [phone, selectedId, draft])

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
  }, [])

  const compose = useCallback((next: Draft) => { setSelectedId(null); setDraft(next) }, [])

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
    const groupId = changes.group_id !== undefined ? changes.group_id : previous.group_id
    const group = groups.find((item) => item.id === groupId)
    const optimistic: Task = {
      ...previous,
      ...changes,
      group_id: groupId,
      group_name: group?.name ?? null,
      assignees: changes.assignee_ids
        ? changes.assignee_ids.map((id) => ({ student_id: id, display_name: group?.members.find((member) => member.student_id === id)?.display_name ?? previous.owner.display_name }))
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
      const movingToPersonal = Boolean(previous.group_id) && changes.group_id === null
      const text = movingToPersonal && error instanceof ApiError && error.code === 'task_manage_forbidden'
        ? 'Only the creator can move this task out of the group.'
        : errorText(error)
      setToast({ text, error: true })
    }
  }, [tasks, token, groups, replaceTask, details, loadDetail])

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
      completed_at: null, can_edit: false, can_delete: false, can_manage: false,
    }
    setTasks((current) => [placeholder, ...current])
    setDraft(null)
    setSelectedId(tempId)
    try {
      const saved = await createTask(input, token)
      setTasks((current) => current.map((task) => task.id === tempId ? saved : task))
      setSelectedId((current) => current === tempId ? saved.id : current)
    } catch (error) {
      setTasks((current) => current.filter((task) => task.id !== tempId))
      setSelectedId((current) => current === tempId ? null : current)
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

  const isAssigned = useCallback((task: Task) => !!task.group_id && task.assignees.some((person) => person.student_id === me), [me])
  // My Tasks = personal to-dos plus group work assigned to me; group work I only handed out lives under Group Tasks.
  const mine = useMemo(() => tasks.filter((task) => !task.group_id || isAssigned(task)), [tasks, isAssigned])
  const groupTasks = useMemo(() => tasks.filter((task) => task.group_id), [tasks])
  const scoped = tab === 'group' ? groupTasks : mine
  const visible = showDone || tab === 'calendar' ? scoped : scoped.filter((task) => task.status !== 'done')
  const myTodo = sortTasks(visible.filter((task) => !isAssigned(task)))
  const myAssigned = sortTasks(visible.filter(isAssigned))

  /* On wide screens the details card always shows something, like the sketch: the
     first open task until the student picks or closes one. */
  const autoId = !phone && !panelClosed && !draft && tab !== 'calendar'
    ? (tab === 'mine' ? myTodo[0] ?? myAssigned[0] : sortTasks(visible)[0])?.id ?? null
    : null
  const activeId = selectedId ?? autoId
  const selected = tasks.find((task) => task.id === activeId) ?? null
  const visibleNotice = notice && String(notice.id) !== dismissedNotice ? notice : null
  const todayDate = parseDay(today)
  const defaultGroup = tab === 'group' ? groups[0]?.id ?? null : null

  const panel = draft
    ? <TaskComposer draft={draft} groups={groups} me={me} onCancel={closePanel} onCreate={(input) => void create(input)} />
    : selected
      ? <TaskPanel
          key={selected.id}
          task={selected}
          me={me}
          detail={details[selected.id]}
          groups={groups}
          courses={courses}
          today={today}
          token={token}
          onClose={closePanel}
          onExpand={() => loadDetail(selected.id)}
          onPatch={(changes) => void patchTask(selected.id, changes)}
          onDelete={() => removeTask(selected)}
          onDetail={(change) => updateDetail(selected.id, change)}
          onCounts={(change) => bumpCounts(selected.id, change)}
          onError={(text) => setToast({ text, error: true })}
        />
      : null
  const drawerOpen = phone && !!panel

  const card: CardProps = { today, selectedId: activeId, onSelect: select, onPrefetch: loadDetail }

  return (
    <div className="ui-page tasks-page">
      <div className="tasks-sheet">
        <h1 className="tasks-title">Tasks</h1>

        {visibleNotice ? (
          <div className="tasks-notice" role="status" title={stamp.format(new Date(parseServerTime(visibleNotice.created_at)))}>
            <span className="tasks-notice__mark"><Icon name="bell" /></span>
            <p>{visibleNotice.message}</p>
            <button type="button" className="tasks-icon-button" onClick={dismissNotice} aria-label="Dismiss notification"><Icon name="close" /></button>
          </div>
        ) : null}

        <div className="tasks-main">
          <div className="tasks-tools">
            <div className="tasks-settings" ref={settingsRef}>
              <button type="button" className="tasks-icon-button" aria-label="Task settings" title="Task settings" aria-expanded={settingsOpen} aria-controls="tasks-settings-menu" onClick={() => setSettingsOpen((open) => !open)}><Icon name="settings" /></button>
              {settingsOpen ? (
                <div id="tasks-settings-menu" className="ui-menu tasks-settings__menu" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setSettingsOpen(false) } }}>
                  <label className="tasks-settings__option">
                    <input type="checkbox" className="ui-checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} autoFocus />
                    Show completed tasks
                  </label>
                  <label className="tasks-settings__option">
                    <input type="checkbox" className="ui-checkbox" checked={view === 'board'} onChange={(event) => setView(event.target.checked ? 'board' : 'list')} />
                    Board layout
                  </label>
                  <button type="button" className="ui-menu__item" onClick={() => { setSettingsOpen(false); setReload((count) => count + 1) }}>Refresh tasks</button>
                </div>
              ) : null}
            </div>
            <button type="button" className="tasks-icon-button" aria-pressed={view === 'board'} onClick={() => setView(view === 'board' ? 'list' : 'board')}
              aria-label={view === 'board' ? 'Show as list' : 'Show as board'} title={view === 'board' ? 'Show as list' : 'Show as board'}>
              <Icon name={view === 'board' ? 'board' : 'list'} />
            </button>
            <button type="button" role="switch" className="tasks-switch" aria-checked={showDone} onClick={() => setShowDone(!showDone)} aria-label="Show completed tasks" title="Show completed tasks">
              <span aria-hidden="true" />
            </button>
          </div>

          <p className="tasks-date">
            <span className="tasks-date__tile" aria-hidden="true">{todayDate.getDate()}</span>
            <span className="sr-only">Today is </span>{monthDay.format(todayDate)}
          </p>

          <div className="tasks-tabbar">
            <div
              className="tasks-tabs"
              role="tablist"
              aria-label="Task views"
              onKeyDown={(event) => {
                // Arrow keys, Home and End move between the tabs (one tab stop for the whole list).
                const at = TABS.findIndex((item) => item.id === tab)
                const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key]
                if (to === undefined) return
                event.preventDefault()
                const next = TABS[(to + TABS.length) % TABS.length]
                setTab(next.id)
                document.getElementById(`tasks-tab-${next.id}`)?.focus()
              }}
            >
              {TABS.map((item) => (
                <button key={item.id} id={`tasks-tab-${item.id}`} type="button" role="tab" className="tasks-tab" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} aria-controls="tasks-tabpanel" onClick={() => setTab(item.id)}>
                  <Icon name={item.icon} />{item.label}
                </button>
              ))}
            </div>
            <button type="button" className="tasks-icon-button" onClick={() => compose({ group_id: defaultGroup })} aria-label="New task" title="New task">
              <Icon name="square-plus" />
            </button>
          </div>

          {loadError ? (
            <div className="ui-alert tasks-alert" role="alert"><span>{tasks.length ? 'Showing saved tasks. ' : ''}{loadError}</span><button type="button" className="ui-button ui-button--sm" onClick={() => setReload((count) => count + 1)}>Try again</button></div>
          ) : null}

          <section className="tasks-content" id="tasks-tabpanel" role="tabpanel" aria-labelledby={`tasks-tab-${tab}`}>
            {!loaded && !tasks.length ? <TasksSkeleton /> : (
              tab === 'calendar' ? <CalendarView tasks={visible} today={today} selectedId={activeId} onSelect={select} onCompose={(date) => compose({ due_date: date })} />
                : view === 'board' ? <BoardView tasks={visible} card={card} onMove={(id, status) => void patchTask(id, { status })} />
                  : tab === 'mine' ? (
                    <div className="tasks-boxes">
                      <TaskBox kind="todo" id="tasks-todo" tasks={myTodo} card={card} onCompose={() => compose({ group_id: null })} />
                      <TaskBox kind="assigned" id="tasks-assigned" tasks={myAssigned} card={card} />
                    </div>
                  ) : <GroupBoxes tasks={visible} groups={groups} isAssigned={isAssigned} card={card} onCompose={(groupId) => compose({ group_id: groupId })} />
            )}
          </section>
        </div>

        {panel || !phone ? (
          <>
            {drawerOpen ? <div className="tasks-scrim" aria-hidden="true" onClick={closePanel} /> : null}
            <aside ref={panelRef} className={`tasks-panel${drawerOpen ? ' is-drawer' : ''}`} role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined} aria-label={draft ? 'New task' : 'Task details'} tabIndex={-1}>
              {panel ?? <p className="tasks-panel__empty">{tasks.length ? 'Pick a task to see its details.' : 'No tasks yet. Use ⊞ to add one.'}</p>}
            </aside>
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
    <div className="tasks-boxes" aria-busy="true" aria-label="Loading tasks">
      {[0, 1].map((column) => (
        <div key={column} className="tasks-box">
          <span className="ui-skeleton tasks-skeleton__head" />
          <span className="ui-skeleton tasks-skeleton__card" />
          <span className="ui-skeleton tasks-skeleton__card" />
        </div>
      ))}
    </div>
  )
}

/* ---------- boxes and cards ---------- */

type CardProps = { today: string; selectedId: string | null; onSelect: (id: string) => void; onPrefetch: (id: string) => void }

/* A rounded bar with just the title; the open task gets the sketch's diagonal hatch. */
function TaskCard({ task, card, drag }: { task: Task; card: CardProps; drag?: { dragging: boolean; onStart: (event: DragEvent) => void; onEnd: () => void } }) {
  const { today, selectedId, onSelect, onPrefetch } = card
  const pending = task.id.startsWith('temp-')
  const isSelected = task.id === selectedId
  return (
    <li className={`task-card${isSelected ? ' is-selected' : ''}${task.status === 'done' ? ' is-done' : ''}${pending ? ' is-pending' : ''}${isOverdue(task, today) ? ' is-overdue' : ''}${drag?.dragging ? ' is-dragging' : ''}`}
      draggable={drag ? task.can_edit : undefined} onDragStart={drag?.onStart} onDragEnd={drag?.onEnd}>
      <button type="button" className="task-card__main" disabled={pending} aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(task.id)} onMouseEnter={() => onPrefetch(task.id)} onFocus={() => onPrefetch(task.id)}>
        <span className="task-card__title">{task.title}</span>
        <span className="sr-only">, {cardSummary(task, today)}</span>
      </button>
    </li>
  )
}

function TaskBox({ kind, id, tasks, card, onCompose, composeLabel = 'New task' }: {
  kind: 'todo' | 'assigned'; id: string; tasks: Task[]; card: CardProps; onCompose?: () => void; composeLabel?: string
}) {
  const open = tasks.filter((task) => task.status !== 'done').length
  return (
    <section className={`tasks-box is-${kind}`} aria-labelledby={id}>
      <header className="tasks-box__head">
        <h2 id={id}>
          <Icon name={kind === 'todo' ? 'triangle' : 'rect'} />
          {kind === 'todo' ? 'To-Do' : 'Assigned'}
          {kind === 'todo' ? <span className="tasks-box__count" aria-label={`${open} open`}>{open}</span> : null}
        </h2>
        {onCompose ? <button type="button" className="tasks-icon-button" onClick={onCompose} aria-label={composeLabel} title={composeLabel}><Icon name="edit" /></button> : null}
      </header>
      {tasks.length ? <ul className="task-cards">{tasks.map((task) => <TaskCard key={task.id} task={task} card={card} />)}</ul>
        : <p className="tasks-box__empty">{kind === 'assigned' ? 'None! Good work.' : 'Nothing to do.'}</p>}
    </section>
  )
}

function GroupBoxes({ tasks, groups, isAssigned, card, onCompose }: {
  tasks: Task[]; groups: StudyGroup[]; isAssigned: (task: Task) => boolean; card: CardProps; onCompose: (groupId: string) => void
}) {
  if (!groups.length) {
    return (
      <div className="tasks-none">
        <p>No study groups yet. Create or join one to share tasks and assign work.</p>
        <a className="ui-link" href="#profile">Find a group</a>
      </div>
    )
  }
  return (
    <div className="tasks-group-list">
      {groups.map((group) => {
        const items = tasks.filter((task) => task.group_id === group.id)
        return (
          <section key={group.id} className="tasks-group" aria-labelledby={`tasks-group-${group.id}`}>
            <h2 id={`tasks-group-${group.id}`} className="tasks-group__name"><Icon name="people" />{group.name}</h2>
            <div className="tasks-boxes is-group">
              <TaskBox kind="todo" id={`tasks-group-${group.id}-todo`} tasks={sortTasks(items.filter((task) => !isAssigned(task)))} card={card}
                onCompose={() => onCompose(group.id)} composeLabel={`New task for ${group.name}`} />
              <TaskBox kind="assigned" id={`tasks-group-${group.id}-assigned`} tasks={sortTasks(items.filter(isAssigned))} card={card} />
            </div>
          </section>
        )
      })}
    </div>
  )
}

/* The ≡ toggle's other layout. Drag moves a card between statuses; the Status field
   under "+ Details" is the keyboard alternative. */
function BoardView({ tasks, card, onMove }: { tasks: Task[]; card: CardProps; onMove: (id: string, status: TaskStatus) => void }) {
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
          <section key={status.id} className={`tasks-box tasks-board__column${over === status.id ? ' is-over' : ''}`} aria-labelledby={`tasks-board-${status.id}`}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); setOver(status.id) } }}
            onDragLeave={() => setOver((current) => current === status.id ? null : current)}
            onDrop={(event) => drop(event, status.id)}>
            <header className="tasks-box__head">
              <h2 id={`tasks-board-${status.id}`}>{status.label}<span className="tasks-box__count">{items.length}</span></h2>
            </header>
            {items.length ? (
              <ul className="task-cards">
                {items.map((task) => (
                  <TaskCard key={task.id} task={task} card={card} drag={{
                    dragging: dragging === task.id,
                    onStart: (event) => { event.dataTransfer.setData('text/plain', task.id); event.dataTransfer.effectAllowed = 'move'; setDragging(task.id) },
                    onEnd: () => { setDragging(null); setOver(null) },
                  }} />
                ))}
              </ul>
            ) : <p className="tasks-box__empty">{dragging ? 'Drop here' : 'Nothing here'}</p>}
          </section>
        )
      })}
    </div>
  )
}

/* ---------- calendar ---------- */

function CalendarView({ tasks, today, selectedId, onSelect, onCompose }: {
  tasks: Task[]; today: string; selectedId: string | null; onSelect: (id: string) => void; onCompose: (date: string) => void
}) {
  const [cursor, setCursor] = useState(() => { const date = parseDay(today); return new Date(date.getFullYear(), date.getMonth(), 1) })
  const start = new Date(cursor)
  start.setDate(1 - cursor.getDay())
  const days = Array.from({ length: 42 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return day })
  const byDay = new Map<string, Task[]>()
  for (const task of sortTasks(tasks)) if (task.due_date) byDay.set(task.due_date, [...(byDay.get(task.due_date) ?? []), task])
  const shift = (months: number) => setCursor((current) => new Date(current.getFullYear(), current.getMonth() + months, 1))
  const monthDays = days.filter((day) => day.getMonth() === cursor.getMonth() && byDay.has(isoDay(day)))
  const chip = (task: Task) => (
    <button key={task.id} type="button" className={`tasks-calendar__chip${task.status === 'done' ? ' is-done' : ''}${task.id === selectedId ? ' is-selected' : ''}`}
      onClick={() => onSelect(task.id)} title={task.due_time ? `${timeLabel(task.due_time)} · ${task.title}` : task.title}>
      {task.due_time ? <time>{timeLabel(task.due_time)}</time> : null}<span>{task.title}</span>
    </button>
  )
  return (
    <div className="tasks-calendar">
      <header className="tasks-calendar__head">
        <h2>{monthTitle.format(cursor)}</h2>
        <button type="button" className="tasks-icon-button" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevron-left" /></button>
        <button type="button" className="tasks-icon-button" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron-right" /></button>
      </header>
      <div className="tasks-calendar__grid" role="grid" aria-label={monthTitle.format(cursor)}>
        <div role="row" className="tasks-calendar__row is-weekdays">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={index} className="tasks-calendar__weekday" role="columnheader">{day}</span>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} role="row" className="tasks-calendar__row">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const key = isoDay(day)
              const items = byDay.get(key) ?? []
              return (
                <div key={key} role="gridcell" className={`tasks-calendar__day${day.getMonth() !== cursor.getMonth() ? ' is-outside' : ''}${key === today ? ' is-today' : ''}`}>
                  <button type="button" className="tasks-calendar__date" onClick={() => onCompose(key)} aria-label={`Add a task on ${longDate.format(day)}`}>{day.getDate()}</button>
                  {items.slice(0, 2).map(chip)}
                  {items.length > 2 ? <span className="tasks-calendar__more">+{items.length - 2}</span> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <ol className="tasks-agenda" aria-label={`${monthTitle.format(cursor)} agenda`}>
        {monthDays.length ? monthDays.map((day) => {
          const key = isoDay(day)
          return <li key={key} className={key === today ? 'is-today' : ''}><h3>{longDate.format(day)}</h3><div>{(byDay.get(key) ?? []).map(chip)}</div></li>
        }) : <li className="tasks-agenda__empty">Nothing scheduled this month.</li>}
      </ol>
    </div>
  )
}

/* ---------- compact composer ---------- */

function KindToggle({ value, onChange }: { value: Task['kind']; onChange: (kind: Task['kind']) => void }) {
  return (
    <div className="ui-segmented" role="group" aria-label="Type">
      <button type="button" className="ui-segmented__item" aria-pressed={value === 'task'} onClick={() => onChange('task')}>Task</button>
      <button type="button" className="ui-segmented__item" aria-pressed={value === 'event'} onClick={() => onChange('event')}>Event</button>
    </div>
  )
}

function TaskComposer({ draft, groups, me, onCancel, onCreate }: {
  draft: Draft; groups: StudyGroup[]; me: string
  onCancel: () => void; onCreate: (input: TaskInput & { title: string }) => void
}) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Task['kind']>('task')
  const [dueDate, setDueDate] = useState(draft.due_date ?? '')
  const [dueTime, setDueTime] = useState('')
  const [location, setLocation] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [groupId, setGroupId] = useState(draft.group_id ?? '')
  const [assignees, setAssignees] = useState<string[]>([me])
  const group = groups.find((item) => item.id === groupId)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim()) return
    onCreate({
      title: title.trim(), kind, priority, location: location.trim(), status: draft.status ?? 'todo',
      due_date: dueDate || null, due_time: dueDate && dueTime ? dueTime : null,
      group_id: groupId || null, assignee_ids: groupId && assignees.length ? assignees : [me],
    })
  }
  return (
    <form className="task-sheet" onSubmit={submit}>
      <div className="task-sheet__icons">
        <button type="button" className="tasks-icon-button is-tiny" onClick={onCancel} aria-label="Cancel new task" title="Cancel"><Icon name="close-box" /></button>
      </div>
      <div className="task-detail-card task-compose">
        <input className="task-title-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'event' ? 'New event' : 'New task'} aria-label="Title" maxLength={140} autoFocus required />
        <KindToggle value={kind} onChange={setKind} />
        <div className="task-form">
          <label className="ui-field"><span>Date</span><input className="ui-input" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
          <label className="ui-field"><span>Time</span><input className="ui-input" type="time" value={dueTime} disabled={!dueDate} onChange={(event) => setDueTime(event.target.value)} /></label>
          <label className="ui-field is-wide"><span>Location</span><input className="ui-input" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Optional" maxLength={200} /></label>
          <label className="ui-field"><span>Priority</span>
            <select className="ui-select" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
              {PRIORITIES.map((item) => <option key={item} value={item}>{PRIORITY_LABEL[item]}</option>)}
            </select>
          </label>
          <label className="ui-field"><span>List</span>
            <select className="ui-select" value={groupId} onChange={(event) => { setGroupId(event.target.value); setAssignees([me]) }}>
              <option value="">Personal</option>
              {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {group ? <div className="ui-field is-wide"><span id="new-assignees">Assign to</span><AssigneePicker labelledBy="new-assignees" members={group.members} value={assignees} onChange={setAssignees} /></div> : null}
        </div>
        <div className="task-compose__actions">
          <button type="button" className="ui-button ui-button--sm" onClick={onCancel}>Cancel</button>
          <button type="submit" className="ui-button ui-button--sm ui-button--primary" disabled={!title.trim()}>Add {kind}</button>
        </div>
      </div>
    </form>
  )
}

const ASSIGNEE_SAVE_DELAY_MS = 600

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

/* ---------- details card ---------- */

function TaskPanel({ task, detail, groups, courses, today, token, me, onClose, onExpand, onPatch, onDelete, onDetail, onCounts, onError }: {
  task: Task; detail?: TaskDetail; groups: StudyGroup[]; courses: string[]; today: string; token: string; me: string
  onClose: () => void; onExpand: () => void; onPatch: (changes: TaskInput) => void; onDelete: () => void
  onDetail: (change: (detail: TaskDetail) => TaskDetail) => void
  onCounts: (change: Counts) => void
  onError: (message: string) => void
}) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [location, setLocation] = useState(task.location)
  const [course, setCourse] = useState(task.course)
  const [expanded, setExpanded] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [comment, setComment] = useState('')
  const [link, setLink] = useState('')
  const [sending, setSending] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const group = groups.find((item) => item.id === task.group_id)
  const editable = task.can_edit
  // Title, dates, assignees and group belong to the creator and the group owner.
  const manageable = task.can_manage
  const done = task.status === 'done'
  const pending = task.id.startsWith('temp-')
  const overdue = isOverdue(task, today)

  // Assignee clicks update the picker at once, but only the final list is sent, once,
  // ASSIGNEE_SAVE_DELAY_MS after the last click (or straight away if the panel closes).
  const [assigneeDraft, setAssigneeDraft] = useState<string[] | null>(null)
  const assigneeSave = useRef<{ timer: number; send: () => void } | null>(null)
  const patchRef = useRef(onPatch)
  useEffect(() => { patchRef.current = onPatch }, [onPatch])
  useEffect(() => () => {
    const pendingSave = assigneeSave.current
    assigneeSave.current = null
    if (pendingSave) { window.clearTimeout(pendingSave.timer); pendingSave.send() }
  }, [])
  const savedAssignees = task.assignees.map((person) => person.student_id)
  const queueAssignees = (next: string[]) => {
    setAssigneeDraft(next)
    if (assigneeSave.current) window.clearTimeout(assigneeSave.current.timer)
    const send = () => {
      const unchanged = next.length === savedAssignees.length && next.every((id) => savedAssignees.includes(id))
      if (next.length && !unchanged) patchRef.current({ assignee_ids: next })
    }
    const timer = window.setTimeout(() => {
      assigneeSave.current = null
      setAssigneeDraft(null)
      send()
    }, ASSIGNEE_SAVE_DELAY_MS)
    assigneeSave.current = { timer, send }
  }

  const toggleExpanded = () => {
    if (!expanded) onExpand()
    setExpanded(!expanded)
  }

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
    <div className="task-sheet">
      <div className="task-sheet__icons">
        <button type="button" className="tasks-icon-button is-tiny" onClick={onClose} aria-label="Close details" title="Close"><Icon name="close-box" /></button>
        <button type="button" className="tasks-icon-button is-tiny" disabled={!manageable} onClick={() => { titleRef.current?.focus(); titleRef.current?.select() }}
          aria-label={`Rename ${task.title}`} title={manageable ? 'Rename' : 'Only the creator or group owner can rename this'}><Icon name="pencil" /></button>
      </div>

      <article className="task-detail-card" aria-label={task.title}>
        <div className="task-detail-card__top">
          {manageable ? (
            <input ref={titleRef} className="task-title-input" value={title} aria-label="Title" maxLength={140}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => { if (title.trim() && title.trim() !== task.title) onPatch({ title: title.trim() }); else setTitle(task.title) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
                if (event.key === 'Escape') { event.preventDefault(); setTitle(task.title); event.currentTarget.blur() }
              }} />
          ) : <h2 className="task-title">{task.title}</h2>}
          <button type="button" className={`task-pill task-complete${done ? ' is-done' : ''}`} disabled={!editable || pending} aria-pressed={done}
            onClick={() => onPatch({ status: done ? 'todo' : 'done' })}>
            {done ? <><Icon name="check" />Completed</> : 'Complete'}
          </button>
        </div>

        <p className={`task-when${overdue ? ' is-overdue' : ''}`}>
          <span>{dayLabel(task, today)}</span>
          {task.due_time ? <><Icon name="clock" /><span>{timeLabel(task.due_time)}</span></> : null}
          {overdue ? <span className="task-when__flag">Overdue</span> : null}
        </p>

        <span className="task-chip"><Icon name="dot-circle" />{task.kind === 'event' ? 'Event' : 'Task'}</span>

        <div className="task-branch">
          <span className="task-branch__elbow" aria-hidden="true" />
          <div className="task-branch__body">
            <div className="task-location">
              {editable ? (
                <>
                  <label htmlFor={`task-location-${task.id}`}>Location:</label>
                  <Icon name="pin" />
                  <input id={`task-location-${task.id}`} className="task-location__input" value={location} placeholder="Add a place" maxLength={200}
                    onChange={(event) => setLocation(event.target.value)} onBlur={saveLocation}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') { event.preventDefault(); setLocation(task.location); event.currentTarget.blur() }
                    }} />
                </>
              ) : <><span>Location:</span><Icon name="pin" /><span className="task-location__text">{task.location || 'None'}</span></>}
            </div>
            <button type="button" className="task-pill task-more" aria-expanded={expanded} aria-controls={`task-more-${task.id}`} onClick={toggleExpanded}>
              {expanded ? '− Details' : '+ Details'}
            </button>
          </div>
        </div>

        <span className={`task-chip${task.priority === 'urgent' ? ' is-urgent' : ''}`}><Icon name="dot-circle" />{PRIORITY_LABEL[task.priority]}</span>

        {expanded ? (
          <div className="task-more-fields" id={`task-more-${task.id}`}>
            {editable ? (
              <div className="task-form">
                <label className="ui-field"><span>Date</span><input className="ui-input" type="date" value={task.due_date ?? ''} disabled={!manageable} onChange={(event) => onPatch({ due_date: event.target.value || null, ...(event.target.value ? {} : { due_time: null }) })} /></label>
                <label className="ui-field"><span>Time</span><input className="ui-input" type="time" value={task.due_time ?? ''} disabled={!manageable || !task.due_date} onChange={(event) => onPatch({ due_time: event.target.value || null })} /></label>
                <div className="ui-field is-wide"><span>Type</span><KindToggle value={task.kind} onChange={(kind) => onPatch({ kind })} /></div>
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
                <label className="ui-field"><span>Course</span>
                  <input className="ui-input" value={course} maxLength={120} placeholder="Optional" list={`task-courses-${task.id}`} onChange={(event) => setCourse(event.target.value)} onBlur={() => { if (course.trim() !== task.course) onPatch({ course: course.trim() }) }} />
                  <datalist id={`task-courses-${task.id}`}>{courses.map((name) => <option key={name} value={name} />)}</datalist>
                </label>
                <label className="ui-field"><span>Group</span>
                  <select className="ui-select" value={task.group_id ?? ''} disabled={!manageable || pending}
                    onChange={(event) => {
                      const next = event.target.value || null
                      // Moving between groups removes other people's comments and links (the server enforces this).
                      if (task.group_id && next !== task.group_id && !window.confirm('Move this task? Comments and links from other people will be removed.')) {
                        event.target.value = task.group_id
                        return
                      }
                      onPatch({ group_id: next, assignee_ids: [task.owner.student_id] })
                    }}>
                    {!task.group_id || task.owner.student_id === me ? <option value="">Personal</option> : null}
                    {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                {group && manageable ? <div className="ui-field is-wide"><span id={`task-assignees-${task.id}`}>Assignees</span><AssigneePicker labelledBy={`task-assignees-${task.id}`} members={group.members} value={assigneeDraft ?? savedAssignees} onChange={queueAssignees} /></div> : null}
              </div>
            ) : <p className="task-hint">Only the creator, assignees or the group owner can edit this task. You can still comment.</p>}
            {task.group_id ? <p className="task-hint">Created by {task.owner.display_name}{task.assignees.length ? ` · Assigned to ${task.assignees.map((person) => person.display_name).join(', ')}` : ''}</p> : null}
            {task.can_delete ? <button type="button" className="ui-link task-delete" onClick={onDelete}>Delete {task.kind}</button> : null}
          </div>
        ) : null}
      </article>

      <label className="task-section-label" htmlFor={`task-details-${task.id}`}>Details</label>
      <textarea id={`task-details-${task.id}`} className="task-details" value={description} disabled={!editable} rows={5} maxLength={4000} placeholder={editable ? 'Start typing' : 'No details'}
        onChange={(event) => setDescription(event.target.value)} onBlur={() => { if (description !== task.description) onPatch({ description }) }} />

      {expanded ? (
        <div className="task-extras">
          <section className="task-section">
            <h3>Checklist{task.checklist_total ? <span className="tasks-box__count">{task.checklist_done}/{task.checklist_total}</span> : null}</h3>
            {detail?.checklist.length ? (
              <ul className="task-checklist">
                {detail.checklist.map((item) => (
                  <li key={item.id}>
                    <label><input type="checkbox" className="ui-checkbox" checked={item.done} disabled={!editable} onChange={(event) => void toggleItem(item.id, event.target.checked)} /><span>{item.text}</span></label>
                    {editable ? <button type="button" className="tasks-icon-button is-tiny" aria-label={`Remove ${item.text}`} onClick={() => void removeItem(item.id, item.done)}><Icon name="close" /></button> : null}
                  </li>
                ))}
              </ul>
            ) : !detail && !pending && task.checklist_total ? <span className="ui-skeleton task-section__loading" /> : null}
            {editable && !pending ? <form onSubmit={addItem} className="task-inline-add"><input value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="+ Add a step" aria-label="Add a checklist step" maxLength={200} /></form> : null}
          </section>

          <section className="task-section">
            <h3>Links{task.attachment_count ? <span className="tasks-box__count">{task.attachment_count}</span> : null}</h3>
            {detail?.attachments.length ? (
              <ul className="task-links">
                {detail.attachments.map((item) => (
                  <li key={item.id}>
                    {item.kind === 'link' ? <a className="ui-link" href={item.url} target="_blank" rel="noopener noreferrer"><Icon name="link" />{item.label || item.url}</a> : <span>{item.label} <small>note</small></span>}
                    <small>{item.added_by_name}</small>
                    {item.mine || task.can_delete ? <button type="button" className="tasks-icon-button is-tiny" aria-label={`Remove ${item.label || item.url}`} onClick={() => void removeAttachment(item.id)}><Icon name="close" /></button> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {editable && !pending ? <form onSubmit={addLink} className="task-inline-add"><input value={link} onChange={(event) => setLink(event.target.value)} placeholder="+ Paste a link" aria-label="Attach a link" type="url" inputMode="url" maxLength={500} /></form> : null}
          </section>

          {task.group_id ? (
            <section className="task-section">
              <h3>Comments{task.comment_count ? <span className="tasks-box__count">{task.comment_count}</span> : null}</h3>
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
            </section>
          ) : null}

          {task.group_id && detail?.activity.length ? (
            <section className="task-section">
              <h3>Activity</h3>
              <ol className="task-activity">
                {detail.activity.map((item) => <li key={item.id}><span><strong>{item.actor_name}</strong> {activityText(item)}</span><time dateTime={item.created_at}>{stamp.format(new Date(parseServerTime(item.created_at)))}</time></li>)}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
