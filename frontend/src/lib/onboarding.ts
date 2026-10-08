import { request } from './api'
import { loadNotebook, pickCourseTone, sameName, saveNotebook } from './session'
import { setCourseHidden } from './studyPrefs'
import type { Course } from './types'

/*
 * First-run setup. The server keeps whether the welcome setup was finished or skipped
 * and whether the Get started list was hidden (GET/PUT /api/account/onboarding), so
 * it is never shown again, on any device. This browser keeps a copy of "done" so a
 * returning student never waits for the check, and the step a student is on so a
 * reload resumes there. Both are `bindit:` keys: signing out clears them
 * (auth.clearSignedInState), and the next sign-in asks the server again.
 *
 * Never used by the landing page demo.
 */

export type OnboardingSteps = { notes: boolean; flashcards: boolean; quiz: boolean; tutor: boolean }
export type OnboardingState = {
  setup_done: boolean
  checklist_dismissed: boolean
  /** The account went through the new setup (only those see the Get started list). */
  tracked: boolean
  has_profile: boolean
  steps: OnboardingSteps
}

const doneKey = (userId: string) => `bindit:onboarding:done:${userId}`
const stepKey = (userId: string) => `bindit:onboarding:step:${userId}`
/** Fired after this tab changes the onboarding state, so the Get started list refreshes. */
export const ONBOARDING_CHANGED_EVENT = 'bindit:onboarding-changed'

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable (private mode); the server still has the state.
  }
}

/** 'done': finished or skipped here and saved; 'pending': finished here, not yet saved on the server. */
export function cachedSetup(userId: string): 'done' | 'pending' | null {
  const value = read(doneKey(userId))
  return value === 'done' || value === 'pending' ? value : null
}

export function getOnboarding(accessToken: string, signal?: AbortSignal) {
  return request<OnboardingState>('/api/account/onboarding', { signal, timeoutMs: 8000 }, accessToken)
}

export async function saveOnboarding(accessToken: string, change: { setup_done?: boolean; checklist_dismissed?: boolean }) {
  const state = await request<OnboardingState>('/api/account/onboarding', { method: 'PUT', body: JSON.stringify(change) }, accessToken)
  window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT))
  return state
}

/**
 * Marks the setup finished (or skipped). Remembered here at once, so it is never shown
 * again even if the request fails; a failed save is retried on the next visit.
 */
export function finishSetup(accessToken: string, userId: string) {
  write(doneKey(userId), 'pending')
  write(stepKey(userId), null)
  return saveOnboarding(accessToken, { setup_done: true })
    .then(() => write(doneKey(userId), 'done'))
    .catch(() => undefined)
}

export function rememberSetupDone(userId: string) {
  write(doneKey(userId), 'done')
}

export function savedStep(userId: string): string {
  return read(stepKey(userId)) ?? ''
}

export function saveStep(userId: string, step: string) {
  write(stepKey(userId), step)
}

/*
 * Common high-school classes for the quick picks. Students can type any other name.
 */
export const SUGGESTED_CLASSES = [
  'AP Biology', 'Biology', 'Chemistry', 'AP Chemistry', 'Physics', 'Environmental Science',
  'Algebra 1', 'Geometry', 'Algebra 2', 'Precalculus', 'AP Calculus AB', 'AP Statistics',
  'English', 'AP English Language', 'US History', 'AP US History', 'World History', 'AP Psychology',
  'Spanish', 'Computer Science',
]

export const FIRST_UNIT = 'Unit 1'
export const COURSE_NAME_MAX = 120

/** True when this device's binder already has a course with a unit (the classes step is not needed). */
export function binderHasUnits() {
  return loadNotebook().courses.some((course) => course.units.length > 0)
}

/**
 * Adds the chosen classes to this device's binder, each with a first unit, and opens
 * the first one, so Study shows "add your first notes" instead of an empty page.
 * Classes already in the binder are kept (and get a first unit if they have none).
 */
export function addClassesToBinder(names: string[]) {
  const wanted = names.map((name) => name.trim().slice(0, COURSE_NAME_MAX)).filter(Boolean)
  if (!wanted.length) return
  const notebook = loadNotebook()
  let courses: Course[] = notebook.courses
  for (const name of wanted) {
    setCourseHidden(name, false)
    const index = courses.findIndex((course) => sameName(course.name, name))
    if (index === -1) {
      courses = [...courses, { name, units: [FIRST_UNIT], tone: pickCourseTone(courses) }]
    } else if (!courses[index].units.length) {
      courses = courses.map((course, at) => (at === index ? { ...course, units: [FIRST_UNIT] } : course))
    }
  }
  const first = courses.find((course) => sameName(course.name, wanted[0]))
  saveNotebook({
    ...notebook,
    courses,
    activeCourse: first?.name ?? notebook.activeCourse,
    activeUnit: first?.units[0] ?? notebook.activeUnit,
  })
}
