import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useData } from '../../lib/dataSource'
import { fitScale, isAppleMobile, printHint } from '../../lib/printDoc'
import { useDrawer } from '../../lib/useDrawer'
import { loadKatex } from '../math/katexLoader'
import './Print.css'

/*
 * "Download PDF" for study material, with no PDF library: the button opens a small options
 * sheet (a bottom sheet on phones), then a clean print layout of just the document over the
 * app, and calls window.print(). The student picks "Save as PDF" (desktop, Android) or
 * Share → Save to Files (iPhone, iPad), or prints it.
 *
 * Before printing, KaTeX is loaded (so every expression is typeset, not shown as source),
 * the fonts finish loading (document.fonts.ready), and long equations and long flashcard
 * text are scaled down to fit the paper. While the layout is open the page's <title> is
 * the PDF's suggested file name ("Photosynthesis – Study guide"); it is put back afterwards.
 */

export type PdfChoice = { value: string; label: string; hint?: string; disabled?: boolean }
export type PdfOption = { id: string; label: string; choices: PdfChoice[]; initial: string }

export type PdfDocument = {
  // The suggested file name (the page title while printing).
  fileTitle: string
  // The running header on every page: the document's title, and "course · unit · date".
  heading: string
  scope: string
  // A flowing document (guides, lists, tests), or fixed sheets (cut-out cards), one per page.
  body?: ReactNode
  pages?: ReactNode[]
}

type Props = {
  // What is being exported, for the sheet's subtitle and the button's accessible name ("this study guide").
  what: string
  options?: PdfOption[]
  prepare: (choices: Record<string, string>) => PdfDocument | Promise<PdfDocument>
  label?: string
  className?: string
  disabled?: boolean
}

const HINT_KEY = 'bindit:pdf-hint-seen'

function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

function rememberHint() {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    // Storage can be unavailable; the hint just shows again next time.
  }
}

export function PdfIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" />
    </svg>
  )
}

// The on-screen sheet: 186mm of text plus 12mm margins each side, in CSS pixels.
const PAPER_PX = (210 * 96) / 25.4

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/*
 * Shrinks what would not fit on paper: an equation wider than its line gets a smaller
 * font size (KaTeX is sized in em, so it scales as a whole), and a flashcard's text
 * shrinks step by step until it fits its card.
 */
function fitForPaper(root: HTMLElement) {
  for (const math of root.querySelectorAll<HTMLElement>('.math:not(.math--pending):not(.math--source)')) {
    math.style.fontSize = ''
    // The room is the line the expression sits on: its own box for display math, else the nearest block around it.
    let block: HTMLElement | null = math.classList.contains('math--display') ? math : math.parentElement
    while (block && block !== root && getComputedStyle(block).display.startsWith('inline')) block = block.parentElement
    const room = block ? block.clientWidth - parseFloat(getComputedStyle(block).paddingLeft) - parseFloat(getComputedStyle(block).paddingRight) : 0
    const natural = math.scrollWidth
    // A few pixels over is KaTeX's own spacing, not a long equation.
    const scale = natural > room + 2 ? fitScale(room, natural, 0.4) : 1
    if (scale < 1) math.style.fontSize = `${scale}em`
  }
  for (const text of root.querySelectorAll<HTMLElement>('.pdoc-card__text')) {
    text.style.fontSize = ''
    let size = parseFloat(getComputedStyle(text).fontSize) || 14
    while (text.scrollHeight > text.clientHeight + 1 && size > 8) {
      size = Math.max(8, size * 0.92)
      text.style.fontSize = `${size}px`
    }
  }
}

function PrintLayout({ doc, onClose }: { doc: PdfDocument; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const paper = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const titleId = useId()
  const apple = isAppleMobile(navigator)
  useDrawer({ open: true, onClose, panel })

  // While this is open only the document prints, and the page title is the PDF's file name.
  useEffect(() => {
    const root = document.documentElement
    const saved = document.title
    root.classList.add('is-printing')
    const restore = () => { document.title = saved }
    window.addEventListener('afterprint', restore)
    return () => {
      root.classList.remove('is-printing')
      window.removeEventListener('afterprint', restore)
      restore()
    }
  }, [])

  const print = () => {
    document.title = doc.fileTitle
    window.print()
  }

  // Narrow screens: the sheet keeps its printed width and is scaled down to fit.
  useEffect(() => {
    const stage = paper.current?.parentElement
    if (!stage || !paper.current) return
    const sheet = paper.current
    const fit = () => {
      const room = stage.clientWidth - parseFloat(getComputedStyle(stage).paddingLeft) - parseFloat(getComputedStyle(stage).paddingRight)
      sheet.style.setProperty('--pdoc-zoom', String(Math.min(1, Math.max(0.3, room / PAPER_PX))))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const printOnce = useRef(print)
  useEffect(() => {
    let live = true
    const prepare = async () => {
      await frame()
      try {
        await document.fonts?.ready
      } catch {
        // Fonts that fail fall back to system ones; the PDF is still readable.
      }
      if (!live || !paper.current) return
      fitForPaper(paper.current)
      await frame()
      if (!live) return
      setReady(true)
      printOnce.current()
    }
    void prepare()
    return () => { live = false }
  }, [])

  const running = (
    <div className="pdoc-running">
      <span className="pdoc-running__title">{doc.heading}</span>
      <span className="pdoc-running__scope">{doc.scope}</span>
    </div>
  )
  const footer = <div className="pdoc-running pdoc-running--foot"><span>Made with bindet</span></div>

  return createPortal(
    <div className="print-root" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="print-root__bar">
        <div className="print-root__text">
          <h2 className="print-root__title" id={titleId}>{doc.fileTitle}</h2>
          <p className="print-root__hint" role="status">
            {ready ? printHint(apple) : <><span className="ui-spinner" />Preparing your PDF…</>}
          </p>
        </div>
        <div className="print-root__actions">
          <button className="ui-button ui-button--primary print-root__print" type="button" disabled={!ready} onClick={print}>
            <PdfIcon />Save as PDF
          </button>
          <button className="ui-button print-root__close" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="print-root__stage">
        <div className={`pdoc${doc.pages ? ' pdoc--paged' : ''}`} ref={paper}>
          {doc.pages ? doc.pages.map((page, index) => (
            <section key={index} className="pdoc-page">
              {running}
              <div className="pdoc-page__body">{page}</div>
              {footer}
            </section>
          )) : (
            // thead and tfoot repeat on every printed page: the running header and footer.
            <table className="pdoc-frame">
              <thead><tr><td>{running}</td></tr></thead>
              <tfoot><tr><td>{footer}</td></tr></tfoot>
              <tbody><tr><td className="pdoc-frame__body">{doc.body}</td></tr></tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* The "Download PDF" button, its options sheet, and the print layout. */
export function PdfExport({ what, options = [], prepare, label = 'Download PDF', className = '', disabled }: Props) {
  const data = useData()
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [showHint, setShowHint] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const base = useId()
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const close = () => { if (!busy) setOpen(false) }
  useDrawer({ open, onClose: close, panel: sheet, returnFocus: button })

  function start() {
    setChoices(Object.fromEntries(options.map((option) => [option.id, option.initial])))
    setError('')
    setShowHint(!data.sandboxed && !hintSeen())
    setOpen(true)
  }

  async function create() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // Typeset math before laying out the document; offline, math prints as its source.
      await loadKatex().catch(() => undefined)
      const next = await prepare(choices)
      if (!live.current) return
      if (!data.sandboxed) rememberHint()
      setOpen(false)
      setDoc(next)
    } catch (reason) {
      if (live.current) setError(reason instanceof Error && reason.message ? reason.message : 'Couldn’t make the PDF. Try again.')
    } finally {
      if (live.current) setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={button}
        className={`ui-button ui-button--sm pdf-button ${className}`.trim()}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label={label === 'Download PDF' ? undefined : `Download a PDF of ${what}`}
        onClick={start}
      >
        <PdfIcon />{label}
      </button>
      {open ? createPortal(
        <div className="ui-dialog-backdrop pdf-sheet-backdrop" role="presentation" onClick={close}>
          <div
            ref={sheet}
            className="ui-dialog pdf-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${base}-title`}
            aria-describedby={`${base}-what`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ui-dialog__header pdf-sheet__header">
              <div>
                <h2 className="ui-dialog__title" id={`${base}-title`}>Download PDF</h2>
                <p className="pdf-sheet__what" id={`${base}-what`}>{what.charAt(0).toUpperCase() + what.slice(1)}</p>
              </div>
            </div>
            <div className="pdf-sheet__body">
              {options.map((option) => (
                <fieldset key={option.id} className="pdf-sheet__group" disabled={busy}>
                  <legend className="pdf-sheet__label">{option.label}</legend>
                  <div className="pdf-sheet__choices">
                    {option.choices.map((choice) => (
                      <label key={choice.value} className={`pdf-choice${choices[option.id] === choice.value ? ' is-selected' : ''}${choice.disabled ? ' is-disabled' : ''}`}>
                        <input
                          type="radio"
                          name={`${base}-${option.id}`}
                          value={choice.value}
                          checked={choices[option.id] === choice.value}
                          disabled={choice.disabled}
                          onChange={() => setChoices((current) => ({ ...current, [option.id]: choice.value }))}
                        />
                        <span className="pdf-choice__text">
                          <span className="pdf-choice__label">{choice.label}</span>
                          {choice.hint ? <span className="pdf-choice__hint">{choice.hint}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              {showHint ? (
                <p className="pdf-sheet__hint">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg>
                  {printHint(isAppleMobile(navigator))}
                </p>
              ) : null}
              {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}
            </div>
            <div className="ui-dialog__footer pdf-sheet__footer">
              <button className="ui-button pdf-sheet__cancel" type="button" disabled={busy} onClick={close}>Cancel</button>
              <button className={`ui-button ui-button--primary pdf-sheet__create${busy ? ' is-busy' : ''}`} type="button" disabled={busy} onClick={() => void create()}>
                {busy ? 'Preparing…' : 'Create PDF'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {doc ? <PrintLayout doc={doc} onClose={() => setDoc(null)} /> : null}
    </>
  )
}
