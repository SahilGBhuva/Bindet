import { getTasks, request } from './api'

export { CLASSROOM_UNIT, checkClassroomLink, LINK_HINTS, notebookWithClassroomCourse, type LinkCheck } from './classroomLink'

/*
 * Google Classroom import through a class calendar's secret iCal address.
 * The server (backend/classroom.py) does the real validation, fetching and importing;
 * the check here only gives the student instant feedback while they paste.
 */

export type ClassroomSyncSummary = { created: number; updated: number; notes: number }
export type ClassroomFeed = {
  id: string
  course: string
  /* Always masked by the server: the secret address never comes back. */
  masked_url: string
  save_notes: boolean
  last_status: 'ok' | 'private' | 'unreachable' | 'invalid' | 'new'
  last_synced_at: string | null
  imported_count: number
  created_at: string
  sync?: ClassroomSyncSummary
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export async function listClassroomFeeds(accessToken: string) {
  return request<{ feeds: ClassroomFeed[]; max_feeds: number }>('/api/classroom/feeds', undefined, accessToken)
}

export async function connectClassroom(url: string, course: string, accessToken: string) {
  const feed = await request<ClassroomFeed>('/api/classroom/feeds', {
    method: 'POST', body: JSON.stringify({ url: url.trim(), course, tz: timeZone() }), timeoutMs: 30_000,
  }, accessToken)
  await refreshTasks(accessToken)
  return feed
}

export async function syncClassroom(feedId: string, accessToken: string) {
  const feed = await request<ClassroomFeed>(`/api/classroom/feeds/${encodeURIComponent(feedId)}/sync`, {
    method: 'POST', body: JSON.stringify({ tz: timeZone() }), timeoutMs: 30_000,
  }, accessToken)
  await refreshTasks(accessToken)
  return feed
}

export function setClassroomNotes(feedId: string, saveNotes: boolean, accessToken: string) {
  return request<ClassroomFeed>(`/api/classroom/feeds/${encodeURIComponent(feedId)}`, {
    method: 'PATCH', body: JSON.stringify({ save_notes: saveNotes }),
  }, accessToken)
}

export async function disconnectClassroom(feedId: string, deleteTasks: boolean, accessToken: string) {
  const result = await request<{ deleted: boolean; tasks_deleted: number }>(
    `/api/classroom/feeds/${encodeURIComponent(feedId)}?delete_tasks=${deleteTasks ? 'true' : 'false'}`,
    { method: 'DELETE' }, accessToken,
  )
  await refreshTasks(accessToken)
  return result
}

/* Reload the task list so the Tasks page and sidebar pick up imported tasks (TASKS_CHANGED_EVENT). */
async function refreshTasks(accessToken: string) {
  try {
    await getTasks(accessToken, true)
  } catch {
    // The Tasks page loads them itself next time.
  }
}

const CHECKED_KEY = 'bindet:classroom:checked'
const CHECK_EVERY_MS = 30 * 60 * 1000

/*
 * On app open: a cheap call that does nothing without connected classes; otherwise the
 * server recomputes due-date priorities and re-fetches classes last synced over 3 hours
 * ago. At most once every 30 minutes per device.
 */
export async function refreshClassroomOnOpen(accessToken: string, now = Date.now()) {
  try {
    const last = Number(localStorage.getItem(CHECKED_KEY) ?? 0)
    if (now - last < CHECK_EVERY_MS) return null
    localStorage.setItem(CHECKED_KEY, String(now))
  } catch {
    // Storage unavailable: still check (the server rate-limits this call).
  }
  const result = await request<{ feeds: number | null; synced: number; changed: number }>('/api/classroom/refresh', {
    method: 'POST', body: JSON.stringify({ tz: timeZone() }), timeoutMs: 30_000,
  }, accessToken)
  if (result.changed > 0 || result.synced > 0) await refreshTasks(accessToken)
  return result
}
