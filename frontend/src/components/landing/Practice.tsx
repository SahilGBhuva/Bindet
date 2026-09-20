import { useRef, useState, type CSSProperties } from 'react'
import { courseInitial } from '../../lib/tones'
import { useScrollProgress } from './motion'
import { storyUnit } from './story'

/*
 * Practiced: the two study interactions from Tools, at the scale of the page.
 * Both mirror the real ones (a course-tinted card that flips; four choices that
 * resolve into an explanation or a hint) and use the demo student's content.
 */

export function FlashcardStage() {
  const genetics = storyUnit('AP Biology', 'Genetics')
  const root = useRef<HTMLElement>(null)
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  useScrollProgress(root)

  const total = genetics.cards.length
  const [front, back] = genetics.cards[index]
  const go = (step: number) => {
    setFlipped(false)
    setIndex((value) => (value + step + total) % total)
  }

  return (
    <section className="lp-flash lp-scrub" id="practice" ref={root} aria-labelledby="lp-flash-title" style={{ '--course': genetics.tone } as CSSProperties}>
      <p className="lp-kicker" data-reveal>Practiced</p>
      <h2 className="lp-serif lp-flash__title" id="lp-flash-title" data-reveal>Flip it until <em>it sticks.</em></h2>

      <div className="lp-flash__stage" data-reveal>
        <span className="lp-flash__under lp-flash__under--b" aria-hidden="true" />
        <span className="lp-flash__under lp-flash__under--a" aria-hidden="true" />
        <button
          key={index}
          type="button"
          className={`lp-flash__card${flipped ? ' is-flipped' : ''}`}
          onClick={() => setFlipped((open) => !open)}
          aria-label={flipped ? `Answer: ${back} Click to see the question.` : `Question: ${front} Click to reveal the answer.`}
        >
          <span className="lp-flash__face lp-flash__face--front" aria-hidden="true">
            <span className="lp-flash__label">Question</span>
            <span className="lp-flash__text">{front}</span>
            <span className="lp-flash__hint">Click to reveal the answer</span>
          </span>
          <span className="lp-flash__face lp-flash__face--back" aria-hidden="true">
            <span className="lp-flash__label">Answer</span>
            <span className="lp-flash__text lp-flash__text--answer">{back}</span>
            <span className="lp-flash__hint">Click to see the question</span>
          </span>
        </button>
      </div>

      <div className="lp-flash__nav" data-reveal>
        <span className="lp-flash__source">
          <span className="lp-mark">{courseInitial(genetics.course)}</span>
          {genetics.course} <i>/</i> {genetics.unit}
        </span>
        <span className="lp-flash__pager">
          <button type="button" onClick={() => go(-1)} aria-label="Previous card">←</button>
          <span aria-live="polite">{index + 1} of {total}</span>
          <button type="button" onClick={() => go(1)} aria-label="Next card">→</button>
        </span>
      </div>
    </section>
  )
}

const KEYS = ['A', 'B', 'C', 'D']

export function QuizStage() {
  const cells = storyUnit('AP Biology', 'Cells')
  const [turn, setTurn] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const question = cells.questions[turn % cells.questions.length]
  const correct = picked !== null && picked === question.answer
  const wrong = picked !== null && !correct

  return (
    <section className={`lp-quiz${correct ? ' is-solved' : ''}`} aria-labelledby="lp-quiz-title" style={{ '--course': cells.tone } as CSSProperties}>
      <div className="lp-quiz__copy">
        <h2 className="lp-serif lp-quiz__title" id="lp-quiz-title" data-reveal>
          Get it wrong here,<br /><em>not on the test.</em>
        </h2>
        <p className="lp-quiz__lead" data-reveal>
          Quiz questions come from the notes in each unit. Every answer is graded with an explanation, and a hint when you miss.
        </p>
      </div>

      <div className="lp-quiz__panel" data-reveal>
        <p className="lp-quiz__source">
          <span className="lp-mark">{courseInitial(cells.course)}</span>
          {cells.course} <i>/</i> {cells.unit} <i>·</i> from {cells.file}
        </p>
        <p className="lp-quiz__prompt">{question.q}</p>
        <div className="lp-quiz__choices" role="group" aria-label="Answer choices">
          {question.choices.map((choice, index) => {
            const mine = picked === choice
            return (
              <button
                key={choice}
                type="button"
                className={`lp-quiz__choice${mine ? (correct ? ' is-correct' : ' is-incorrect') : ''}`}
                aria-pressed={mine}
                disabled={correct}
                onClick={() => setPicked(choice)}
              >
                <span className="lp-quiz__key" aria-hidden="true">{KEYS[index]}</span>
                {choice}
              </button>
            )
          })}
        </div>

        <div className={`lp-quiz__result${picked ? ' is-open' : ''}`} role="status">
          <div>
            {correct ? (
              <div className="lp-quiz__verdict is-correct">
                <p className="lp-quiz__verdict-title">Correct <span>+10 XP</span></p>
                <p>{question.why}</p>
                <button type="button" className="lp-textlink" onClick={() => { setPicked(null); setTurn((value) => value + 1) }}>Next question →</button>
              </div>
            ) : null}
            {wrong ? (
              <div className="lp-quiz__verdict is-incorrect">
                <p className="lp-quiz__verdict-title">Not quite</p>
                <p>Hint: {question.hint}</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <img className="lp-quiz__otter" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" loading="lazy" decoding="async" />
    </section>
  )
}
