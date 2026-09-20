import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { courseInitial } from '../../lib/tones'
import { Paperclip } from './Illustrations'
import { prefersReducedMotion, useInView } from './motion'
import { storyUnit } from './story'

/*
 * Captured: a note goes in, bindit reads it, and the lines that matter come back
 * out as a flashcard and a quiz question. The transformation happens in the UI;
 * the four steps on the left only name what is on screen.
 */

const STEPS = [
  { title: 'Notes in', copy: 'A PDF, a Word doc, a text file, or a photo of your handwriting.' },
  { title: 'Read', copy: 'bindit pulls the text out and files it under the course and unit.' },
  { title: 'Flashcards', copy: 'Each unit builds a deck from its own notes.' },
  { title: 'Questions', copy: 'The same notes become quiz questions, graded with an explanation.' },
]

const LAST = STEPS.length - 1

export function Capture() {
  const cells = storyUnit('AP Biology', 'Cells')
  const stage = useRef<HTMLDivElement>(null)
  // The sequence starts when the desk itself is on screen, which on phones is well below the heading.
  const seen = useInView(stage, 0.45)
  // With reduced motion the finished composition is shown straight away and nothing advances on its own.
  const [step, setStep] = useState(() => (prefersReducedMotion() ? LAST : 0))
  const [auto, setAuto] = useState(() => !prefersReducedMotion())

  useEffect(() => {
    if (!seen || !auto || step >= LAST) return
    const timer = window.setTimeout(() => setStep((value) => Math.min(LAST, value + 1)), step === 0 ? 900 : 1500)
    return () => window.clearTimeout(timer)
  }, [seen, auto, step])

  const [cardFront, cardBack] = cells.cards[0]
  const question = cells.questions[0]

  return (
    <section className="lp-capture" id="capture" aria-labelledby="lp-capture-title" style={{ '--course': cells.tone } as CSSProperties}>
      <div className="lp-capture__copy">
        <p className="lp-kicker" data-reveal>Captured</p>
        <h2 className="lp-serif lp-capture__title" id="lp-capture-title" data-reveal>
          Drop in the notes.<br /><em>bindit reads them.</em>
        </h2>
        <ol className="lp-capture__steps" data-reveal>
          {STEPS.map((item, index) => (
            <li key={item.title}>
              <button
                type="button"
                className={`lp-capture__step${index === step ? ' is-current' : ''}${index < step ? ' is-done' : ''}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => { setAuto(false); setStep(index) }}
              >
                <span className="lp-capture__num">{String(index + 1).padStart(2, '0')}</span>
                <span className="lp-capture__step-title">{item.title}</span>
                <span className="lp-capture__step-copy">{item.copy}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className={`lp-capture__stage is-step-${step}`} ref={stage} aria-hidden="true">
        <article className="lp-note">
          <Paperclip className="lp-note__clip" />
          <header className="lp-note__head">
            <span className="lp-note__file">{cells.file}</span>
            <span className="lp-note__filed">
              <span className="lp-mark">{courseInitial(cells.course)}</span>
              {cells.course} <i>/</i> {cells.unit}
            </span>
          </header>
          <h3 className="lp-hand lp-note__title">Cell membrane — lecture notes</h3>
          <p className="lp-note__body">
            The membrane is a phospholipid bilayer. It is <mark>selectively permeable: it lets some substances through and blocks others.</mark>
          </p>
          <p className="lp-note__body">
            Water follows solute. <mark>In a hypertonic solution, water leaves the cell, so it shrinks.</mark> In a hypotonic solution the cell swells.
          </p>
          <p className="lp-note__body">
            Energy for active transport comes from ATP, <mark>made mostly in the mitochondria during cellular respiration.</mark>
          </p>
          <p className="lp-note__status"><span />Text extracted and ready.</p>
        </article>

        <div className="lp-capture__card">
          <span className="lp-capture__tag">Flashcard</span>
          <p className="lp-capture__q">{cardFront}</p>
          <p className="lp-capture__a">{cardBack}</p>
        </div>

        <div className="lp-capture__question">
          <span className="lp-capture__tag">Quiz question</span>
          <p className="lp-capture__q">{question.q}</p>
          <ul>
            {question.choices.map((choice) => <li key={choice}>{choice}</li>)}
          </ul>
        </div>
      </div>
    </section>
  )
}
