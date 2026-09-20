import type { Course, Notebook, NoteDeposit, Session } from './types'

const STORAGE_KEY = 'bindit-study-session'
const STUDENT_ID_KEY = 'bindit-student-id'
const NOTEBOOK_KEY = 'bindit-notebook'
const AVATAR_KEY = 'bindit-avatar'

const LEGACY_KEYS = {
  session: 'cac-study-session',
  studentId: 'numi-student-id',
  notebook: 'numi-notebook',
  avatar: 'numi-avatar',
} as const

function readMigrated(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key)
  if (current !== null) return current
  const legacy = localStorage.getItem(legacyKey)
  if (legacy === null) return null
  localStorage.setItem(key, legacy)
  localStorage.removeItem(legacyKey)
  return legacy
}

const emptyNotebook: Notebook = {
  courses: [{ name: 'Biology', units: [], tone: '#0b58f5' }],
  activeCourse: 'Biology',
  activeUnit: '',
  deposits: [],
}

/*
 * Saturated course colors, one per palette hue (blue, violet, green, orange, pink,
 * teal, amber). Each is dark enough for white text on top (>= 5.3:1).
 */
export const COURSE_TONES = ['#0b58f5', '#7c3aed', '#0e7a3d', '#b74509', '#c12269', '#0a766d', '#a15804']

// Muted tones saved in notebooks before the color refresh map to the same slot in the new palette.
const LEGACY_TONES: Record<string, string> = {
  '#2a6ea8': COURSE_TONES[0],
  '#8a4aad': COURSE_TONES[1],
  '#2f8f5c': COURSE_TONES[2],
  '#c48a28': COURSE_TONES[6],
  '#c45e4e': COURSE_TONES[3],
  '#1f8a9c': COURSE_TONES[5],
  '#6e4aa0': COURSE_TONES[4],
}

const PINNED_TONES: Record<string, string> = {
  Biology: COURSE_TONES[0],
  Chemistry: COURSE_TONES[1],
}

function hashTone(name: string) {
  let n = 0
  for (let i = 0; i < name.length; i += 1) n = (n * 31 + name.charCodeAt(i)) >>> 0
  return COURSE_TONES[n % COURSE_TONES.length]
}

export function withCourseTones(input: Course[]): Course[] {
  const courses = input.map((course) => {
    const upgraded = course.tone ? LEGACY_TONES[course.tone.toLowerCase()] : undefined
    return upgraded ? { ...course, tone: upgraded } : course
  })
  const taken = new Set(courses.map((course) => course.tone).filter(Boolean) as string[])
  return courses.map((course, index) => {
    if (course.tone) return course
    const preferred = PINNED_TONES[course.name] ?? hashTone(course.name)
    const tone = !taken.has(preferred)
      ? preferred
      : (COURSE_TONES.find((item) => !taken.has(item)) ?? COURSE_TONES[index % COURSE_TONES.length])
    taken.add(tone)
    return { ...course, tone }
  })
}

export function pickCourseTone(courses: Course[]): string {
  const taken = new Set(courses.map((course) => course.tone).filter(Boolean) as string[])
  return COURSE_TONES.find((item) => !taken.has(item)) ?? COURSE_TONES[courses.length % COURSE_TONES.length]
}

export function getStudentId(): string {
  const savedId = readMigrated(STUDENT_ID_KEY, LEGACY_KEYS.studentId)
  if (savedId) return savedId
  const studentId = crypto.randomUUID()
  localStorage.setItem(STUDENT_ID_KEY, studentId)
  return studentId
}

export function loadNotebook(): Notebook {
  const raw = readMigrated(NOTEBOOK_KEY, LEGACY_KEYS.notebook)
  if (!raw) return emptyNotebook
  try {
    const parsed = JSON.parse(raw) as Notebook
    if (!Array.isArray(parsed.courses)) return emptyNotebook
    const courses: Course[] = withCourseTones(
      parsed.courses.map((course) => (typeof course === 'string' ? { name: course, units: [] } : course)),
    )
    if (courses.length === 0) {
      return {
        courses: [],
        activeCourse: '',
        activeUnit: '',
        deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [],
      }
    }
    return {
      courses,
      activeCourse: parsed.activeCourse || courses[0].name,
      activeUnit: parsed.activeUnit || '',
      deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [],
    }
  } catch {
    return emptyNotebook
  }
}

export function saveNotebook(notebook: Notebook): void {
  localStorage.setItem(NOTEBOOK_KEY, JSON.stringify(notebook))
}

export function unitsFor(courses: Course[], courseName: string): string[] {
  return courses.find((course) => course.name === courseName)?.units ?? []
}

export function notesFor(deposits: NoteDeposit[], course: string, unit: string): NoteDeposit[] {
  return deposits.filter((item) => item.course === course && item.unit === unit)
}

export function loadAvatar(): string {
  return readMigrated(AVATAR_KEY, LEGACY_KEYS.avatar) ?? ''
}

export function saveAvatar(dataUrl: string): void {
  localStorage.setItem(AVATAR_KEY, dataUrl)
}

export function fileToCourseImageDataUrl(file: File): Promise<string> {
  return fileToCoverDataUrl(file, 480, 640)
}

function fileToCoverDataUrl(file: File, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read image'))
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(String(reader.result))
          return
        }
        const scale = Math.max(width / image.width, height / image.height)
        const dw = image.width * scale
        const dh = image.height * scale
        ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh)
        resolve(canvas.toDataURL('image/jpeg', 0.84))
      }
      image.onerror = () => reject(new Error('Could not load image'))
      image.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export function fileToAvatarDataUrl(file: File): Promise<string> {
  return fileToCoverDataUrl(file, 256, 256)
}

export function createDraftSession(topic: string, notes: string): Session {
  return {
    topic: topic.trim(),
    notes: notes.trim(),
    questions: [],
    attempts: [],
    score: null,
    streak: 0,
    xp: 0,
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function loadSession(): Session | null {
  const raw = readMigrated(STORAGE_KEY, LEGACY_KEYS.session)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}
