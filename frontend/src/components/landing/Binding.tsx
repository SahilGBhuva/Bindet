import { useRef, type CSSProperties, type ReactNode } from 'react'
import { courseInitial } from '../../lib/tones'
import { useScrollProgress } from './motion'
import { COURSE_TONE } from './story'

/*
 * Connected: bindit's signature image. Loose pieces of four courses straighten
 * out and violet threads bind each one to its unit, each unit to its course, and
 * every course into the binder. The threads only show relationships the product
 * really keeps: cards and questions come from a unit's notes, and units belong
 * to a course.
 *
 * Two layouts share the same pieces: a wide canvas (1200 x 640) that binds left
 * to right, and a tall one (400 x 640) for phones that binds top to bottom.
 */

type Point = [number, number]
type Piece = {
  id: string
  to: string
  at: Point
  phone?: Point
  scatter: [number, number, number]
  body: ReactNode
  kind: 'note' | 'term' | 'card' | 'file' | 'question'
}

const WIDE = { w: 1200, h: 640 }
const TALL = { w: 400, h: 640 }

const UNITS: { id: string; course: string; at: Point; phone: Point }[] = [
  { id: 'Cells', course: 'AP Biology', at: [668, 84], phone: [50, 336] },
  { id: 'Genetics', course: 'AP Biology', at: [706, 190], phone: [105, 392] },
  { id: 'Stoichiometry', course: 'Chemistry', at: [650, 312], phone: [190, 336] },
  { id: 'Logarithms', course: 'Algebra II', at: [700, 436], phone: [262, 392] },
  { id: 'Revolution', course: 'US History', at: [664, 556], phone: [340, 336] },
]

const COURSES: { id: string; at: Point; phone: Point }[] = [
  { id: 'AP Biology', at: [890, 138], phone: [80, 490] },
  { id: 'Chemistry', at: [924, 292], phone: [170, 502] },
  { id: 'Algebra II', at: [900, 424], phone: [250, 502] },
  { id: 'US History', at: [880, 548], phone: [330, 490] },
]

const BINDER: { at: Point; phone: Point } = { at: [1090, 330], phone: [200, 592] }

const PIECES: Piece[] = [
  { id: 'n1', to: 'Cells', kind: 'note', at: [190, 86], phone: [105, 54], scatter: [-46, -18, -7], body: <>The membrane is <mark>selectively permeable</mark>: it lets some substances through.</> },
  { id: 't1', to: 'Cells', kind: 'term', at: [452, 58], scatter: [38, -30, 9], body: 'hypertonic' },
  { id: 'c1', to: 'Genetics', kind: 'card', at: [356, 176], phone: [90, 172], scatter: [24, 26, 6], body: <><b>Question</b>What is an allele?</> },
  { id: 'f1', to: 'Genetics', kind: 'file', at: [118, 226], scatter: [-52, 8, -4], body: <><b>PDF</b>punnett-squares-lecture.pdf</> },
  { id: 'q1', to: 'Stoichiometry', kind: 'question', at: [226, 336], phone: [272, 138], scatter: [-30, -14, 5], body: <><b>Quiz</b>How many moles of water form from 4 moles of H₂?</> },
  { id: 't2', to: 'Stoichiometry', kind: 'term', at: [470, 298], phone: [305, 38], scatter: [44, 20, -8], body: 'limiting reactant' },
  { id: 't3', to: 'Logarithms', kind: 'term', at: [96, 440], scatter: [-40, 30, 10], body: 'log₂ 8 = 3' },
  { id: 'c2', to: 'Logarithms', kind: 'card', at: [372, 448], phone: [205, 282], scatter: [18, -34, -6], body: <><b>Question</b>log(x) + log(y) = ?</> },
  { id: 'n2', to: 'Revolution', kind: 'note', at: [204, 566], scatter: [-36, 28, 6], body: <>Colonists objected to <mark>taxation without representation</mark> in Parliament.</> },
  { id: 't4', to: 'Revolution', kind: 'term', at: [462, 580], phone: [338, 224], scatter: [50, 24, -9], body: 'Stamp Act, 1765' },
]

function thread(from: Point, to: Point, vertical: boolean) {
  const [ax, ay] = from
  const [bx, by] = to
  if (vertical) {
    const my = (ay + by) / 2
    return `M${ax} ${ay}C${ax} ${my} ${bx} ${my} ${bx} ${by}`
  }
  const mx = (ax + bx) / 2
  return `M${ax} ${ay}C${mx} ${ay} ${mx} ${by} ${bx} ${by}`
}

function Threads({ phone }: { phone: boolean }) {
  const size = phone ? TALL : WIDE
  const spot = (item: { at: Point; phone?: Point }) => (phone ? item.phone : item.at)
  const lines: { d: string; from: number; tone?: string }[] = []
  for (const piece of PIECES) {
    const a = spot(piece)
    const unit = UNITS.find((item) => item.id === piece.to)
    if (a && unit) lines.push({ d: thread(a, spot(unit) as Point, phone), from: 0 })
  }
  for (const unit of UNITS) {
    const course = COURSES.find((item) => item.id === unit.course)
    if (course) lines.push({ d: thread(spot(unit) as Point, spot(course) as Point, phone), from: 0.3, tone: COURSE_TONE[unit.course] })
  }
  for (const course of COURSES) lines.push({ d: thread(spot(course) as Point, spot(BINDER) as Point, phone), from: 0.58 })

  return (
    <svg className={`lp-bind__threads lp-bind__threads--${phone ? 'tall' : 'wide'}`} viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" fill="none" aria-hidden="true">
      {lines.map((line, index) => (
        <path key={index} d={line.d} pathLength={1} style={{ '--from': line.from, '--thread': line.tone } as CSSProperties} />
      ))}
    </svg>
  )
}

function place(at: Point, phone: Point | undefined): CSSProperties {
  return {
    '--x': `${(at[0] / WIDE.w) * 100}%`,
    '--y': `${(at[1] / WIDE.h) * 100}%`,
    '--px': phone ? `${(phone[0] / TALL.w) * 100}%` : undefined,
    '--py': phone ? `${(phone[1] / TALL.h) * 100}%` : undefined,
  } as CSSProperties
}

export function Binding() {
  const root = useRef<HTMLElement>(null)
  useScrollProgress(root)

  return (
    <section className="lp-bind lp-scrub" id="connected" ref={root} aria-labelledby="lp-bind-title">
      <div className="lp-bind__head">
        <p className="lp-kicker" data-reveal>Connected</p>
        <h2 className="lp-display lp-bind__title" id="lp-bind-title" data-reveal>Connected.</h2>
      </div>

      <div
        className="lp-bind__canvas"
        data-reveal
        role="img"
        aria-label="Pieces of four courses — note excerpts, key terms, flashcards, a quiz question and an uploaded file — are tied by threads to their units, the units to their courses, and every course into one binder."
      >
        <Threads phone={false} />
        <Threads phone />

        {PIECES.map((piece) => (
          <div
            key={piece.id}
            className={`lp-piece lp-piece--${piece.kind}${piece.phone ? '' : ' lp-piece--wide-only'}`}
            style={{
              ...place(piece.at, piece.phone),
              '--dx': `${piece.scatter[0]}px`,
              '--dy': `${piece.scatter[1]}px`,
              '--rot': `${piece.scatter[2]}deg`,
              '--course': COURSE_TONE[UNITS.find((unit) => unit.id === piece.to)?.course ?? ''],
            } as CSSProperties}
            aria-hidden="true"
          >
            {piece.body}
          </div>
        ))}

        {UNITS.map((unit) => (
          <div key={unit.id} className="lp-piece lp-piece--unit" style={{ ...place(unit.at, unit.phone), '--course': COURSE_TONE[unit.course] } as CSSProperties} aria-hidden="true">
            <i />{unit.id}
          </div>
        ))}

        {COURSES.map((course) => (
          <div key={course.id} className="lp-piece lp-piece--course" style={{ ...place(course.at, course.phone), '--course': COURSE_TONE[course.id] } as CSSProperties} aria-hidden="true">
            <span className="lp-mark lp-mark--lg">{courseInitial(course.id)}</span>
            <span className="lp-piece__course-name">{course.id}</span>
          </div>
        ))}

        <div className="lp-piece lp-piece--binder" style={place(BINDER.at, BINDER.phone)} aria-hidden="true">
          <img src="/bindit-binder.webp" alt="" width="440" height="483" loading="lazy" decoding="async" />
        </div>
      </div>

      <p className="lp-serif lp-bind__line" data-reveal>
        Every flashcard and question comes from your own notes, filed under the unit and course it belongs to.
      </p>
    </section>
  )
}
