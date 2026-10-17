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
  // A photo still being prepared when the page closes must not leave its preview URL behind.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const jobs = useRef(0)
  // One photo at a time: a second one taken while the first is being prepared or sent
  // would be numbered from the same notes and get the same page number.
  const inFlight = useRef(false)
  const busy = photo?.stage === 'preparing' || photo?.stage === 'uploading' || photo?.stage === 'reading'

  /* Changes the job only if it is still the one shown. */
  function update(id: number, change: (job: PhotoJob) => PhotoJob) {
    setPhoto((current) => current && current.id === id ? change(current) : current)
  }

  function open() {
    if (inFlight.current) return
    input.current?.click()
  }

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const taken = event.target.files?.[0]
    event.target.value = ''
    if (!taken || inFlight.current) return
    const place = options.placeFor()
    if (!place) return
    const { course, unit } = place
    const id = ++jobs.current
    inFlight.current = true
    try {
      options.onStart?.()
      const listed = options.notesIn(place)
      // No preview URL for a photo the browser may not be able to draw (iPhone HEIC): a file chip shows instead.
      const preview = (file: File) => isHeicFile(file) ? '' : URL.createObjectURL(file)
      let name = ''
      if (listed instanceof Promise) {
        // The unit's notes are still being read: show the photo straight away, named once they are in.
        setPhoto({ id, file: taken, preview: preview(taken), name, course, unit, stage: 'preparing' })
        name = photoNoteName(data.now(), await listed.catch((): NoteNames => []))
        update(id, (current) => ({ ...current, name }))
      } else {
        name = photoNoteName(data.now(), listed)
        setPhoto({ id, file: taken, preview: preview(taken), name, course, unit, stage: 'preparing' })
      }
      let prepared: File
      try {
        prepared = await prepareNotePhoto(taken, name)
      } catch (error) {
        update(id, (current) => ({ ...current, stage: 'failed' }))
        options.onPrepareError(error instanceof Error ? error.message : 'That photo could not be prepared.')
        return
      }
      // The page may have closed while the photo was prepared: the photo is still sent, but
      // no preview URL is made, since nothing would ever show or release it.
      const job: PhotoJob = { id, file: prepared, preview: mounted.current ? preview(prepared) : '', name, course, unit, stage: 'uploading' }
      setPhoto(job)
      await send(job)
    } finally {
      inFlight.current = false
    }
  }

  async function send(job: PhotoJob) {
    update(job.id, (current) => ({ ...current, stage: 'uploading' }))
    const saved = await options.upload(job, () => update(job.id, (current) => current.stage === 'uploading' ? { ...current, stage: 'reading' } : current))
    update(job.id, (current) => ({ ...current, stage: saved ? 'added' : 'failed' }))
  }

  /* Sends a prepared photo again (Retry). */
  async function resend(job: PhotoJob) {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await send(job)
    } finally {
      inFlight.current = false
    }
  }

  return {
    photo,
    /* A photo is being prepared, sent or read: the camera button should be disabled. */
    busy,
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
