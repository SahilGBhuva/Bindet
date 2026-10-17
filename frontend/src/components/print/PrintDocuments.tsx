import type { Flashcard, PracticeItem, PracticeTest } from '../../lib/api'
import { answerLineCount, choiceLetter, correctChoice } from '../../lib/printDoc'
import { guideHidesAnswers, guideKind } from '../../lib/studyGuides'
import type { StudyGuide } from '../../lib/studyGuides'
import { MathText } from '../math/Math'

/*
 * The printable documents behind "Download PDF". Black ink on white paper whatever the app
 * theme (Print.css), math through the app's own KaTeX component, and no controls. Text from
 * the model is always rendered as text (MathText), never as HTML.
 */

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/* Text that may span lines (worked answers, multi-line questions), with math in any line. */
function Lines({ text }: { text: string }) {
  return <>{text.split('\n').map((line, index) => <span key={index} className="pdoc-line"><MathText text={line} /></span>)}</>
}

function AnswerSpace({ lines }: { lines: number }) {
  return <span className="pdoc-write" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index} />)}</span>
}

function DocHead({ eyebrow, title, meta, note }: { eyebrow: string; title: string; meta: string; note?: string }) {
  return (
    <header className="pdoc-head">
      <p className="pdoc-eyebrow">{eyebrow}</p>
      <h1 className="pdoc-title"><MathText text={title} /></h1>
      <p className="pdoc-meta">{meta}</p>
      {note ? <p className="pdoc-note">{note}</p> : null}
    </header>
  )
}

/* A study guide (or summary, cheat sheet, vocabulary list, practice set, timeline). */
export function GuidePrint({ guide, answers, date }: { guide: StudyGuide; answers: boolean; date: string }) {
  const kind = guideKind(guide.kind)
  const meta = [guide.unit ?? 'Whole course', guide.course, `from ${plural(guide.note_count, 'note')}`, date].filter(Boolean).join(' · ')
  return (
    <article className={`pdoc-guide pdoc-guide--${guide.kind}`}>
      <DocHead eyebrow={kind.label} title={guide.title} meta={meta} note="Made by Otto in bindet from your own notes. Check anything important against them." />
      {guide.sections.map((section, s) => {
        const practice = guideHidesAnswers(guide.kind, section)
        return (
          <section key={s} className="pdoc-section">
            <h2 className="pdoc-h2"><MathText text={section.heading} /></h2>
            {section.bullets.length ? (
              <ul className="pdoc-bullets">
                {section.bullets.map((bullet, index) => <li key={index}><MathText text={bullet} /></li>)}
              </ul>
            ) : null}
            {section.terms.length ? (
              <table className="pdoc-table pdoc-terms">
                <thead>
                  <tr><th scope="col">{guide.kind === 'timeline' ? 'When' : 'Term'}</th><th scope="col">{guide.kind === 'timeline' ? 'What happened' : 'Definition'}</th></tr>
                </thead>
                <tbody>
                  {section.terms.map((term, index) => (
                    <tr key={index}>
                      <th scope="row"><MathText text={term.term} /></th>
                      <td><MathText text={term.definition} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {section.items.length ? (
              <ol className="pdoc-items">
                {section.items.map((item, index) => (
                  <li key={index} className="pdoc-item">
                    <div className="pdoc-item__q"><Lines text={item.question} /></div>
                    {practice && !answers ? <AnswerSpace lines={answerLineCount(item.question)} /> : (
                      <div className="pdoc-answer">
                        <span className="pdoc-answer__label">{practice ? 'Answer' : 'Solution'}</span>
                        <Lines text={item.answer} />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        )
      })}
    </article>
  )
}

/* A unit's flashcards as a two-column list: question and answer side by side. */
export function FlashcardListPrint({ cards, course, unit, date }: { cards: Flashcard[]; course: string; unit: string; date: string }) {
  return (
    <article className="pdoc-cards-list">
      <DocHead eyebrow="Flashcards" title={unit} meta={[course, plural(cards.length, 'card'), date].join(' · ')} note="Fold the page down the middle to quiz yourself." />
      <table className="pdoc-table pdoc-qa">
        <thead>
          <tr><th scope="col" className="pdoc-qa__num">#</th><th scope="col">Question</th><th scope="col">Answer</th></tr>
        </thead>
        <tbody>
          {cards.map((card, index) => (
            <tr key={card.id}>
              <td className="pdoc-qa__num">{index + 1}</td>
              <td><Lines text={card.front} /></td>
              <td><Lines text={card.back} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  )
}

function CutCard({ card, number, side }: { card: Flashcard | null; number: number; side: 'front' | 'back' }) {
  if (!card) return <div className="pdoc-card is-empty" />
  return (
    <div className={`pdoc-card pdoc-card--${side}`}>
      <span className="pdoc-card__top">
        <span className="pdoc-card__label">{side === 'front' ? 'Question' : 'Answer'}</span>
        <span className="pdoc-card__num">{number}</span>
      </span>
      <span className="pdoc-card__text"><Lines text={side === 'front' ? card.front : card.back} /></span>
      {side === 'front' && card.topic ? <span className="pdoc-card__topic">{card.topic}</span> : null}
    </div>
  )
}

/*
 * One page of cut-out cards: the fronts of a sheet, or its backs (already mirrored by
 * cutoutSheets, so printing double-sided and flipping on the long edge puts every answer
 * behind its question).
 */
export function CutoutPage({ slots, numbers, side, label }: { slots: (Flashcard | null)[]; numbers: Map<string, number>; side: 'front' | 'back'; label: string }) {
  return (
    <div className="pdoc-sheet">
      <p className="pdoc-sheet__label">
        <strong>{side === 'front' ? 'Fronts' : 'Backs'}</strong> · {label} · {side === 'front'
          ? 'Print double-sided (flip on long edge), then cut along the dashed lines.'
          : 'Mirrored so each answer prints behind its question.'}
      </p>
      <div className="pdoc-grid">
        {slots.map((card, slot) => <CutCard key={slot} card={card} number={card ? numbers.get(card.id) ?? 0 : 0} side={side} />)}
      </div>
    </div>
  )
}

function Question({ item, number }: { item: PracticeItem; number: number }) {
  return (
    <li className="pdoc-question" value={number}>
      <div className="pdoc-question__prompt"><Lines text={item.prompt} /></div>
      {item.type === 'multiple_choice' && item.choices.length ? (
        <ol className="pdoc-choices">
          {item.choices.map((choice, index) => (
            <li key={index}>
              <span className="pdoc-bubble" aria-hidden="true">{choiceLetter(index)}</span>
              <span className="pdoc-choice"><MathText text={choice} /></span>
            </li>
          ))}
        </ol>
      ) : <AnswerSpace lines={answerLineCount(item.prompt)} />}
    </li>
  )
}

/*
 * A practice test on paper: the blank test (name and date lines, the time limit, numbered
 * questions with choices or answer lines), the answer key with explanations, or both (the key
 * starts on a new page). The server sends answers only once a test is submitted.
 */
export function PracticeTestPrint({ test, part, date }: { test: PracticeTest; part: 'test' | 'both' | 'key'; date: string }) {
  const items = [...test.items].sort((a, b) => a.position - b.position)
  const scope = test.unit ?? 'Whole course'
  const limit = test.time_limit_s ? `Time limit: ${Math.round(test.time_limit_s / 60)} minutes` : 'Untimed'
  const meta = [test.course, plural(items.length, 'question'), limit].join(' · ')
  const multipleChoice = items.some((item) => item.type === 'multiple_choice')
  const shortAnswer = items.some((item) => item.type !== 'multiple_choice')
  return (
    <article className="pdoc-test">
      {part !== 'key' ? (
        <section className="pdoc-test__paper">
          <DocHead eyebrow="Practice test" title={scope} meta={meta} />
          <div className="pdoc-fields">
            <span className="pdoc-field pdoc-field--name">Name<span className="pdoc-field__line" /></span>
            <span className="pdoc-field">Date<span className="pdoc-field__line" /></span>
            <span className="pdoc-field pdoc-field--score">Score<span className="pdoc-field__line" />/ {items.length}</span>
          </div>
          <p className="pdoc-instructions">
            {[multipleChoice ? 'Circle the letter of the best answer.' : '', shortAnswer ? 'Write short answers on the lines: a word, number or short phrase is enough.' : ''].filter(Boolean).join(' ')}
            {test.time_limit_s ? ` You have ${Math.round(test.time_limit_s / 60)} minutes.` : ''}
          </p>
          <ol className="pdoc-questions">
            {items.map((item, index) => <Question key={item.position} item={item} number={index + 1} />)}
          </ol>
        </section>
      ) : null}
      {part !== 'test' ? (
        <section className={`pdoc-key${part === 'both' ? ' pdoc-key--new-page' : ''}`}>
          <DocHead eyebrow="Answer key" title={scope} meta={[test.course, plural(items.length, 'question'), date].join(' · ')} />
          <ol className="pdoc-key__list">
            {items.map((item, index) => {
              const letter = item.type === 'multiple_choice' ? correctChoice(item.choices, item.answer) : ''
              return (
                <li key={item.position} className="pdoc-key__item" value={index + 1}>
                  <div className="pdoc-key__prompt"><Lines text={item.prompt} /></div>
                  <p className="pdoc-key__answer">
                    <span className="pdoc-answer__label">Answer</span>
                    {letter ? <strong className="pdoc-key__letter">{letter}</strong> : null}
                    <MathText text={item.answer ?? ''} />
                  </p>
                  {item.explanation ? <p className="pdoc-key__why"><strong>Why:</strong> <MathText text={item.explanation} /></p> : null}
                  {item.topic ? <p className="pdoc-key__topic">Topic: {item.topic}</p> : null}
                </li>
              )
            })}
          </ol>
        </section>
      ) : null}
    </article>
  )
}
