import type { Flashcard, PracticeTest } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { cutoutSheets, printDate, printFileTitle, scopeLine } from '../../lib/printDoc'
import { guideKind } from '../../lib/studyGuides'
import type { StudyGuide } from '../../lib/studyGuides'
import { PdfExport } from './PdfExport'
import type { PdfDocument } from './PdfExport'
import { CutoutPage, FlashcardListPrint, GuidePrint, PracticeTestPrint } from './PrintDocuments'

/*
 * The "Download PDF" buttons for each kind of study material. All of them use PdfExport
 * (same button, same options sheet, same print layout) and read the clock through useData().
 */

const ANSWER_CHOICES = [
  { value: 'show', label: 'Show answers', hint: 'Practice answers print under each question.' },
  { value: 'hide', label: 'Hide answers', hint: 'Lines to write on instead, for testing yourself.' },
]

/*
 * A study guide. Pass the guide when it is already loaded (the reader), or just its id
 * (Otto's chat card): it is then fetched when the student creates the PDF.
 */
export function GuidePdfButton({ guide, guideId, accessToken, label, className }: {
  guide?: StudyGuide | null
  guideId?: string
  accessToken?: string
  label?: string
  className?: string
}) {
  const data = useData()
  async function prepare(choices: Record<string, string>): Promise<PdfDocument> {
    const loaded = guide ?? (guideId ? await data.getStudyGuide(guideId, accessToken) : null)
    if (!loaded) throw new Error('Couldn’t open this study guide.')
    const kind = guideKind(loaded.kind)
    const date = printDate(data.now())
    return {
      fileTitle: printFileTitle(loaded.title, kind.label),
      heading: loaded.title,
      scope: [scopeLine(loaded.course, loaded.unit), date].join(' · '),
      body: <GuidePrint guide={loaded} answers={choices.answers !== 'hide'} date={date} />,
    }
  }
  return (
    <PdfExport
      what={guide ? `“${guide.title}”` : 'this study guide'}
      options={[{ id: 'answers', label: 'Practice questions', choices: ANSWER_CHOICES, initial: 'show' }]}
      prepare={prepare}
      label={label}
      className={className}
    />
  )
}

/* A unit's flashcards: cut-out cards (8 to a page, backs mirrored for double-sided printing) or a two-column list. */
export function FlashcardsPdfButton({ cards, course, unit, className }: { cards: Flashcard[]; course: string; unit: string; className?: string }) {
  const data = useData()
  function prepare(choices: Record<string, string>): PdfDocument {
    const date = printDate(data.now())
    const base = {
      fileTitle: printFileTitle(unit, 'Flashcards'),
      heading: `${unit} flashcards`,
      scope: [scopeLine(course, unit), date].join(' · '),
    }
    if (choices.layout === 'list') return { ...base, body: <FlashcardListPrint cards={cards} course={course} unit={unit} date={date} /> }
    const sheets = cutoutSheets(cards)
    const numbers = new Map(cards.map((card, index) => [card.id, index + 1]))
    return {
      ...base,
      pages: sheets.flatMap((sheet, index) => {
        const label = `Sheet ${index + 1} of ${sheets.length}`
        return [
          <CutoutPage key={`f${index}`} slots={sheet.fronts} numbers={numbers} side="front" label={label} />,
          <CutoutPage key={`b${index}`} slots={sheet.backs} numbers={numbers} side="back" label={label} />,
        ]
      }),
    }
  }
  return (
    <PdfExport
      what={`the ${cards.length === 1 ? 'flashcard' : `${cards.length} flashcards`} in ${unit}`}
      options={[{
        id: 'layout',
        label: 'Layout',
        initial: 'cutout',
        choices: [
          { value: 'cutout', label: 'Cut-out cards', hint: '8 to a page. Print double-sided (flip on long edge) and cut along the dashed lines.' },
          { value: 'list', label: 'List', hint: 'Questions and answers side by side in two columns.' },
        ],
      }]}
      prepare={prepare}
      className={className}
      disabled={!cards.length}
    />
  )
}

/*
 * A practice test: the blank test, the test and its answer key, or the key alone. The key
 * needs the answers, which the server sends only after the test is submitted.
 */
export function PracticeTestPdfButton({ test, className }: { test: PracticeTest; className?: string }) {
  const data = useData()
  const submitted = test.status === 'submitted' && test.items.some((item) => item.answer !== undefined)
  const lockedHint = 'The answer key unlocks after you submit the test.'
  function prepare(choices: Record<string, string>): PdfDocument {
    const part = submitted && (choices.part === 'both' || choices.part === 'key') ? choices.part : 'test'
    const date = printDate(data.now())
    const scope = test.unit ?? test.course
    return {
      fileTitle: printFileTitle(scope, part === 'key' ? 'Answer key' : 'Practice test'),
      heading: part === 'key' ? `${scope} answer key` : `${scope} practice test`,
      scope: [scopeLine(test.course, test.unit), date].join(' · '),
      body: <PracticeTestPrint test={test} part={part} date={date} />,
    }
  }
  return (
    <PdfExport
      what="this practice test"
      options={[{
        id: 'part',
        label: 'What to print',
        initial: submitted ? 'both' : 'test',
        choices: [
          { value: 'test', label: 'Blank test', hint: 'Numbered questions, answer lines, and a name and date line.' },
          { value: 'both', label: 'Test and answer key', hint: submitted ? 'The key starts on a new page, with explanations.' : lockedHint, disabled: !submitted },
          { value: 'key', label: 'Answer key only', hint: submitted ? 'Answers and explanations for checking.' : lockedHint, disabled: !submitted },
        ],
      }]}
      prepare={prepare}
      className={className}
    />
  )
}
