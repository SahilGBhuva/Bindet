import { useState, type FormEvent } from 'react'
import { useData } from '../lib/dataSource'
import { noteDeposit, uploadFailure, COURSE_NAME_MAX, type NotePlace } from '../lib/noteUpload'
import { announceReviewChange } from '../lib/review'
import { notebookWithCourse, notebookWithNextUnit, notesFor, sameName } from '../lib/session'
import { setCourseHidden } from '../lib/studyPrefs'
import { courseInitial } from '../lib/tones'
import type { Notebook, NoteDeposit } from '../lib/types'
import { useNotePhoto } from '../lib/useNotePhoto'
import { Icons } from './Icons'
import { FileThumb } from './FileThumb'

/*
 * Home's "Snap notes" (phones only): one tap opens the camera, and the photo is filed as a
 * note in the course and unit Study has open (the notebook's active course and unit), the
 * same way Study's "Take a photo of your notes" does. With no course yet, a small picker
 * comes first, then "Open camera", so the camera still opens inside a tap.
 *
 * In the landing demo every control here is locked (components/demo/LivePreview.tsx).
 */
export function SnapNotes({ accessToken, notebook, onNotebook }: { accessToken?: string; notebook: Notebook; onNotebook: (next: Notebook) => void }) {
  const data = useData()
  const [picking, setPicking] = useState(false)
  const [newCourse, setNewCourse] = useState('')
  const [failure, setFailure] = useState<{ message: string; retry: boolean } | null>(null)

  const course = notebook.courses.find((item) => item.name === notebook.activeCourse)
  const target: NotePlace | null = course && notebook.activeUnit && course.units.includes(notebook.activeUnit)
    ? { course: course.name, unit: notebook.activeUnit }
    : null

  function save(next: Notebook) {
    try {
      data.saveNotebook(next)
    } catch {
      // Storage can be unavailable; the photo still goes where Home shows.
    }
    onNotebook(next)
  }

  const notePhoto = useNotePhoto({
    placeFor: () => target,
    // Page numbers follow every note in the unit, on any device (this device's own if the server can't say).
    notesIn: (place) => {
      const local = notesFor(data.loadNotebook().deposits, place.course, place.unit)
      return data.listNotes(place.course, place.unit, accessToken).then(
        (listed) => [...local, ...listed.filter((note) => !local.some((item) => item.id === note.id)).map((note) => ({ fileName: note.file_name }))],
        () => local,
      )
    },
    upload: async (job, onSent) => {
      try {
        const uploaded = await data.uploadNote(job.file, job.course, job.unit, accessToken, { onSent })
        const deposit: NoteDeposit = noteDeposit(uploaded, job)
        const current = data.loadNotebook()
        save({ ...current, deposits: [deposit, ...current.deposits.filter((note) => note.id !== deposit.id)] })
        // Flashcards are written in the background; Study shows how that is going.
        void data.generateNoteFlashcards(deposit.id, undefined, accessToken).then(
          (result) => { if (result.cards.length) announceReviewChange() },
          () => undefined,
        )
        return true
      } catch (error) {
        setFailure(uploadFailure(error, 'photo'))
        return false
      }
    },
    onStart: () => setFailure(null),
    onPrepareError: (message) => setFailure({ message, retry: false }),
  })
  const photo = notePhoto.photo
  const busy = photo?.stage === 'preparing' || photo?.stage === 'uploading' || photo?.stage === 'reading'

  function chooseCourse(name: string) {
    let next = notebookWithCourse(data.loadNotebook(), name)
    // A course with no units gets its first one, as Study does.
    if (!next.activeUnit) next = notebookWithNextUnit(next)
    save(next)
  }

  function chooseUnit(unit: string) {
    save({ ...data.loadNotebook(), activeUnit: unit })
  }

  function addCourse(event: FormEvent) {
    event.preventDefault()
    const name = newCourse.trim().slice(0, COURSE_NAME_MAX)
    if (!name) return
    const existing = notebook.courses.find((item) => sameName(item.name, name))
    if (!existing && !data.sandboxed) setCourseHidden(name, false)
    chooseCourse(existing?.name ?? name)
    setNewCourse('')
  }

  function openCamera() {
    setPicking(false)
    notePhoto.open()
  }

  const showPicker = picking && !busy

  return (
    <section className="home-snap ui-tone--blue" aria-labelledby="home-snap-title">
      <input {...notePhoto.inputProps} />
      <h2 className="sr-only" id="home-snap-title">Snap notes</h2>

      {photo && !showPicker ? (
        <div className={`home-snap__job is-${photo.stage}`}>
          {photo.preview ? (
            <img
              src={photo.preview}
              alt=""
              width="52"
              height="52"
              decoding="async"
              onError={(event) => { event.currentTarget.style.visibility = 'hidden' }}
            />
          ) : <FileThumb name={photo.file.name || 'photo'} size={52} />}
          <div className="home-snap__text">
            <b>
              {photo.stage === 'preparing' ? 'Preparing the photo…'
                : photo.stage === 'uploading' ? 'Uploading…'
                  : photo.stage === 'reading' ? 'Reading your notes…'
                    : photo.stage === 'added' ? `Added to ${photo.course} · ${photo.unit}.`
                      : 'That photo wasn’t added.'}
            </b>
            <span>
              {photo.stage === 'added' ? 'Flashcards are on the way.'
                : photo.stage === 'failed' ? failure?.message ?? 'Something went wrong. Try taking it again.'
                  : `${photo.name || 'Your photo'} · ${photo.course} · ${photo.unit}`}
            </span>
          </div>
          {busy ? <span className="ui-spinner" aria-hidden="true" /> : null}
          {photo.stage === 'added' || photo.stage === 'failed' ? (
            <div className="home-snap__actions">
              <button className="ui-button ui-button--primary home-snap__again" type="button" onClick={openCamera} disabled={!target}>
                {Icons.camera}
                {photo.stage === 'added' ? 'Add another page' : 'Take it again'}
              </button>
              {photo.stage === 'failed' && failure?.retry ? (
                <button className="ui-button" type="button" onClick={() => void notePhoto.resend(photo)}>Send again</button>
              ) : (
                <a className="ui-link home-snap__view" href="#tools">View notes</a>
              )}
            </div>
          ) : null}
        </div>
      ) : showPicker ? null : (
        <button
          className="ui-button ui-button--primary home-snap__button"
          type="button"
          // With a course and unit to file into, the camera opens in this tap; otherwise pick one first.
          onClick={target ? openCamera : () => setPicking(true)}
        >
          {Icons.camera}
          Snap notes
        </button>
      )}

      {target && !showPicker ? (
        <p className="home-snap__where">
          <span>Goes to <b>{target.course}</b> · {target.unit}</span>
          <button className="home-snap__change" type="button" onClick={() => setPicking(true)} disabled={busy}>Change</button>
        </p>
      ) : !showPicker ? (
        <p className="home-snap__where">A photo of your notes becomes flashcards.</p>
      ) : null}

      {showPicker ? (
        <div className="home-snap__picker">
          <p className="home-snap__ask">{notebook.courses.length ? 'Which course are these notes for?' : 'Add a course for your notes'}</p>
          {notebook.courses.length ? (
            <div className="home-snap__choices" role="group" aria-label="Course">
              {notebook.courses.map((item) => (
                <button
                  key={item.name}
                  className="home-snap__choice"
                  type="button"
                  aria-pressed={item.name === notebook.activeCourse}
                  onClick={() => chooseCourse(item.name)}
                >
                  <span className="ui-course-mark ui-course-mark--sm" style={{ ['--course' as string]: item.tone }} aria-hidden="true">{courseInitial(item.name)}</span>
                  {item.name}
                </button>
              ))}
            </div>
          ) : null}
          {course && course.units.length > 1 ? (
            <div className="home-snap__choices" role="group" aria-label={`Unit in ${course.name}`}>
              {course.units.map((unit) => (
                <button key={unit} className="home-snap__choice" type="button" aria-pressed={unit === notebook.activeUnit} onClick={() => chooseUnit(unit)}>
                  {unit}
                </button>
              ))}
            </div>
          ) : null}
          <form className="home-snap__new" onSubmit={addCourse}>
            <input
              className="ui-input"
              value={newCourse}
              onChange={(event) => setNewCourse(event.target.value)}
              placeholder={notebook.courses.length ? 'Or a new course' : 'Course name, like AP Biology'}
              maxLength={COURSE_NAME_MAX}
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="done"
              aria-label="New course name"
            />
            <button className="ui-button" type="submit" disabled={!newCourse.trim()}>Add</button>
          </form>
          {target ? (
            <>
              <p className="home-snap__where"><span>Goes to <b>{target.course}</b> · {target.unit}</span></p>
              <div className="home-snap__go">
                <button className="ui-button ui-button--primary home-snap__button" type="button" onClick={openCamera}>
                  {Icons.camera}
                  Open camera
                </button>
                <button className="ui-button ui-button--ghost" type="button" onClick={() => setPicking(false)}>Cancel</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {photo?.stage === 'uploading' ? 'Uploading your photo.'
          : photo?.stage === 'reading' ? 'Reading your notes.'
            : photo?.stage === 'added' ? `Added to ${photo.course}, ${photo.unit}. Flashcards are on the way.`
              : photo?.stage === 'failed' ? `That photo wasn’t added. ${failure?.message ?? ''}`
                : ''}
      </p>
    </section>
  )
}
