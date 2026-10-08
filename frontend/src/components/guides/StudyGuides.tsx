import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ApiError, isAbortError, parseServerTime, RequestTimeoutError } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { GUIDE_KINDS, guideFileName, guideKind, guideMarkdown, guidePlainText } from '../../lib/studyGuides'
import type { GuideKind, GuideSection, StudyGuide, StudyGuideList } from '../../lib/studyGuides'
import { INSTRUCTIONS_MAX } from '../../lib/studyPrefs'
import { MathText } from '../math/Math'
import './StudyGuides.css'

/*
 * Study materials Otto makes from the student's notes: the list for a unit (or a whole
 * course) with a "Make a…" sheet, and the reader (print, copy, download, flashcards,
 * rename, regenerate, delete). Every request goes through useData(), so the landing demo
 * runs the same components on its in-memory sandbox.
 */

const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>

const KIND_ICONS: Record<GuideKind, ReactNode> = {
  study_guide: svg(<><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6M9 11h4" /></>),
  summary: svg(<path d="M5 6h14M5 10h14M5 14h9M5 18h11" />),
  cheat_sheet: svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />),
  vocabulary: svg(<path d="M3.5 19 8 6l4.5 13M5.2 14.5h5.6M15 10h5.5M15 14h5.5M15 18h5.5" />),
  practice: svg(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>),
  timeline: svg(<><path d="M12 3v18" /><circle cx="12" cy="7" r="2" /><circle cx="12" cy="17" r="2" /><path d="M14 7h5M5 17h5" /></>),
}

function KindIcon({ kind }: { kind: GuideKind }) {
  return <span className={`ui-icon ui-tone--${guideKind(kind).tone}`}>{KIND_ICONS[kind]}</span>
}

function failure(error: unknown, fallback: string) {
  if (error instanceof RequestTimeoutError) return error.message
  if (error instanceof ApiError && error.message) return error.message
  if (error instanceof Error && error.message && !(error instanceof TypeError)) return error.message
  return fallback
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function day(value: string) {
  const time = parseServerTime(value)
  return Number.isNaN(time) ? '' : dayFormat.format(time)
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/* Answers start hidden for practice problems and test-style questions; worked examples show theirs. */
function hidesAnswers(kind: GuideKind, section: GuideSection) {
  return kind === 'practice' || /question|quiz|test|practice|check/i.test(section.heading)
}

function Lines({ text }: { text: string }) {
  const lines = text.split('\n')
  return <>{lines.map((line, index) => <span key={index} className="guide__line"><MathText text={line} /></span>)}</>
}

type ListProps = {
  course: string
  // null: the whole course.
  unit: string | null
  accessToken?: string
  // A unit to save flashcards in when the guide covers the whole course.
  fallbackUnit?: string
  onClose?: () => void
  onNotice?: (message: string) => void
  onCardsMade?: () => void
}

/* The guides for a unit (or the whole course) and the "Make a…" sheet. Opens a guide in place. */
export function StudyGuides({ course, unit, accessToken, fallbackUnit, onClose, onNotice, onCardsMade }: ListProps) {
  const data = useData()
  const scope = unit ?? `all of ${course}`
  const [list, setList] = useState<StudyGuideList | null>(null)
  const [listError, setListError] = useState(false)
  const [reload, setReload] = useState(0)
  const [openId, setOpenId] = useState('')
  const [openNotice, setOpenNotice] = useState('')
  const [making, setMaking] = useState(false)
  const [kind, setKind] = useState<GuideKind>('study_guide')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const formId = useId()

  useEffect(() => {
    const controller = new AbortController()
    data.listStudyGuides(course, unit, accessToken, controller.signal)
      .then((result) => { setList(result); setListError(false) })
      .catch((reason) => { if (!isAbortError(reason)) setListError(true) })
    return () => controller.abort()
  }, [data, course, unit, accessToken, reload])

  useEffect(() => () => request.current?.abort(), [])

  async function make(event?: FormEvent) {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const guide = await data.createStudyGuide({ course, unit, kind, instructions }, accessToken, controller.signal)
      setMaking(false)
      setInstructions('')
      setOpenNotice(guide.source === 'saved' ? 'You already had this one, and your notes haven’t changed since, so here it is again.' : '')
      setOpenId(guide.id)
      setReload((count) => count + 1)
    } catch (reason) {
      if (!isAbortError(reason)) setError(failure(reason, 'Otto couldn’t make that right now. Try again in a moment.'))
    } finally {
      if (request.current === controller) request.current = null
      setBusy(false)
    }
  }

  if (openId) {
    return (
      <GuideReader
        key={openId}
        guideId={openId}
        accessToken={accessToken}
        fallbackUnit={fallbackUnit}
        notice={openNotice}
        backLabel={unit ? `Guides for ${unit}` : 'Course guides'}
        onBack={() => { setOpenId(''); setOpenNotice('') }}
        onChanged={() => setReload((count) => count + 1)}
        onDeleted={() => { setOpenId(''); setReload((count) => count + 1); onNotice?.('Study guide deleted.') }}
        onNotice={onNotice}
        onCardsMade={onCardsMade}
      />
    )
  }

  const guides = list?.guides ?? []
  const noNotes = list !== null && list.note_count === 0
  const chosen = guideKind(kind)

  return (
    <div className="guides" role="region" aria-label={unit ? `Study guides for ${unit}` : `Study guides for ${course}`}>
      <div className="guides__head">
        <div className="guides__head-text">
          <h3 className="guides__title">{unit ? 'Study materials' : `${course}: the whole course`}</h3>
          <p className="guides__hint">
            {noNotes
              ? `Add notes to ${scope} first. Otto makes study materials only from your own notes.`
              : `Otto writes these from your notes for ${scope}, saves them here, and can print or turn them into flashcards.`}
          </p>
        </div>
        <div className="guides__head-actions">
          {onClose ? <button className="ui-button ui-button--ghost guides__back" type="button" onClick={onClose}>Back</button> : null}
          {!making ? (
            <button className="ui-button ui-button--primary guides__make" type="button" disabled={noNotes || list === null} onClick={() => setMaking(true)}>
              Make a…
            </button>
          ) : null}
        </div>
      </div>

      {making ? (
        <form className="guides__form" id={formId} onSubmit={make} aria-busy={busy}>
          <fieldset className="guides__kinds" disabled={busy}>
            <legend className="guides__label">What should Otto make?</legend>
            <div className="guides__kind-grid">
              {GUIDE_KINDS.map((item) => {
                const unavailable = item.id === 'timeline' && !list?.can_timeline
                return (
                  <label key={item.id} className={`guides__kind ui-tone--${item.tone}${kind === item.id ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}>
                    <input type="radio" name={`${formId}-kind`} value={item.id} checked={kind === item.id} disabled={unavailable} onChange={() => setKind(item.id)} />
                    <KindIcon kind={item.id} />
                    <span className="guides__kind-name">{item.label}</span>
                    <span className="guides__kind-blurb">{unavailable ? 'Needs notes with dates in them.' : item.blurb}</span>
                  </label>
                )
              })}
            </div>
          </fieldset>
          <label className="ui-field guides__instructions">
            <span>Anything to focus on? (optional)</span>
            <input
              className="ui-input"
              value={instructions}
              maxLength={INSTRUCTIONS_MAX}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="e.g. focus on chapter 3, or keep it short"
              disabled={busy}
              autoComplete="off"
            />
          </label>
          {error ? <p className="ui-alert" role="alert"><span>{error}</span></p> : null}
          <div className="guides__actions">
            <button className={`ui-button ui-button--primary guides__submit${busy ? ' is-busy' : ''}`} type="submit" disabled={busy}>
              {busy ? `Making your ${chosen.label.toLowerCase()}…` : `Make ${chosen.label.toLowerCase()}`}
            </button>
            <button className="ui-button ui-button--ghost guides__cancel" type="button" disabled={busy} onClick={() => { setMaking(false); setError('') }}>Cancel</button>
            {busy ? <span className="guides__hint" role="status"><span className="ui-spinner" />Otto is reading your notes. This takes about 15–30 seconds.</span> : null}
          </div>
        </form>
      ) : null}

      <section className="guides__saved" aria-labelledby={`${formId}-saved`}>
        <h3 className="guides__label" id={`${formId}-saved`}>Saved</h3>
        {listError ? (
          <div className="ui-alert">
            <span>Couldn’t load your study guides.</span>
            <button className="ui-button ui-button--sm guides__retry" type="button" onClick={() => { setListError(false); setReload((count) => count + 1) }}>Retry</button>
          </div>
        ) : list === null ? (
          <div className="guides__skeleton" aria-hidden="true"><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
        ) : guides.length === 0 ? (
          <p className="guides__hint">No study materials for {scope} yet. Choose “Make a…” and Otto will write one from your notes.</p>
        ) : (
          <ul className="ui-list guides__list">
            {guides.map((guide) => {
              const info = guideKind(guide.kind)
              return (
                <li key={guide.id} className="ui-row guides__row">
                  <KindIcon kind={guide.kind} />
                  <div className="ui-row__main">
                    <span className="ui-row__title">{guide.title}</span>
                    <span className="ui-row__meta">
                      {info.label}{unit && guide.unit === null ? ' · whole course' : ''} · {day(guide.updated_at)} · from {plural(guide.note_count, 'note')}
                    </span>
                  </div>
                  <button className="ui-button ui-button--sm guides__open" type="button" onClick={() => { setOpenNotice(''); setOpenId(guide.id) }} aria-label={`Open ${guide.title}`}>
                    Open
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

type ReaderProps = {
  guideId: string
  accessToken?: string
  fallbackUnit?: string
  notice?: string
  backLabel?: string
  onBack: () => void
  onLoaded?: (guide: StudyGuide) => void
  onChanged?: () => void
  onDeleted?: () => void
  onNotice?: (message: string) => void
  onCardsMade?: () => void
}

/* One guide, readable and printable. */
export function GuideReader({ guideId, accessToken, fallbackUnit, notice = '', backLabel = 'Back', onBack, onLoaded, onChanged, onDeleted, onNotice, onCardsMade }: ReaderProps) {
  const data = useData()
  const [guide, setGuide] = useState<StudyGuide | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState(notice)
  // Where the last status shows: by the top actions, or by Rename / Regenerate / Delete at the end.
  const [statusAt, setStatusAt] = useState<'top' | 'end'>('top')
  const [unchanged, setUnchanged] = useState(false)
  const [busy, setBusy] = useState<'' | 'regenerate' | 'fresh' | 'cards' | 'rename' | 'delete'>('')
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  const [copied, setCopied] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const sheet = useRef<HTMLElement>(null)
  const base = useId()
  const loaded = useEffectEvent((result: StudyGuide) => onLoaded?.(result))
  const loadedId = guide?.id

  useEffect(() => {
    const controller = new AbortController()
    data.getStudyGuide(guideId, accessToken, controller.signal)
      .then((result) => { setGuide(result); setLoadError(''); loaded(result) })
      .catch((reason) => { if (!isAbortError(reason)) setLoadError(failure(reason, 'Couldn’t open this study guide.')) })
    return () => controller.abort()
  }, [data, guideId, accessToken, reload])

  // Opening a guide moves focus to its title, so a screen reader starts reading there.
  useEffect(() => {
    if (loadedId) heading.current?.focus({ preventScroll: true })
  }, [loadedId])

  if (loadError) {
    return (
      <div className="guide" role="region" aria-label="Study guide">
        <div className="ui-alert" role="alert">
          <span>{loadError}</span>
          <button className="ui-button ui-button--sm guides__retry" type="button" onClick={() => { setLoadError(''); setReload((count) => count + 1) }}>Try again</button>
          <button className="ui-button ui-button--sm ui-button--ghost guide__back" type="button" onClick={onBack}>Back</button>
        </div>
      </div>
    )
  }
  if (!guide) {
    return (
      <div className="guide" role="region" aria-label="Study guide" aria-busy="true">
        <div className="guides__skeleton"><span className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
        <p className="sr-only" role="status">Opening the study guide…</p>
      </div>
    )
  }

  const info = guideKind(guide.kind)
  const hiddenKeys = guide.sections.flatMap((section, s) => hidesAnswers(guide.kind, section) ? section.items.map((_, i) => `${s}-${i}`) : [])
  const allShown = hiddenKeys.length > 0 && hiddenKeys.every((key) => revealed[key])
  const cardsUnit = guide.unit ?? fallbackUnit ?? ''

  async function regenerate(fresh: boolean) {
    if (!guide || busy) return
    setBusy(fresh ? 'fresh' : 'regenerate')
    setStatus('')
    setStatusAt('end')
    try {
      const next = await data.regenerateStudyGuide(guide.id, fresh, accessToken)
      setGuide(next)
      setRevealed({})
      if (next.source === 'unchanged') {
        setUnchanged(true)
      } else {
        setUnchanged(false)
        setStatus('Otto wrote a new version from your notes.')
        onChanged?.()
      }
    } catch (reason) {
      if (!isAbortError(reason)) setStatus(failure(reason, 'Otto couldn’t write a new version right now. Try again in a moment.'))
    } finally {
      setBusy('')
    }
  }

  async function makeCards() {
    if (!guide || busy || !cardsUnit) return
    setBusy('cards')
    setStatusAt('top')
    setStatus('Making flashcards…')
    try {
      const note = await data.saveStudyGuideAsNote(guide.id, guide.unit ? undefined : cardsUnit, accessToken)
      const result = await data.generateNoteFlashcards(note.id, undefined, accessToken)
      const count = result.cards.length
      setStatus(count ? `${plural(count, 'flashcard')} saved to ${note.unit}.` : `Flashcards are being made in ${note.unit}.`)
      onCardsMade?.()
    } catch (reason) {
      if (!isAbortError(reason)) setStatus(failure(reason, 'Flashcards couldn’t be made. Try again.'))
    } finally {
      setBusy('')
    }
  }

  async function saveTitle(event: FormEvent) {
    event.preventDefault()
    if (!guide || busy) return
    const clean = title.trim()
    if (!clean || clean === guide.title) { setRenaming(false); return }
    setBusy('rename')
    try {
      const next = await data.renameStudyGuide(guide.id, clean, accessToken)
      setGuide({ ...guide, title: next.title })
      setRenaming(false)
      onChanged?.()
    } catch (reason) {
      setStatusAt('top')
      setStatus(failure(reason, 'Couldn’t rename the guide. Try again.'))
    } finally {
      setBusy('')
    }
  }

  async function remove() {
    if (!guide || busy) return
    if (!data.confirm(`Delete “${guide.title}”? This can’t be undone.`)) return
    setBusy('delete')
    try {
      await data.deleteStudyGuide(guide.id, accessToken)
      onDeleted?.()
    } catch (reason) {
      setStatusAt('end')
      setStatus(failure(reason, 'Couldn’t delete the guide. Try again.'))
      setBusy('')
    }
  }

  async function copy() {
    if (!guide) return
    try {
      await navigator.clipboard.writeText(guidePlainText(guide))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      onNotice?.('Couldn’t copy. Select the text and copy it instead.')
    }
  }

  function download(extension: 'md' | 'txt') {
    if (!guide) return
    const text = extension === 'md' ? guideMarkdown(guide) : guidePlainText(guide)
    const url = URL.createObjectURL(new Blob([text], { type: extension === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = guideFileName(guide.title, extension)
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /*
   * Prints only the guide: a copy of it (every answer shown, no buttons) is placed at the top
   * of the page and the print styles hide everything else, so no app chrome reaches paper.
   */
  function print() {
    if (!sheet.current) return
    const copy = sheet.current.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.guide__bar, .guide__actions, .guide__manage, .guide__reveal, .guide__status, .guide__unchanged').forEach((node) => node.remove())
    copy.querySelectorAll('[hidden]').forEach((node) => node.removeAttribute('hidden'))
    copy.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
    copy.removeAttribute('aria-labelledby')
    const holder = document.createElement('div')
    holder.className = 'guide-print'
    holder.setAttribute('aria-hidden', 'true')
    holder.append(copy)
    document.body.append(holder)
    document.documentElement.classList.add('is-printing-guide')
    const done = () => {
      document.documentElement.classList.remove('is-printing-guide')
      holder.remove()
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
  }

  const toggleAll = () => setRevealed(allShown ? {} : Object.fromEntries(hiddenKeys.map((key) => [key, true])))

  return (
    <article ref={sheet} className={`guide guide--${guide.kind} ui-tone--${info.tone}`} aria-labelledby={`${base}-title`}>
      <div className="guide__bar">
        <button className="ui-button ui-button--ghost guide__back" type="button" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>{backLabel}
        </button>
        <div className="guide__tools" role="group" aria-label="Guide actions">
          <button className="ui-button ui-button--sm guide__print" type="button" onClick={print}>Print</button>
          <button className="ui-button ui-button--sm guide__copy" type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="ui-button ui-button--sm guide__download" type="button" onClick={() => download('md')}>Download .md</button>
          <button className="ui-button ui-button--sm guide__download" type="button" onClick={() => download('txt')}>Download .txt</button>
        </div>
      </div>

      <header className="guide__head">
        <span className="ui-badge ui-badge--tone guide__kind"><KindIcon kind={guide.kind} />{info.label}</span>
        {renaming ? (
          <form className="guide__rename" onSubmit={saveTitle}>
            <input
              className="ui-input"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Guide name"
              autoFocus
              onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false) }}
            />
            <button className="ui-button ui-button--sm" type="submit" disabled={busy === 'rename'}>Save</button>
            <button className="ui-button ui-button--sm ui-button--ghost" type="button" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <h2 className="guide__title" id={`${base}-title`} ref={heading} tabIndex={-1}>{guide.title}</h2>
        )}
        <p className="guide__meta">
          {guide.unit ?? 'Whole course'} · {guide.course} · from {plural(guide.note_count, 'note')} · {day(guide.updated_at)}
          {guide.instructions ? <> · focus: “{guide.instructions}”</> : null}
        </p>
        <p className="guide__print-note">Made by Otto in bindet from your own notes. Check anything important against them.</p>
      </header>

      {status && statusAt === 'top' ? <p className="guide__status" role="status">{status}</p> : null}

      <div className="guide__actions">
        <button
          className={`ui-button ui-button--primary guide__cards${busy === 'cards' ? ' is-busy' : ''}`}
          type="button"
          disabled={Boolean(busy) || !cardsUnit}
          title={cardsUnit ? `Saves this guide as a note in ${cardsUnit} and makes flashcards from it` : 'Pick a unit first'}
          onClick={() => void makeCards()}
        >
          Make flashcards from this
        </button>
        {hiddenKeys.length ? (
          <button className="ui-button guide__reveal-all" type="button" aria-pressed={allShown} onClick={toggleAll}>
            {allShown ? 'Hide answers' : 'Show all answers'}
          </button>
        ) : null}
      </div>

      <div className="guide__body">
        {guide.sections.map((section, s) => {
          const hides = hidesAnswers(guide.kind, section)
          return (
            <section key={s} className="guide__section" aria-labelledby={`${base}-s${s}`}>
              <h3 className="guide__heading" id={`${base}-s${s}`}><MathText text={section.heading} /></h3>
              {section.bullets.length ? (
                <ul className="guide__bullets">
                  {section.bullets.map((bullet, index) => <li key={index}><MathText text={bullet} /></li>)}
                </ul>
              ) : null}
              {section.terms.length ? (
                guide.kind === 'timeline' ? (
                  <ol className="guide__timeline">
                    {section.terms.map((term, index) => (
                      <li key={index}>
                        <span className="guide__when">{term.term}</span>
                        <span className="guide__what"><MathText text={term.definition} /></span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <dl className="guide__terms">
                    {section.terms.map((term, index) => (
                      <div key={index} className="guide__term">
                        <dt><MathText text={term.term} /></dt>
                        <dd><MathText text={term.definition} /></dd>
                      </div>
                    ))}
                  </dl>
                )
              ) : null}
              {section.items.length ? (
                <ol className="guide__items">
                  {section.items.map((item, index) => {
                    const key = `${s}-${index}`
                    const shown = !hides || revealed[key]
                    const answerId = `${base}-a${key}`
                    return (
                      <li key={index} className="guide__item">
                        <p className="guide__question"><Lines text={item.question} /></p>
                        {hides ? (
                          <button
                            className="ui-button ui-button--sm ui-button--ghost guide__reveal"
                            type="button"
                            aria-expanded={Boolean(revealed[key])}
                            aria-controls={answerId}
                            onClick={() => setRevealed((current) => ({ ...current, [key]: !current[key] }))}
                          >
                            {revealed[key] ? 'Hide answer' : 'Show answer'}
                          </button>
                        ) : null}
                        <div className={`guide__answer${shown ? '' : ' is-hidden'}`} id={answerId} hidden={!shown}>
                          <span className="guide__answer-label">Answer</span>
                          <Lines text={item.answer} />
                        </div>
                      </li>
                    )
                  })}
                </ol>
              ) : null}
            </section>
          )
        })}
      </div>

      <footer className="guide__manage" aria-label="Manage this guide">
        <button className="ui-button ui-button--sm ui-button--ghost guide__rename-button" type="button" disabled={Boolean(busy)} onClick={() => { setTitle(guide.title); setRenaming(true) }}>Rename</button>
        <button className={`ui-button ui-button--sm ui-button--ghost guide__regenerate${busy === 'regenerate' ? ' is-busy' : ''}`} type="button" disabled={Boolean(busy)} onClick={() => void regenerate(false)}>
          Regenerate
        </button>
        <button className="ui-button ui-button--sm ui-button--ghost ui-button--danger guide__delete" type="button" disabled={Boolean(busy)} onClick={() => void remove()}>Delete</button>
        {busy === 'regenerate' || busy === 'fresh' ? <span className="guides__hint" role="status"><span className="ui-spinner" />Otto is checking your notes…</span> : null}
        {status && statusAt === 'end' ? <p className="guide__status" role="status">{status}</p> : null}
        {unchanged ? (
          <div className="ui-alert ui-alert--info guide__unchanged" role="status">
            <span>Your notes haven’t changed since this was made, so it’s the same guide. A fresh version counts toward today’s limit.</span>
            <button className={`ui-button ui-button--sm guide__fresh${busy === 'fresh' ? ' is-busy' : ''}`} type="button" disabled={Boolean(busy)} onClick={() => void regenerate(true)}>
              Make a fresh version
            </button>
          </div>
        ) : null}
      </footer>
    </article>
  )
}
