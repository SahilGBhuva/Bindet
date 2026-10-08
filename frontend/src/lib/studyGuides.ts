import { request } from './api'

/*
 * Study materials Otto makes from the student's own notes (study guides, summaries, cheat
 * sheets, vocabulary lists, practice problems, timelines). The server writes and validates
 * them as structured sections; the app renders that text (and math) itself, never HTML.
 */

export type GuideKind = 'study_guide' | 'summary' | 'cheat_sheet' | 'vocabulary' | 'practice' | 'timeline'
export type GuideTerm = { term: string; definition: string }
export type GuideItem = { question: string; answer: string }
export type GuideSection = { heading: string; bullets: string[]; terms: GuideTerm[]; items: GuideItem[] }

export type StudyGuideSummary = {
  id: string
  course: string
  // null: the whole course.
  unit: string | null
  kind: GuideKind
  title: string
  instructions: string
  note_count: number
  section_count: number
  entry_count: number
  created_at: string
  updated_at: string
}

/*
 * source: how the server answered. generated / regenerated: the AI wrote it; cached: the same
 * notes made it before (no AI); saved: the student's own guide for these notes, shown again;
 * unchanged: Regenerate found the notes as they were.
 */
export type StudyGuide = StudyGuideSummary & {
  sections: GuideSection[]
  source?: 'generated' | 'regenerated' | 'cached' | 'saved' | 'unchanged'
}

export type StudyGuideList = { guides: StudyGuideSummary[]; note_count: number; can_timeline: boolean }

export type StudyGuideOptions = {
  course: string
  unit: string | null
  kind: GuideKind
  instructions?: string
  // Ask the AI for a new version instead of showing the saved one for these notes.
  fresh?: boolean
}

// One model call writes a guide; the budget sits above the server's own 45 s model timeout.
export const GUIDE_TIMEOUT_MS = 75_000

export const GUIDE_KINDS: { id: GuideKind; label: string; tone: string; blurb: string }[] = [
  { id: 'study_guide', label: 'Study guide', tone: 'blue', blurb: 'Key ideas, definitions, worked examples, common mistakes and likely test questions.' },
  { id: 'summary', label: 'Summary', tone: 'violet', blurb: 'An outline of the main topics, in order.' },
  { id: 'cheat_sheet', label: 'Cheat sheet', tone: 'orange', blurb: 'One dense page of the most testable facts.' },
  { id: 'vocabulary', label: 'Vocabulary list', tone: 'green', blurb: 'Each key term with its definition from your notes.' },
  { id: 'practice', label: 'Practice problems', tone: 'pink', blurb: 'Problems with worked answers, hidden until you reveal them.' },
  { id: 'timeline', label: 'Timeline', tone: 'teal', blurb: 'The dated events in your notes, in order.' },
]

export function guideKind(kind: string) {
  return GUIDE_KINDS.find((item) => item.id === kind) ?? GUIDE_KINDS[0]
}

export function listStudyGuides(course: string, unit: string | null, accessToken?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ course })
  if (unit !== null) query.set('unit', unit)
  return request<StudyGuideList>(`/api/study-guides?${query}`, { signal }, accessToken)
}

export function getStudyGuide(guideId: string, accessToken?: string, signal?: AbortSignal) {
  return request<StudyGuide>(`/api/study-guides/${encodeURIComponent(guideId)}`, { signal }, accessToken)
}

/* Writes study material from the unit's (or course's) notes, or shows the saved one again. */
export function createStudyGuide(options: StudyGuideOptions, accessToken?: string, signal?: AbortSignal) {
  return request<StudyGuide>('/api/study-guides', {
    method: 'POST',
    body: JSON.stringify({
      course: options.course,
      unit: options.unit ?? undefined,
      kind: options.kind,
      instructions: options.instructions?.trim() || undefined,
      fresh: Boolean(options.fresh),
    }),
    signal,
    timeoutMs: GUIDE_TIMEOUT_MS,
  }, accessToken)
}

/* A new version from the notes as they are now ("unchanged" when they haven't changed, unless fresh). */
export function regenerateStudyGuide(guideId: string, fresh: boolean, accessToken?: string, signal?: AbortSignal) {
  return request<StudyGuide>(`/api/study-guides/${encodeURIComponent(guideId)}/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ fresh }),
    signal,
    timeoutMs: GUIDE_TIMEOUT_MS,
  }, accessToken)
}

export function renameStudyGuide(guideId: string, title: string, accessToken?: string) {
  return request<StudyGuide>(`/api/study-guides/${encodeURIComponent(guideId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  }, accessToken)
}

export function deleteStudyGuide(guideId: string, accessToken?: string) {
  return request<{ deleted: boolean }>(`/api/study-guides/${encodeURIComponent(guideId)}`, { method: 'DELETE' }, accessToken)
}

/* Saves the guide (once) as a note in its unit, for "Make flashcards from this". */
export function saveStudyGuideAsNote(guideId: string, unit: string | undefined, accessToken?: string) {
  return request<{ id: string; course: string; unit: string; file_name: string; created: boolean }>(
    `/api/study-guides/${encodeURIComponent(guideId)}/note`,
    { method: 'POST', body: JSON.stringify(unit ? { unit } : {}) },
    accessToken,
  )
}

/* The guide as Markdown (Download) or plain text (Copy), built on this device. */
export function guideMarkdown(guide: Pick<StudyGuide, 'title' | 'sections' | 'course' | 'unit' | 'kind'>) {
  const lines = [`# ${guide.title}`, '', `_${guideKind(guide.kind).label} · ${guide.unit ?? 'Whole course'} · ${guide.course} · made by Otto from your notes in bindet_`, '']
  for (const section of guide.sections) {
    lines.push(`## ${section.heading}`, '')
    for (const bullet of section.bullets) lines.push(`- ${bullet}`)
    for (const term of section.terms) lines.push(`- **${term.term}**: ${term.definition}`)
    section.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.question.replace(/\n/g, ' ')}`, '', `   **Answer:** ${item.answer.replace(/\n/g, '\n   ')}`, '')
    })
    lines.push('')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function guidePlainText(guide: Pick<StudyGuide, 'title' | 'sections'>) {
  const lines = [guide.title, '']
  for (const section of guide.sections) {
    lines.push(section.heading.toUpperCase())
    for (const bullet of section.bullets) lines.push(`• ${bullet}`)
    for (const term of section.terms) lines.push(`• ${term.term}: ${term.definition}`)
    section.items.forEach((item, index) => lines.push(`${index + 1}. ${item.question}`, `   Answer: ${item.answer.replace(/\n/g, '\n   ')}`))
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

export function guideFileName(title: string, extension: 'md' | 'txt') {
  const base = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase().slice(0, 60) || 'study-guide'
  return `${base}.${extension}`
}

/* A link Otto's chat card and the guide list use: Study opens the guide from it. */
export function guideHash(guideId: string) {
  return `#tools?guide=${encodeURIComponent(guideId)}`
}

/* "guide:<id>:<kind>" on one of Otto's messages: the saved guide it made. */
export function guideFromAttachment(attachment: string): { id: string; kind: GuideKind } | null {
  const match = /^guide:([0-9a-f-]{36}):([a-z_]+)$/.exec(attachment)
  return match ? { id: match[1], kind: guideKind(match[2]).id } : null
}
