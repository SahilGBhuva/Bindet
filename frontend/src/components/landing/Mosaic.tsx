import { useRef, type CSSProperties, type ReactNode } from 'react'
import { Paperclip, Scribble } from './Illustrations'
import { useScrollProgress } from './motion'
import { COURSE_TONE } from './story'

/*
 * The knowledge mosaic: one student's semester before bindit. Every tile is an
 * original, fictional study artifact built from HTML and SVG, drawn from the
 * same four demo courses as the live demo. The field is wider than the screen
 * and fades out at its edges. It is one image to assistive tech.
 */

const BIO = COURSE_TONE['AP Biology']
const CHEM = COURSE_TONE.Chemistry
const HIST = COURSE_TONE['US History']
const ALG = COURSE_TONE['Algebra II']

type TileProps = { kind: string; tilt?: number; tone?: string; children: ReactNode }

function Tile({ kind, tilt = 0, tone, children }: TileProps) {
  return (
    <div className={`lp-tile lp-tile--${kind}`} style={{ '--tilt': `${tilt}deg`, '--course': tone } as CSSProperties}>
      {children}
    </div>
  )
}

function FileTile({ name, type, where, tone, tilt }: { name: string; type: string; where: string; tone: string; tilt?: number }) {
  return (
    <Tile kind="file" tone={tone} tilt={tilt}>
      <span className="lp-tile__ext">{type}</span>
      <span className="lp-tile__file">
        <b>{name}</b>
        <i>{where}</i>
      </span>
    </Tile>
  )
}

function PunnettNote() {
  return (
    <Tile kind="lined" tilt={-2.2} tone={BIO}>
      <p className="lp-hand lp-hand--title">Punnett squares</p>
      <svg className="lp-tile__figure" viewBox="0 0 150 130" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M40 30h98M40 78h98M40 124h98M42 28v98M90 28v98M137 28v98" />
        <g className="lp-hand" fill="currentColor" stroke="none" fontSize="22">
          <text x="60" y="22">A</text><text x="108" y="22">a</text>
          <text x="18" y="62">A</text><text x="20" y="108">a</text>
          <text x="54" y="62">AA</text><text x="102" y="62">Aa</text>
          <text x="54" y="108">Aa</text><text x="104" y="108" fill="var(--course)">aa</text>
        </g>
        <circle cx="114" cy="101" r="17" stroke="var(--course)" />
      </svg>
      <p className="lp-hand">3 : 1 dominant to recessive<Scribble className="lp-tile__scribble" /></p>
    </Tile>
  )
}

function Excerpt() {
  return (
    <Tile kind="print" tilt={1.4}>
      <p className="lp-tile__running">7 · Membranes and transport</p>
      <p className="lp-tile__prose">
        The cell membrane is <mark>selectively permeable</mark>: it regulates what enters and leaves the cell. Water moves toward the side with
        more dissolved particles, so a cell placed in a <mark>hypertonic</mark> solution loses water and shrinks.
      </p>
      <p className="lp-tile__folio">112</p>
    </Tile>
  )
}

function Equation() {
  return (
    <Tile kind="sheet" tilt={-1.2} tone={CHEM}>
      <p className="lp-tile__running">Mole ratios · worksheet 4</p>
      <p className="lp-tile__equation">2H₂ + O₂ → 2H₂O</p>
      <p className="lp-hand lp-hand--ink">4 mol H₂ → <span>4 mol H₂O</span></p>
      <p className="lp-hand lp-hand--ink lp-hand--sm">ratio 2 : 2 ✓</p>
    </Tile>
  )
}

function LogGraph() {
  return (
    <Tile kind="graph" tilt={2} tone={ALG}>
      <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeOpacity="0.12">
          {[30, 60, 90, 120].map((y) => <path key={y} d={`M24 ${y}h186`} />)}
          {[60, 100, 140, 180].map((x) => <path key={x} d={`M${x} 12v122`} />)}
        </g>
        <path d="M24 12v122h186" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.4" />
        <path d="M30 132c6-58 22-80 52-94s74-20 124-24" stroke="var(--course)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="120" cy="30" r="4.5" fill="var(--course)" />
        <path d="M120 30v104" stroke="var(--course)" strokeDasharray="3 4" strokeOpacity="0.6" />
      </svg>
      <p className="lp-tile__caption"><b>y = log₂ x</b><span>log₂ 8 = 3</span></p>
    </Tile>
  )
}

function Timeline() {
  const dates: [string, string][] = [['1607', 'Jamestown founded'], ['1620', 'Mayflower Compact'], ['1765', 'Stamp Act'], ['1776', 'Declaration adopted']]
  return (
    <Tile kind="timeline" tilt={-0.8} tone={HIST}>
      <p className="lp-tile__running">US History · dates to know</p>
      <ol>
        {dates.map(([year, what]) => (
          <li key={year}><b>{year}</b><span>{what}</span></li>
        ))}
      </ol>
    </Tile>
  )
}

function CardTile({ tone, label, text, tilt }: { tone: string; label: string; text: string; tilt?: number }) {
  return (
    <Tile kind="card" tone={tone} tilt={tilt}>
      <span className="lp-tile__label">{label}</span>
      <span className="lp-tile__card-text">{text}</span>
    </Tile>
  )
}

function QuizTile() {
  return (
    <Tile kind="quiz" tilt={1.8}>
      <p className="lp-tile__prompt">Which organelle produces most of a cell’s ATP?</p>
      <span className="lp-tile__choice is-correct">Mitochondria</span>
      <span className="lp-tile__choice">Ribosome</span>
      <span className="lp-tile__choice">Golgi apparatus</span>
    </Tile>
  )
}

function Sticky() {
  return (
    <Tile kind="sticky" tilt={-3.5}>
      <p className="lp-hand lp-hand--ink">chem quiz FRIDAY</p>
      <p className="lp-hand lp-hand--ink lp-hand--sm">limiting reactant = runs out first!!</p>
    </Tile>
  )
}

function CellDiagram() {
  return (
    <Tile kind="diagram" tilt={0.6} tone={BIO}>
      <svg viewBox="0 0 220 170" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M110 14c46 0 92 26 92 70s-42 74-92 74-92-28-92-72 46-72 92-72z" />
        <path d="M110 22c42 0 84 24 84 62s-38 66-84 66-84-24-84-64 42-64 84-64z" strokeOpacity="0.35" strokeDasharray="2 5" />
        <circle cx="96" cy="88" r="24" stroke="var(--course)" />
        <circle cx="102" cy="84" r="7" fill="var(--course)" fillOpacity="0.2" stroke="var(--course)" />
        <path d="M148 58c10-4 22 2 24 12s-6 18-16 18-18-8-16-18c1-5 4-10 8-12z" />
        <path d="M146 72c5-3 8 3 13 0s6-5 10-3" strokeOpacity="0.6" />
        <path d="M56 118c6-6 16-4 20 2s0 14-8 16-16-2-16-8 1-7 4-10z" />
      </svg>
      <p className="lp-hand lp-hand--ink lp-hand--sm lp-tile__callout lp-tile__callout--a">nucleus</p>
      <p className="lp-hand lp-hand--ink lp-hand--sm lp-tile__callout lp-tile__callout--b">mitochondria → ATP</p>
    </Tile>
  )
}

function PhotoNote() {
  return (
    <Tile kind="photo" tilt={2.6}>
      <Paperclip className="lp-tile__clip" />
      <p className="lp-hand lp-hand--ink">hypertonic →</p>
      <p className="lp-hand lp-hand--ink">water LEAVES the cell</p>
      <p className="lp-hand lp-hand--ink">→ cell shrinks</p>
      <p className="lp-hand lp-hand--ink lp-hand--sm">(more solute outside)</p>
    </Tile>
  )
}

function Parabola() {
  return (
    <Tile kind="graph" tilt={-1.6} tone={ALG}>
      <svg viewBox="0 0 220 150" fill="none" aria-hidden="true">
        <path d="M14 118h196M70 10v130" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.4" />
        <path d="M24 22c18 64 30 96 46 96s28-32 46-96" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" strokeDasharray="4 5" strokeLinecap="round" />
        <path d="M84 22c18 64 30 96 46 96s28-32 46-96" stroke="var(--course)" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M78 132h44m-7-5 7 5-7 5" stroke="var(--course)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className="lp-tile__caption"><b>f(x − 2)</b><span>shifts right 2</span></p>
    </Tile>
  )
}

function RingTile() {
  return (
    <Tile kind="ring" tilt={-1} tone={BIO}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" strokeOpacity="0.1" strokeWidth="6" />
        <circle cx="32" cy="32" r="26" fill="none" stroke="var(--course)" strokeWidth="6" strokeLinecap="round" pathLength="100" strokeDasharray="100" strokeDashoffset="14" transform="rotate(-90 32 32)" />
      </svg>
      <span className="lp-tile__file"><b>Cells</b><i>AP Biology · quizzed 24 times</i></span>
    </Tile>
  )
}

const COLUMNS: { offset: number; drift: number; tiles: ReactNode[] }[] = [
  { offset: 40, drift: -26, tiles: [<FileTile key="f1" name="natural-selection.pdf" type="PDF" where="AP Biology" tone={BIO} tilt={1.5} />, <Timeline key="t" />, <CardTile key="c" tone={CHEM} label="Question" text="What is the limiting reactant?" tilt={-2} />] },
  { offset: -30, drift: 34, tiles: [<PunnettNote key="p" />, <Sticky key="s" />, <FileTile key="f2" name="log-rules.md" type="MD" where="Algebra II" tone={ALG} tilt={-1} />] },
  { offset: 70, drift: -18, tiles: [<Excerpt key="e" />, <LogGraph key="l" />, <RingTile key="r" />] },
  { offset: -10, drift: 28, tiles: [<CardTile key="c1" tone={BIO} label="Question" text="What is an allele?" tilt={2.4} />, <CellDiagram key="d" />, <FileTile key="f3" name="mole-ratios-worksheet.docx" type="DOCX" where="Chemistry" tone={CHEM} tilt={1} />, <QuizTile key="q" />] },
  { offset: 56, drift: -30, tiles: [<Equation key="eq" />, <PhotoNote key="ph" />, <CardTile key="c2" tone={HIST} label="Answer" text="July 4, 1776." tilt={-1.5} />] },
  { offset: -24, drift: 22, tiles: [<FileTile key="f4" name="cell-membrane-notes.jpg" type="JPG" where="AP Biology" tone={BIO} tilt={-2} />, <Parabola key="pa" />, <CardTile key="c3" tone={ALG} label="Question" text="What does −f(x) do to a graph?" tilt={1.2} />] },
]

export function Mosaic() {
  const field = useRef<HTMLDivElement>(null)
  useScrollProgress(field)

  return (
    <div
      className="lp-mosaic lp-scrub"
      ref={field}
      role="img"
      aria-label="A collage of one student’s scattered study material: handwritten genetics notes, a textbook passage about cell membranes, a chemistry worksheet, history dates, algebra graphs, uploaded files, flashcards and a quiz question."
    >
      <div className="lp-mosaic__fade">
        <div className="lp-mosaic__field" aria-hidden="true">
          {COLUMNS.map((column, index) => (
            <div key={index} className="lp-mosaic__col" style={{ '--offset': `${column.offset}px`, '--drift': `${column.drift}px` } as CSSProperties}>
              {column.tiles}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
