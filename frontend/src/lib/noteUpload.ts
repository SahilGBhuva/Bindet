import { ApiError, type UploadedNote } from './api'
import type { NoteDeposit } from './types'

/*
 * Sending notes to a unit, shared by Study's Notes tab and Home's "Snap notes" shortcut:
 * how a failure is worded for a student, and how a saved note is kept in this device's notebook.
 */

export type NoteSource = 'file' | 'paste' | 'photo'
export type NotePlace = { course: string; unit: string }

// The server's limits: course names up to 120 characters and unit names up to 160.
export const COURSE_NAME_MAX = 120
export const UNIT_NAME_MAX = 160
export const NAME_TOO_LONG_MESSAGE = `Course names can be up to ${COURSE_NAME_MAX} characters and unit names up to ${UNIT_NAME_MAX}. Pick a shorter name.`

/* A name the server rejected for its length (422), or the request otherwise invalid. */
export function nameRejected(error: unknown) {
  return error instanceof ApiError && error.status === 422
}

/*
 * Why a note couldn't be added, in words a student can act on. The server rejects a file it
 * can't use with a 400 and a short reason (wrong type, empty, unreadable, no text); sending
 * the same file again won't help, so those get no "Try again".
 */
export function uploadFailure(error: unknown, source: NoteSource): { message: string; retry: boolean } {
  if (nameRejected(error)) return { message: NAME_TOO_LONG_MESSAGE, retry: false }
  const what = source === 'paste' ? 'Those notes' : source === 'photo' ? 'That photo' : 'That file'
  if (error instanceof ApiError && error.status === 413) return { message: 'Notes must be 4 MB or smaller. Try a smaller file, or split it into parts.', retry: false }
  if (error instanceof ApiError && error.status === 400) {
    const reason = error.message
    if (/^Use a /.test(reason)) return { message: 'bindet can’t read that kind of file. Use a PDF, Word document (DOCX), text file (TXT, Markdown, CSV or JSON), or a photo (PNG, JPG or WebP).', retry: false }
    if (/empty/i.test(reason)) return { message: `${what} ${source === 'paste' ? 'are' : 'is'} empty. Pick a file with your notes in it.`, retry: false }
    if (/no readable text/i.test(reason)) return { message: `bindet couldn’t find any text in ${what.toLowerCase()}. If it’s a scan, try Take a photo of your notes, or paste the text instead.`, retry: false }
    if (/could not read/i.test(reason)) return { message: `bindet couldn’t open ${what.toLowerCase()}. It may be damaged or password-protected. Try saving or exporting it again.`, retry: false }
    return { message: /[.!?]$/.test(reason) ? reason : `${reason}.`, retry: false }
  }
  return { message: error instanceof Error && error.message ? error.message : `${what} couldn’t be added. Try again.`, retry: true }
}

/* A saved note as this device's notebook keeps it, filed under `place` (the page's spelling of the names). */
export function noteDeposit(uploaded: UploadedNote, place: NotePlace): NoteDeposit {
  return {
    id: uploaded.id,
    // The server trims names; keep the page's spelling so the note shows in its unit.
    course: place.course,
    unit: place.unit,
    fileName: uploaded.file_name,
    createdAt: uploaded.created_at,
    status: uploaded.status,
    textPreview: uploaded.text_preview,
  }
}
