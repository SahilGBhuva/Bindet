/*
 * Pure helpers for "Download PDF": the printable documents (study guides, flashcards,
 * practice tests) are laid out by components/print and saved through the browser's own
 * print window ("Save as PDF"), so no PDF library is needed. Kept free of the DOM so the
 * pagination rules are unit-tested.
 */

/* Cut-out flashcards: 2 columns x 4 rows on each sheet. */
export const CARDS_PER_PAGE = 8
export const CARD_COLUMNS = 2

/* A sheet of cut-out cards: the fronts, and the backs in the order that lines up when printed double-sided. */
export type CardSheet<T> = { fronts: (T | null)[]; backs: (T | null)[] }

/* Splits a list into runs of `size` (the last one may be shorter). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive whole number')
  const runs: T[][] = []
  for (let index = 0; index < items.length; index += size) runs.push(items.slice(index, index + size))
  return runs
}

/*
 * The back of a sheet, mirrored left to right: paper flipped on its long edge puts the
 * left column of the front behind the right column of the back, so each row is reversed.
 * Rows stay in order. A short last row is padded first, so a card never moves to another row.
 */
export function mirrorRows<T>(slots: readonly (T | null)[], columns: number = CARD_COLUMNS): (T | null)[] {
  if (!Number.isInteger(columns) || columns < 1) throw new RangeError('columns must be a positive whole number')
  const padded = [...slots]
  while (padded.length % columns) padded.push(null)
  return chunk(padded, columns).flatMap((row) => [...row].reverse())
}

/*
 * Cards split into sheets: each sheet's fronts are padded with empty slots to a full page
 * (so the cut grid and the card positions are the same on every sheet), and its backs are
 * the same cards mirrored for double-sided printing.
 */
export function cutoutSheets<T>(cards: readonly T[], perPage: number = CARDS_PER_PAGE, columns: number = CARD_COLUMNS): CardSheet<T>[] {
  if (perPage % columns) throw new RangeError('perPage must be a multiple of columns')
  return chunk(cards, perPage).map((run) => {
    const fronts: (T | null)[] = [...run]
    while (fronts.length < perPage) fronts.push(null)
    return { fronts, backs: mirrorRows(fronts, columns) }
  })
}

// Characters that file systems refuse, or that browsers replace in a suggested file name.
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|]+/g
const isControl = (char: string) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127

/*
 * The print window suggests the page's <title> as the PDF's file name, so the document
 * gets a clean one while it prints: "Photosynthesis – Study guide".
 */
export function printFileTitle(title: string, kind: string) {
  const clean = (value: string) => [...value].map((char) => (isControl(char) ? ' ' : char)).join('').replace(UNSAFE_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const label = clean(kind)
  // "Study guide: Photosynthesis" (the default title) becomes "Photosynthesis – Study guide".
  let raw = title.trim()
  if (label && raw.toLowerCase().startsWith(`${label.toLowerCase()}:`)) raw = raw.slice(label.length + 1)
  const name = clean(raw).slice(0, 90).trim()
  if (!name) return label || 'bindet'
  if (!label || name.toLowerCase() === label.toLowerCase()) return name
  return `${name} – ${label}`
}

/* "Course · Unit" (or "Course · Whole course" when there is no unit). */
export function scopeLine(course: string, unit: string | null | undefined) {
  return [course.trim(), unit?.trim() || 'Whole course'].filter(Boolean).join(' · ')
}

const printDateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

export function printDate(time: number) {
  return Number.isFinite(time) ? printDateFormat.format(time) : ''
}

/* The letter in front of a multiple-choice option: A, B, C… */
export function choiceLetter(index: number) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1)
}

/* The letter of the correct option, when the answer is one of the choices. */
export function correctChoice(choices: readonly string[], answer: string | undefined) {
  if (!answer) return ''
  const exact = choices.indexOf(answer)
  const index = exact >= 0 ? exact : choices.findIndex((choice) => choice.trim().toLowerCase() === answer.trim().toLowerCase())
  return index >= 0 ? choiceLetter(index) : ''
}

/*
 * The font scale that fits content of `natural` width (or height) into `available`,
 * between `min` and 1. Used to shrink long equations and long card text for paper.
 */
export function fitScale(available: number, natural: number, min = 0.5) {
  if (!(available > 0) || !(natural > available)) return 1
  return Math.max(min, Math.floor((available / natural) * 1000) / 1000)
}

/* iPhone and iPad (iPadOS reports itself as a Mac with a touch screen): saving a PDF goes through Share. */
export function isAppleMobile(platform: { userAgent: string; platform?: string; maxTouchPoints?: number }) {
  if (/iPhone|iPad|iPod/i.test(platform.userAgent)) return true
  return platform.platform === 'MacIntel' && (platform.maxTouchPoints ?? 0) > 1
}

/* The hint shown in the options sheet until the student has made a PDF once. */
export function printHint(appleMobile: boolean) {
  return appleMobile ? 'Tap Share, then Save to Files.' : 'Choose “Save as PDF” in the print window.'
}

/* Lines to leave under a short-answer question: more for longer prompts. */
export function answerLineCount(prompt: string) {
  return prompt.length > 160 ? 3 : 2
}
