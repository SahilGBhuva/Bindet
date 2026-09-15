import { useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { analyzeAnswer, deleteNote, generateFlashcards, generateQuestion, uploadNote, type AnswerResult, type Flashcard, type GeneratedQuestion, type Topic } from '../lib/api'
import { recordUnitAttempt } from '../lib/progress'
import {
  fileToCourseImageDataUrl,
  getStudentId,
  loadNotebook,
  notesFor,
  pickCourseTone,
  saveNotebook,
  unitsFor,
  withCourseTones,
} from '../lib/session'
import type { Course, NoteDeposit } from '../lib/types'
import { courseInitial } from '../lib/tones'
import './Tools.css'

type ToolView = 'scan' | 'cards' | 'quiz'

const QUIZ_TOPICS: { id: Topic; label: string }[] = [
  { id: 'mixed', label: 'Mixed' },
  { id: 'addition', label: 'Addition' },
  { id: 'subtraction', label: 'Subtraction' },
  { id: 'multiplication', label: 'Multiplication' },
  { id: 'division', label: 'Division' },
]

const QUIZ_LEVELS = [
  { id: 1, label: 'Level 1' },
  { id: 2, label: 'Level 2' },
  { id: 3, label: 'Level 3' },
]

const VIEWS: { id: ToolView; label: string }[] = [
  { id: 'scan', label: 'Notes' },
  { id: 'cards', label: 'Flashcards' },
  { id: 'quiz', label: 'Quiz' },
]

function courseTone(course: { name: string; tone?: string }) {
  return course.tone ?? withCourseTones([{ name: course.name, units: [] }])[0].tone ?? '#0b58f5'
}

function CourseMark({ course, size = 'sm' }: { course: Course; size?: 'sm' | 'lg' }) {
  if (course.image) return <img className={`tools__thumb tools__thumb--${size}`} src={course.image} alt="" />
  return (
    <span className={`ui-course-mark ui-course-mark--${size}`} style={{ ['--course' as string]: courseTone(course) }} aria-hidden="true">
      {courseInitial(course.name)}
    </span>
  )
}

function GripMark() {
  return (
    <svg className="tools__grip" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="7" r="1.4" />
      <circle cx="15" cy="7" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="17" r="1.4" />
      <circle cx="15" cy="17" r="1.4" />
    </svg>
  )
}

function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg className="tools__chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === 'up' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

export function Tools({ accessToken }: { accessToken?: string }) {
  const [notebook, setNotebook] = useState(() => {
    const loaded = loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [addingCourse, setAddingCourse] = useState(false)
  const [newCourse, setNewCourse] = useState('')
  const [newUnit, setNewUnit] = useState('')
  const [addingUnit, setAddingUnit] = useState(false)
  const [renamingUnit, setRenamingUnit] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [renamingCourse, setRenamingCourse] = useState('')
  const [courseRenameDraft, setCourseRenameDraft] = useState('')
  const [menuCourse, setMenuCourse] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [pastedNotes, setPastedNotes] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [removingNoteId, setRemovingNoteId] = useState('')
  const [notice, setNotice] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [cardIndex, setCardIndex] = useState(0)
  const [cardFlipped, setCardFlipped] = useState(false)
  const [quizTopic, setQuizTopic] = useState<Topic>('mixed')
  const [quizDifficulty, setQuizDifficulty] = useState(1)
  const [quizQuestion, setQuizQuestion] = useState<GeneratedQuestion | null>(null)
  const [quizAnswer, setQuizAnswer] = useState('')
  const [quizResult, setQuizResult] = useState<AnswerResult | null>(null)
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizError, setQuizError] = useState('')
  const [deck, setDeck] = useState<{ key: string; cards: Flashcard[] } | null>(null)
  const [cardsBusy, setCardsBusy] = useState(false)
  const [cardsError, setCardsError] = useState('')
  const [cardsRequest, setCardsRequest] = useState(0)
  const [panelFn, setPanelFn] = useState<ToolView>('scan')
  const [orderOpen, setOrderOpen] = useState(false)
  const [orderDrag, setOrderDrag] = useState('')
  const [lookCourse, setLookCourse] = useState('')
  const [lookBusy, setLookBusy] = useState(false)
  const [lookHint, setLookHint] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const courseImageInput = useRef<HTMLInputElement>(null)
  const orderDragIndex = useRef(-1)
  const menuRef = useRef<HTMLDivElement>(null)
  const studentId = useRef(getStudentId())
  // AI generation is rate limited per day, so generated content is only requested
  // when what it depends on changes, never just because the user switched views.
  const pendingDeckKey = useRef('')
  const latestDeckKey = useRef('')
  const loadedQuizKey = useRef('')
  const quizSequence = useRef(0)

  const courses = notebook.courses
  const activeCourse = notebook.activeCourse
  const activeUnit = notebook.activeUnit
  const units = unitsFor(courses, activeCourse)
  const current = courses.find((course) => course.name === activeCourse)
  const looking = courses.find((course) => course.name === lookCourse) ?? current
  const unitNotes = notesFor(notebook.deposits, activeCourse, activeUnit)
  const courseNoteCount = notebook.deposits.filter((note) => note.course === activeCourse).length
  const deckKey = `${activeCourse}|${activeUnit}|${unitNotes.length}`
  latestDeckKey.current = deckKey
  const cards = deck?.key === deckKey ? deck.cards : []
  const card = cards.length ? cards[cardIndex % cards.length] : null
  const quizKey = `${activeCourse}|${activeUnit}|${unitNotes.length ? `notes:${unitNotes.length}` : quizTopic}|${quizDifficulty}`

  useEffect(() => {
    saveNotebook(notebook)
  }, [notebook])

  useEffect(() => {
    setNotebook((current) => {
      if (current.courses.every((course) => course.tone)) return current
      return { ...current, courses: withCourseTones(current.courses) }
    })
  }, [])

  useEffect(() => {
    if (!orderOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOrderOpen(false)
      setOrderDrag('')
      orderDragIndex.current = -1
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [orderOpen])

  useEffect(() => {
    if (!menuCourse) return
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuCourse('')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuCourse('')
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuCourse])

  useEffect(() => {
    if (panelFn !== 'cards' || !activeCourse || !activeUnit || unitNotes.length === 0) return
    const key = deckKey
    if (deck?.key === key || pendingDeckKey.current === key) return
    pendingDeckKey.current = key
    setCardsBusy(true)
    setCardsError('')
    void generateFlashcards({ course: activeCourse, unit: activeUnit, count: 10 }, accessToken)
      .then((result) => {
        if (latestDeckKey.current !== key) return
        setDeck({ key, cards: result.cards })
        setCardIndex(0)
        setCardFlipped(false)
      })
      .catch(() => {
        if (latestDeckKey.current === key) setCardsError('Couldn’t generate flashcards. Try again in a moment.')
      })
      .finally(() => {
        if (pendingDeckKey.current !== key) return
        pendingDeckKey.current = ''
        setCardsBusy(false)
      })
  }, [accessToken, activeCourse, activeUnit, cardsRequest, deck, deckKey, panelFn, unitNotes.length])

  useEffect(() => {
    if (panelFn !== 'quiz' || loadedQuizKey.current === quizKey) return
    loadedQuizKey.current = quizKey
    void loadQuizQuestion()
  }, [panelFn, quizKey])

  function addCourse(event: FormEvent) {
    event.preventDefault()
    const name = newCourse.trim()
    if (!name) return
    setNotebook((current) => {
      if (current.courses.some((course) => course.name === name)) {
        return { ...current, activeCourse: name, activeUnit: unitsFor(current.courses, name)[0] ?? '' }
      }
      const courses: Course[] = [...current.courses, { name, units: [], tone: pickCourseTone(current.courses) }]
      return { ...current, courses, activeCourse: name, activeUnit: '' }
    })
    setNewCourse('')
    setAddingCourse(false)
  }

  function closeAddCourse() {
    setAddingCourse(false)
    setNewCourse('')
  }

  function chooseCourse(name: string) {
    setAddingUnit(false)
    setNewUnit('')
    setRenamingUnit('')
    setRenameDraft('')
    setRenamingCourse('')
    setCourseRenameDraft('')
    setAddingCourse(false)
    setNewCourse('')
    setMenuCourse('')
    setCardIndex(0)
    setCardFlipped(false)
    setNotebook((current) => ({
      ...current,
      activeCourse: name,
      activeUnit: unitsFor(current.courses, name)[0] ?? '',
    }))
  }

  function moveCourse(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return
    setNotebook((current) => {
      if (to >= current.courses.length) return current
      const next = [...current.courses]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return { ...current, courses: next }
    })
  }

  function startRenameCourse(name: string) {
    chooseCourse(name)
    setRenamingCourse(name)
    setCourseRenameDraft(name)
  }

  function cancelRenameCourse() {
    setRenamingCourse('')
    setCourseRenameDraft('')
  }

  function commitRenameCourse(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const from = renamingCourse
    const to = courseRenameDraft.trim()
    if (!from) return
    if (!to || to === from) {
      cancelRenameCourse()
      return
    }
    if (courses.some((course) => course.name !== from && course.name === to)) {
      setNotice(`“${to}” is already a course.`)
      return
    }
    setNotebook((current) => ({
      ...current,
      courses: current.courses.map((course) => (course.name === from ? { ...course, name: to } : course)),
      deposits: current.deposits.map((item) => (item.course === from ? { ...item, course: to } : item)),
      activeCourse: current.activeCourse === from ? to : current.activeCourse,
    }))
    setLookCourse((current) => (current === from ? to : current))
    cancelRenameCourse()
  }

  function setCourseImage(name: string, image: string | undefined) {
    setNotebook((current) => ({
      ...current,
      courses: current.courses.map((course) => (course.name === name ? { ...course, image } : course)),
    }))
  }

  async function applyCourseImage(file: File | null) {
    const name = looking?.name
    if (!name || !file) return
    if (!file.type.startsWith('image/')) {
      setLookHint('Pick a photo or image file.')
      return
    }
    setLookBusy(true)
    setLookHint('')
    try {
      const image = await fileToCourseImageDataUrl(file)
      setCourseImage(name, image)
      setLookHint(`Cover added to ${name}.`)
    } catch {
      setLookHint('Could not read that image. Try another photo.')
    } finally {
      setLookBusy(false)
      if (courseImageInput.current) courseImageInput.current.value = ''
    }
  }

  function removeCourse(name: string) {
    if (!name) return
    setNotebook((current) => {
      const courses = current.courses.filter((course) => course.name !== name)
      const deposits = current.deposits.filter((item) => item.course !== name)
      if (courses.length === 0) {
        return { ...current, courses, deposits, activeCourse: '', activeUnit: '' }
      }
      const activeCourse =
        current.activeCourse === name ? courses[0].name : current.activeCourse
      const activeUnit =
        activeCourse === current.activeCourse
          ? current.activeUnit
          : (unitsFor(courses, activeCourse)[0] ?? '')
      return { ...current, courses, deposits, activeCourse, activeUnit }
    })
    setNotice(`Removed “${name}”.`)
    setLookCourse((current) => (current === name ? '' : current))
  }

  function confirmRemoveCourse(course: Course) {
    setMenuCourse('')
    const notes = notebook.deposits.filter((note) => note.course === course.name).length
    const detail = [plural(course.units.length, 'unit'), plural(notes, 'note')].join(' and ')
    if (window.confirm(`Delete “${course.name}”? Its ${detail} will be removed from this device.`)) {
      removeCourse(course.name)
    }
  }

  function openCustomize(name: string) {
    setMenuCourse('')
    setLookCourse(name || courses[0]?.name || '')
    setLookHint('')
    setOrderOpen(true)
  }

  function closeCustomize() {
    setOrderOpen(false)
    setOrderDrag('')
    orderDragIndex.current = -1
  }

  function chooseUnit(name: string) {
    setCardIndex(0)
    setCardFlipped(false)
    setNotebook((current) => ({ ...current, activeUnit: name }))
  }

  function addUnit(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const name = newUnit.trim()
    if (!name) return
    setNotebook((current) => {
      const already = unitsFor(current.courses, current.activeCourse)
      if (already.includes(name)) {
        return { ...current, activeUnit: name }
      }
      const courses = current.courses.map((course) =>
        course.name === current.activeCourse ? { ...course, units: [...course.units, name] } : course,
      )
      return { ...current, courses, activeUnit: name }
    })
    setNewUnit('')
    setAddingUnit(false)
  }

  function startRename(name: string) {
    setAddingUnit(false)
    setRenamingUnit(name)
    setRenameDraft(name)
    chooseUnit(name)
  }

  function cancelRename() {
    setRenamingUnit('')
    setRenameDraft('')
  }

  function commitRename(event?: FormEvent | React.KeyboardEvent) {
    event?.preventDefault()
    const from = renamingUnit
    const to = renameDraft.trim()
    if (!from) return
    if (!to || to === from) {
      cancelRename()
      return
    }
    const taken = unitsFor(courses, activeCourse).some((item) => item !== from && item === to)
    if (taken) {
      setNotice(`“${to}” already exists in ${activeCourse}.`)
      return
    }
    setNotebook((current) => {
      const courses = current.courses.map((course) =>
        course.name === current.activeCourse
          ? { ...course, units: course.units.map((item) => (item === from ? to : item)) }
          : course,
      )
      const deposits = current.deposits.map((item) =>
        item.course === current.activeCourse && item.unit === from ? { ...item, unit: to } : item,
      )
      return {
        ...current,
        courses,
        deposits,
        activeUnit: current.activeUnit === from ? to : current.activeUnit,
      }
    })
    cancelRename()
  }

  function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0]
    setFile(next ?? null)
    setNotice('')
  }

  function onDropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragActive(false)
    const next = event.dataTransfer.files?.[0]
    if (!next) return
    setFile(next)
    setNotice('')
  }

  function goCard(direction: 'next' | 'prev') {
    if (cards.length < 2) return
    setCardFlipped(false)
    setCardIndex((index) => (direction === 'next' ? (index + 1) % cards.length : (index - 1 + cards.length) % cards.length))
  }

  async function loadQuizQuestion() {
    const sequence = ++quizSequence.current
    setQuizBusy(true)
    setQuizError('')
    setQuizResult(null)
    setQuizAnswer('')
    try {
      const next = await generateQuestion(
        quizTopic,
        quizDifficulty,
        activeCourse && activeUnit
          ? {
              course: activeCourse,
              unit: activeUnit,
              files: unitNotes.map((note) => note.fileName),
              other_units: units.filter((name) => name !== activeUnit),
              other_courses: courses.map((course) => course.name).filter((name) => name !== activeCourse),
            }
          : undefined,
      )
      if (sequence === quizSequence.current) setQuizQuestion(next)
    } catch {
      if (sequence === quizSequence.current) setQuizError('Couldn’t load a question. Try again in a moment.')
    } finally {
      if (sequence === quizSequence.current) setQuizBusy(false)
    }
  }

  async function checkQuizAnswer(event: FormEvent) {
    event.preventDefault()
    if (!quizQuestion || !quizAnswer.trim()) return
    setQuizBusy(true)
    setQuizError('')
    try {
      const result = await analyzeAnswer(quizQuestion, quizAnswer, studentId.current, accessToken)
      setQuizResult(result)
      recordUnitAttempt({
        course: activeCourse,
        unit: activeUnit || quizQuestion.topic,
        correct: result.correct,
      })
    } catch {
      setQuizError('Couldn’t check that answer. Try again in a moment.')
    } finally {
      setQuizBusy(false)
    }
  }

  async function sendUpload(event: FormEvent) {
    event.preventDefault()
    if (!file || uploadBusy) return
    await ingestNote(file)
  }

  async function sendPastedNotes(event: FormEvent) {
    event.preventDefault()
    const text = pastedNotes.trim()
    if (!text || uploadBusy) return
    const typedNote = new File([text], `typed-notes-${new Date().toISOString().slice(0, 10)}.txt`, { type: 'text/plain' })
    const saved = await ingestNote(typedNote)
    if (saved) setPastedNotes('')
  }

  async function ingestNote(candidate: File): Promise<boolean> {
    if (!activeUnit) {
      setNotice(`Create a unit in ${activeCourse} first, then send your notes there.`)
      return false
    }
    if (candidate.size > 10 * 1024 * 1024) {
      setNotice('Notes must be 10 MB or smaller.')
      return false
    }
    setUploadBusy(true)
    setNotice('')
    try {
      const uploaded = await uploadNote(candidate, activeCourse, activeUnit, accessToken)
      const deposit: NoteDeposit = {
        id: uploaded.id,
        course: uploaded.course,
        unit: uploaded.unit,
        fileName: uploaded.file_name,
        createdAt: uploaded.created_at,
        status: uploaded.status,
        textPreview: uploaded.text_preview,
      }
      setNotebook((current) => ({ ...current, deposits: [deposit, ...current.deposits.filter((note) => note.id !== deposit.id)] }))
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      setNotice(`Added “${deposit.fileName}” to ${activeCourse} → ${activeUnit}.`)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not read that note.')
      return false
    } finally {
      setUploadBusy(false)
    }
  }

  async function removeNote(note: NoteDeposit) {
    if (removingNoteId) return
    setRemovingNoteId(note.id)
    try {
      await deleteNote(note.id, accessToken)
      setNotebook((current) => ({ ...current, deposits: current.deposits.filter((item) => item.id !== note.id) }))
      setNotice(`Removed “${note.fileName}”.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove that note.')
    } finally {
      setRemovingNoteId('')
    }
  }

  const addCourseForm = (
    <form className="tools__add-course" onSubmit={addCourse}>
      <input
        className="ui-input"
        value={newCourse}
        onChange={(event) => setNewCourse(event.target.value)}
        placeholder="Course name"
        aria-label="New course name"
        autoFocus
        onBlur={() => {
          if (!newCourse.trim()) closeAddCourse()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeAddCourse()
          }
        }}
      />
    </form>
  )

  if (courses.length === 0) {
    return (
      <div className="ui-page tools">
        <header className="ui-page-header">
          <div>
            <h1 className="ui-page-title">Tools</h1>
            <p className="ui-page-subtitle">Organize notes by course and unit, then practice with flashcards and quizzes.</p>
          </div>
        </header>
        <div className="ui-panel">
          <div className="ui-empty">
            <img className="ui-empty__mascot" src="/bindit-mascot.webp" alt="" />
            <p className="ui-empty__title">Add your first course</p>
            <p className="ui-empty__copy">Courses hold units, and each unit holds the notes your flashcards and quizzes are built from.</p>
            <form className="tools__empty-form" onSubmit={addCourse}>
              <input
                className="ui-input"
                value={newCourse}
                onChange={(event) => setNewCourse(event.target.value)}
                placeholder="e.g. Biology"
                aria-label="Course name"
              />
              <button className="ui-button ui-button--primary" type="submit" disabled={!newCourse.trim()}>Add course</button>
            </form>
          </div>
        </div>
        {notice ? <p className="notice" role="status">{notice}</p> : null}
      </div>
    )
  }

  return (
    <div className="ui-page tools">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">{activeCourse || 'Tools'}</h1>
          <p className="ui-page-subtitle">
            {current ? `${plural(current.units.length, 'unit')} · ${plural(courseNoteCount, 'note')}` : 'Pick a course to get started.'}
          </p>
        </div>
        <button className="ui-button" type="button" onClick={() => openCustomize(activeCourse)}>Customize courses</button>
      </header>

      <div className="tools__layout">
        <nav className="tools__courses" aria-label="Courses">
          <h2 className="ui-section-title tools__courses-title">Courses</h2>
          <ul className="tools__course-list">
            {courses.map((course) => {
              const isActive = course.name === activeCourse
              return (
                <li key={course.name} className={`tools__course${isActive ? ' is-active' : ''}`} style={{ ['--course' as string]: courseTone(course) }}>
                  {renamingCourse === course.name ? (
                    <form className="tools__course-rename" onSubmit={commitRenameCourse}>
                      <input
                        className="ui-input"
                        value={courseRenameDraft}
                        onChange={(event) => setCourseRenameDraft(event.target.value)}
                        aria-label={`Rename ${course.name}`}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => commitRenameCourse()}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelRenameCourse()
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <button
                      className="tools__course-button"
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      title="Double-click to rename"
                      onClick={() => chooseCourse(course.name)}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        startRenameCourse(course.name)
                      }}
                    >
                      <CourseMark course={course} />
                      <span className="tools__course-name">{course.name}</span>
                      <span className="ui-count">{course.units.length}</span>
                    </button>
                  )}
                  {renamingCourse !== course.name ? (
                    <div className="tools__course-menu" ref={menuCourse === course.name ? menuRef : undefined}>
                      <button
                        className="tools__icon-button"
                        type="button"
                        aria-label={`${course.name} options`}
                        aria-haspopup="menu"
                        aria-expanded={menuCourse === course.name}
                        onClick={() => setMenuCourse((open) => (open === course.name ? '' : course.name))}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                      </button>
                      {menuCourse === course.name ? (
                        <div className="ui-menu tools__menu" role="menu" aria-label={`${course.name} options`}>
                          <button className="ui-menu__item" type="button" role="menuitem" onClick={() => { setMenuCourse(''); startRenameCourse(course.name) }}>Rename</button>
                          <button className="ui-menu__item" type="button" role="menuitem" onClick={() => openCustomize(course.name)}>Customize…</button>
                          <button className="ui-menu__item ui-menu__item--danger" type="button" role="menuitem" onClick={() => confirmRemoveCourse(course)}>Delete…</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {addingCourse ? addCourseForm : (
            <button className="tools__add-row" type="button" onClick={() => setAddingCourse(true)}>+ Add course</button>
          )}
        </nav>

        <section className="ui-panel tools__workspace" aria-label={activeCourse ? `${activeCourse} workspace` : 'Workspace'}>
          <div className="ui-tabs tools__unit-tabs" role="tablist" aria-label={`Units in ${activeCourse}`}>
            {units.map((item) =>
              item === renamingUnit ? (
                <form key={item} className="tools__unit-form" onSubmit={commitRename}>
                  <input
                    className="ui-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    aria-label={`Rename ${item}`}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onBlur={() => commitRename()}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRename()
                      }
                      if (event.key === 'Enter') commitRename(event)
                    }}
                  />
                </form>
              ) : (
                <button
                  key={item}
                  className="ui-tab"
                  type="button"
                  role="tab"
                  title="Double-click to rename"
                  aria-selected={item === activeUnit}
                  onClick={() => chooseUnit(item)}
                  onDoubleClick={(event) => {
                    event.preventDefault()
                    startRename(item)
                  }}
                >
                  {item}
                </button>
              ),
            )}
            {addingUnit ? (
              <form className="tools__unit-form" onSubmit={addUnit}>
                <input
                  className="ui-input"
                  value={newUnit}
                  onChange={(event) => setNewUnit(event.target.value)}
                  placeholder="Unit name"
                  aria-label={`New ${activeCourse} unit`}
                  autoFocus
                  onBlur={() => {
                    if (!newUnit.trim()) setAddingUnit(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setNewUnit('')
                      setAddingUnit(false)
                    }
                    if (event.key === 'Enter') addUnit(event)
                  }}
                />
              </form>
            ) : (
              <button className="ui-tab tools__add-unit" type="button" onClick={() => setAddingUnit(true)}>
                + Add unit
              </button>
            )}
          </div>

          {!activeUnit ? (
            <div className="ui-empty">
              <p className="ui-empty__title">{units.length ? 'Pick a unit' : `No units in ${activeCourse} yet`}</p>
              <p className="ui-empty__copy">
                {units.length ? 'Choose a unit above to see its notes, flashcards, and quiz.' : 'Units group your notes by topic, like chapters in a textbook.'}
              </p>
              {units.length ? null : <button className="ui-button ui-button--primary" type="button" onClick={() => setAddingUnit(true)}>Add a unit</button>}
            </div>
          ) : (
            <>
              <div className="tools__toolbar">
                <div className="ui-segmented" role="tablist" aria-label="Study view">
                  {VIEWS.map((view) => (
                    <button
                      key={view.id}
                      className="ui-segmented__item"
                      type="button"
                      role="tab"
                      aria-selected={panelFn === view.id}
                      onClick={() => setPanelFn(view.id)}
                    >
                      {view.label}
                      {view.id === 'scan' ? <span className="ui-count">{unitNotes.length}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              {panelFn === 'scan' ? (
                <div className="tools__notes" role="tabpanel" aria-label="Notes">
                  <div className="tools__add-notes">
                    <form className="tools__upload" onSubmit={sendUpload} aria-busy={uploadBusy}>
                      <div
                        className={`tools__dropzone${dragActive ? ' is-dragging' : ''}`}
                        onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={(event) => {
                          const nextTarget = event.relatedTarget
                          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) setDragActive(false)
                        }}
                        onDrop={onDropFile}
                      >
                        <input
                          ref={fileInput}
                          className="ui-file-input"
                          type="file"
                          accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.csv,.json"
                          onChange={onPickFile}
                        />
                        <button className="tools__dropzone-button" type="button" onClick={() => fileInput.current?.click()}>
                          <span className="tools__dropzone-title">{file ? file.name : 'Drop a file or browse'}</span>
                          <span className="tools__dropzone-meta">
                            {file ? formatBytes(file.size) : 'PDF, DOCX, TXT, Markdown, CSV, JSON, or a photo of handwritten notes. Up to 10 MB.'}
                          </span>
                        </button>
                      </div>
                      <div className="tools__form-actions">
                        {uploadBusy ? <span className="tools__status" role="status"><span className="ui-spinner" />Reading your notes…</span> : null}
                        {file && !uploadBusy ? <button className="ui-button ui-button--ghost" type="button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = '' }}>Clear</button> : null}
                        <button className="ui-button ui-button--primary" type="submit" disabled={!file || uploadBusy}>Upload</button>
                      </div>
                    </form>

                    <form className="tools__paste" onSubmit={sendPastedNotes}>
                      <label className="tools__label" htmlFor="pasted-notes">Paste or type notes</label>
                      <textarea
                        id="pasted-notes"
                        className="ui-textarea"
                        value={pastedNotes}
                        onChange={(event) => setPastedNotes(event.target.value)}
                        placeholder="Paste from Google Docs, a class handout, or your own notes"
                        rows={5}
                      />
                      <div className="tools__form-actions">
                        <button className="ui-button" type="submit" disabled={!pastedNotes.trim() || uploadBusy}>Add typed notes</button>
                      </div>
                    </form>
                  </div>

                  <div className="tools__sources">
                    <div className="ui-section-head">
                      <h2 className="ui-section-title">Sources</h2>
                      <span className="ui-count">{plural(unitNotes.length, 'file')}</span>
                    </div>
                    <div className="ui-panel tools__source-panel">
                      {unitNotes.length ? (
                        <ul className="ui-list">
                          {unitNotes.map((note) => (
                            <li key={note.id} className="ui-row tools__source">
                              <div className="ui-row__main">
                                <span className="ui-row__title">{note.fileName}</span>
                                <span className="ui-row__meta">{note.textPreview || 'Text extracted and ready.'}</span>
                              </div>
                              <button
                                className="ui-button ui-button--ghost ui-button--sm"
                                type="button"
                                onClick={() => void removeNote(note)}
                                disabled={removingNoteId === note.id}
                                aria-label={`Remove ${note.fileName}`}
                              >
                                {removingNoteId === note.id ? 'Removing…' : 'Remove'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="ui-empty">
                          <img className="ui-empty__mascot" src="/bindit-mascot.webp" alt="" />
                          <p className="ui-empty__title">No notes in {activeUnit} yet</p>
                          <p className="ui-empty__copy">Flashcards and quiz questions are built from the files you add here.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {panelFn === 'cards' ? (
                <div className="tools__cards" role="tabpanel" aria-label="Flashcards">
                  {unitNotes.length === 0 ? (
                    <div className="ui-empty">
                      <img className="ui-empty__mascot" src="/bindit-mascot.webp" alt="" />
                      <p className="ui-empty__title">No notes in {activeUnit} yet</p>
                      <p className="ui-empty__copy">Flashcards are generated from this unit’s notes.</p>
                      <button className="ui-button ui-button--primary" type="button" onClick={() => setPanelFn('scan')}>Add notes</button>
                    </div>
                  ) : card ? (
                    <>
                      <button
                        className={`tools__card${cardFlipped ? ' is-flipped' : ''}`}
                        style={current ? { ['--course' as string]: courseTone(current) } : undefined}
                        type="button"
                        aria-live="polite"
                        onClick={() => setCardFlipped((open) => !open)}
                      >
                        <span className="tools__card-label">{cardFlipped ? 'Answer' : 'Question'}</span>
                        <span className="tools__card-text">{cardFlipped ? card.back : card.front}</span>
                        <span className="tools__card-hint">{cardFlipped ? 'Click to see the question' : 'Click to reveal the answer'}</span>
                      </button>
                      <div className="tools__card-nav">
                        <button className="ui-button" type="button" onClick={() => goCard('prev')} disabled={cards.length < 2}>Previous</button>
                        <span className="ui-count">{(cardIndex % cards.length) + 1} of {cards.length}</span>
                        <button className="ui-button" type="button" onClick={() => goCard('next')} disabled={cards.length < 2}>Next</button>
                      </div>
                    </>
                  ) : cardsError && !cardsBusy ? (
                    <div className="ui-empty" role="alert">
                      <p className="ui-empty__title">Flashcards didn’t load</p>
                      <p className="ui-empty__copy">{cardsError}</p>
                      <button className="ui-button" type="button" onClick={() => setCardsRequest((count) => count + 1)}>Retry</button>
                    </div>
                  ) : (
                    <div className="ui-empty" role="status">
                      <span className="ui-spinner" />
                      <p className="ui-empty__copy">Generating flashcards from {plural(unitNotes.length, 'note')}…</p>
                    </div>
                  )}
                </div>
              ) : null}

              {panelFn === 'quiz' ? (
                <div className="tools__quiz" role="tabpanel" aria-label="Quiz">
                  <div className="tools__quiz-bar">
                    <p className="tools__quiz-source">
                      {unitNotes.length
                        ? `Questions come from ${plural(unitNotes.length, 'note')} in ${activeUnit}.`
                        : `No notes in ${activeUnit} yet, so these are math practice questions.`}
                    </p>
                    <div className="tools__quiz-controls">
                      {unitNotes.length === 0 ? (
                        <select className="ui-select" aria-label="Topic" value={quizTopic} onChange={(event) => setQuizTopic(event.target.value as Topic)}>
                          {QUIZ_TOPICS.map((topic) => <option key={topic.id} value={topic.id}>{topic.label}</option>)}
                        </select>
                      ) : null}
                      <select className="ui-select" aria-label="Level" value={quizDifficulty} onChange={(event) => setQuizDifficulty(Number(event.target.value))}>
                        {QUIZ_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
                      </select>
                      <button className="ui-button" type="button" onClick={() => void loadQuizQuestion()} disabled={quizBusy}>New question</button>
                    </div>
                  </div>

                  <div className={`tools__question${quizBusy && !quizResult ? ' is-loading' : ''}`} aria-busy={quizBusy}>
                    {quizQuestion ? (
                      <p className="tools__prompt">{quizQuestion.question}</p>
                    ) : quizError ? null : (
                      <p className="tools__status" role="status"><span className="ui-spinner" />Loading a question…</p>
                    )}
                  </div>

                  <form className="tools__answer" onSubmit={checkQuizAnswer}>
                    <input
                      className="ui-input"
                      type="text"
                      value={quizAnswer}
                      onChange={(event) => setQuizAnswer(event.target.value)}
                      placeholder="Your answer"
                      aria-label="Your answer"
                      autoComplete="off"
                      disabled={quizBusy || !quizQuestion}
                    />
                    <button className="ui-button ui-button--primary" type="submit" disabled={quizBusy || !quizQuestion || !quizAnswer.trim()}>
                      Check
                    </button>
                  </form>

                  {quizError ? <p className="tools__error" role="alert">{quizError}</p> : null}
                  {quizResult ? (
                    <div className={`tools__result ${quizResult.correct ? 'is-correct' : 'is-incorrect'}`} role="status">
                      <p className="tools__result-title">{quizResult.correct ? 'Correct' : 'Not quite'}</p>
                      <p className="tools__result-body">{quizResult.explanation}</p>
                      {quizResult.hint ? <p className="tools__result-body">Hint: {quizResult.hint}</p> : null}
                      <p className="tools__result-meta">
                        {quizResult.xp_earned ? `+${quizResult.xp_earned} XP · ` : ''}{quizResult.total_xp.toLocaleString()} XP total · answer streak {quizResult.streak}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {notice ? <p className="notice" role="status">{notice}</p> : null}

      {orderOpen ? (
        <div className="ui-dialog-backdrop" role="presentation" onClick={closeCustomize}>
          <div
            className="ui-dialog tools__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customize-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui-dialog__header">
              <h2 className="ui-dialog__title" id="customize-title">Customize courses</h2>
            </div>
            <div className="tools__dialog-body">
              <section className="tools__dialog-order" aria-label="Course order">
                <p className="tools__hint">Drag to reorder, or use the arrows. Double-click a name to rename it.</p>
                <ol className="tools__order-list">
                  {courses.map((course, index) => (
                    <li
                      key={course.name}
                      className={`tools__order-item${orderDrag === course.name ? ' is-dragging' : ''}${course.name === looking?.name ? ' is-selected' : ''}`}
                      style={{ ['--course' as string]: courseTone(course) }}
                      draggable={renamingCourse !== course.name}
                      onClick={() => {
                        setLookCourse(course.name)
                        chooseCourse(course.name)
                        setLookHint('')
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        startRenameCourse(course.name)
                      }}
                      onDragStart={(event) => {
                        if (renamingCourse === course.name) {
                          event.preventDefault()
                          return
                        }
                        orderDragIndex.current = index
                        setOrderDrag(course.name)
                        event.dataTransfer.setData('text/plain', course.name)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const from = orderDragIndex.current
                        if (from < 0) return
                        const box = event.currentTarget.getBoundingClientRect()
                        let to = event.clientY < box.top + box.height / 2 ? index : index + 1
                        if (from < to) to -= 1
                        if (from === to) return
                        orderDragIndex.current = to
                        moveCourse(from, to)
                      }}
                      onDragEnd={() => {
                        orderDragIndex.current = -1
                        setOrderDrag('')
                      }}
                    >
                      <GripMark />
                      <CourseMark course={course} />
                      {renamingCourse === course.name ? (
                        <input
                          className="ui-input tools__order-rename"
                          value={courseRenameDraft}
                          onChange={(event) => setCourseRenameDraft(event.target.value)}
                          aria-label={`Rename ${course.name}`}
                          autoFocus
                          onClick={(event) => event.stopPropagation()}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => commitRenameCourse()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              event.stopPropagation()
                              cancelRenameCourse()
                            }
                            if (event.key === 'Enter') commitRenameCourse(event)
                          }}
                        />
                      ) : (
                        <span className="tools__order-name">{course.name}</span>
                      )}
                      <span className="tools__order-shift">
                        <button
                          className="tools__icon-button"
                          type="button"
                          aria-label={`Move ${course.name} up`}
                          disabled={index === 0}
                          onClick={(event) => { event.stopPropagation(); moveCourse(index, index - 1) }}
                        >
                          <Chevron direction="up" />
                        </button>
                        <button
                          className="tools__icon-button"
                          type="button"
                          aria-label={`Move ${course.name} down`}
                          disabled={index === courses.length - 1}
                          onClick={(event) => { event.stopPropagation(); moveCourse(index, index + 1) }}
                        >
                          <Chevron direction="down" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              <section
                className="tools__dialog-cover"
                aria-label="Course cover"
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  void applyCourseImage(event.dataTransfer.files?.[0] ?? null)
                }}
              >
                <input
                  ref={courseImageInput}
                  className="ui-file-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void applyCourseImage(event.target.files?.[0] ?? null)}
                />
                {looking ? (
                  <>
                    <div className="tools__cover-preview">
                      <CourseMark course={looking} size="lg" />
                      <div>
                        <p className="tools__cover-name">{looking.name}</p>
                        <p className="tools__hint">{looking.image ? 'Cover image shown in your course list.' : 'No cover. The course color is used instead.'}</p>
                      </div>
                    </div>
                    <p className="tools__hint">Drop an image here or choose one from your files.</p>
                    <div className="tools__form-actions tools__form-actions--start">
                      <button className="ui-button" type="button" disabled={lookBusy} onClick={() => courseImageInput.current?.click()}>
                        {lookBusy ? 'Adding…' : looking.image ? 'Change cover' : 'Add cover'}
                      </button>
                      {looking.image ? (
                        <button
                          className="ui-button ui-button--ghost"
                          type="button"
                          disabled={lookBusy}
                          onClick={() => {
                            setCourseImage(looking.name, undefined)
                            setLookHint(`Cover removed from ${looking.name}.`)
                          }}
                        >
                          Remove cover
                        </button>
                      ) : null}
                    </div>
                    {lookHint ? <p className="tools__hint" role="status">{lookHint}</p> : null}
                  </>
                ) : null}
              </section>
            </div>
            <div className="ui-dialog__footer">
              <button className="ui-button ui-button--primary" type="button" onClick={closeCustomize} autoFocus>Done</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
