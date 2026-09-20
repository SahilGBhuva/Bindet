import { buildCoursePulse, type UnitJudgment } from '../../lib/progress'
import { createDemoData, DEMO_COURSES, DEMO_SESSION, DEMO_STUDENT } from '../demo/demoData'

/*
 * Content for the landing page's story sections. It all comes from the same
 * sandboxed demo student as the live demo, so the page tells one consistent
 * story and never shows a number the product did not compute.
 */

export type StoryUnit = {
  course: string
  tone: string
  unit: string
  file: string
  cards: readonly (readonly [string, string])[]
  questions: readonly { q: string; choices: readonly string[]; answer: string; why: string; hint: string }[]
}

export function storyUnit(course: string, unit: string): StoryUnit {
  const found = DEMO_COURSES.find((item) => item.name === course)
  const content = found?.units[unit]
  if (!found || !content) throw new Error(`Unknown demo unit: ${course} / ${unit}`)
  return { course, tone: found.tone, unit, file: content.file, cards: content.cards, questions: content.questions }
}

export const COURSE_TONE: Record<string, string> = Object.fromEntries(DEMO_COURSES.map((course) => [course.name, course.tone]))

export type MasteryNode = UnitJudgment & { course: string; tone: string }

/* Unit mastery exactly as the Progress page computes it for the demo student. */
export function demoMastery(): { course: string; tone: string; mastery: number; next: string; units: MasteryNode[] }[] {
  const data = createDemoData(() => undefined)
  const notebook = data.loadNotebook()
  const attempts = data.loadUnitAttempts()
  const topics = data.getCachedProgress(DEMO_STUDENT)?.topics ?? []
  return notebook.courses.map((course) => {
    const pulse = buildCoursePulse(course, notebook.deposits, attempts, topics)
    const tone = course.tone ?? '#0b58f5'
    return { course: course.name, tone, mastery: pulse.mastery, next: pulse.recommended, units: pulse.units.map((unit) => ({ ...unit, course: course.name, tone })) }
  })
}

export function demoSocial() {
  const data = createDemoData(() => undefined)
  const hub = data.getCachedFriends(DEMO_SESSION.access_token)
  const stats = data.getCachedProgress(DEMO_STUDENT)
  return {
    leaderboard: hub?.leaderboard ?? [],
    quest: hub?.quests[0] ?? null,
    accuracy: stats?.accuracy ?? 0,
    streak: stats?.login_streak ?? 0,
    xp: stats?.total_xp ?? 0,
  }
}
