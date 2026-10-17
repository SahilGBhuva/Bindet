import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useData } from './dataSource'
import { isHeicFile } from './heic'
import { photoNoteName, prepareNotePhoto, type PhotoJob } from './notePhoto'
import type { NotePlace } from './noteUpload'

type NoteNames = readonly { fileName: string }[]

export type NotePhotoOptions = {
  /* Where a photo just taken goes, or null to drop it (the page says why). Read when it is taken. */
  placeFor: () => NotePlace | null
  /* The unit's notes so far, for the page number. */
  notesIn: (place: NotePlace) => NoteNames | Promise<NoteNames>
  /* Sends the prepared photo to its unit; onSent is called once it has finished uploading. */
  upload: (job: PhotoJob, onSent: () => void) => Promise<boolean>
  /* A new photo was taken (clear any earlier message). */
  onStart?: () => void
  /* The photo couldn't be prepared (not an image the browser can read, for one). */
  onPrepareError: (message: string) => void
}

/*
 * "Take a photo of your notes", for Study's Notes tab and Home's Snap notes shortcut:
 * a hidden camera input (open() must run inside the tap, so the input lives on the same
 * screen as the button), then prepare → upload → read, with the stage kept in `photo`.
 */
export function useNotePhoto(options: NotePhotoOptions) {
  const data = useData()
  const input = useRef<HTMLInputElement>(null)
  const [photo, setPhoto] = useState<PhotoJob | null>(null)
  // Each preview URL is released when the next photo replaces it, or when the page closes.
  const photoPreview = photo?.preview
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview) }, [photoPreview])

  function open() {
    input.current?.click()
  }

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const taken = event.target.files?.[0]
    event.target.value = ''
    if (!taken) return
    const place = options.placeFor()
    if (!place) return
    const { course, unit } = place
    options.onStart?.()
    const listed = options.notesIn(place)
    // No preview URL for a photo the browser may not be able to draw (iPhone HEIC): a file chip shows instead.
    const preview = (file: File) => isHeicFile(file) ? '' : URL.createObjectURL(file)
    let name = ''
    if (listed instanceof Promise) {
      // The unit's notes are still being read: show the photo straight away, named once they are in.
      setPhoto({ file: taken, preview: preview(taken), name, course, unit, stage: 'preparing' })
      name = photoNoteName(data.now(), await listed.catch((): NoteNames => []))
      setPhoto((current) => current && current.file === taken ? { ...current, name } : current)
    } else {
      name = photoNoteName(data.now(), listed)
      setPhoto({ file: taken, preview: preview(taken), name, course, unit, stage: 'preparing' })
    }
    let prepared: File
    try {
      prepared = await prepareNotePhoto(taken, name)
    } catch (error) {
      setPhoto((current) => current && { ...current, stage: 'failed' })
      options.onPrepareError(error instanceof Error ? error.message : 'That photo could not be prepared.')
      return
    }
    const job: PhotoJob = { file: prepared, preview: preview(prepared), name, course, unit, stage: 'uploading' }
    setPhoto(job)
    await resend(job)
  }

  /* Sends a prepared photo (again, for Retry). */
  async function resend(job: PhotoJob) {
    setPhoto((current) => current && { ...current, stage: 'uploading' })
    const saved = await options.upload(job, () => setPhoto((current) => current && current.stage === 'uploading' ? { ...current, stage: 'reading' } : current))
    setPhoto((current) => current && { ...current, stage: saved ? 'added' : 'failed' })
  }

  return {
    photo,
    open,
    resend,
    clear: () => setPhoto(null),
    // Spread onto the hidden <input>: the phone's camera, straight to the back lens.
    inputProps: {
      ref: input,
      className: 'ui-file-input',
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      tabIndex: -1,
      'aria-hidden': true,
      onChange: (event: ChangeEvent<HTMLInputElement>) => void onChange(event),
    } as const,
  }
}
