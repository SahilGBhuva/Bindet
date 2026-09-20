import { useEffect, useMemo, useState } from 'react'
import type { Progress as ProgressData } from '../lib/api'
import { useData } from '../lib/dataSource'
import type { AuthSession } from '../lib/auth'
import {
  VERDICT_COPY,
  areaPath,
  buildCoursePulse,
  smoothPath,
  type CoursePulse,
  type UnitJudgment,
} from '../lib/progress'
import { withCourseTones } from '../lib/session'
import { courseInitial } from '../lib/tones'
import { Icons } from '../components/Icons'
import './Progress.css'

const GRAPH = { w: 720, h: 248, x: 44, y: 22 }

type ProgressProps = {
  session: AuthSession | null
}

export function Progress({ session }: ProgressProps) {
  const data = useData()
  const studentId = session?.user.id ?? data.getStudentId()
  const [stats, setStats] = useState<ProgressData | null>(() => data.getCachedProgress(studentId))
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [selected, setSelected] = useState(() => notebook.activeCourse || notebook.courses[0]?.name || '')
  const [focusUnit, setFocusUnit] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)

  useEffect(() => {
    void data.getProgress(studentId, session?.access_token, true).then(setStats).catch(() => undefined)
  }, [data, studentId, session?.access_token])

  useEffect(() => {
    const sync = () => {
      const loaded = data.loadNotebook()
      const courses = withCourseTones(loaded.courses)
      setNotebook({ ...loaded, courses })
      setSelected((current) =>
        courses.some((course) => course.name === current) ? current : courses[0]?.name ?? '',
      )
    }
    sync()
    window.addEventListener('storage', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [data])

  const attempts = useMemo(() => data.loadUnitAttempts(), [data, notebook, stats, selected])
  const courses = notebook.courses
  const activeCourse = courses.find((course) => course.name === selected) ?? courses[0]
  const pulse = useMemo(
    () =>
      activeCourse
        ? buildCoursePulse(activeCourse, notebook.deposits, attempts, stats?.topics ?? [])
        : null,
    [activeCourse, notebook.deposits, attempts, stats],
  )

  return (
    <div className="ui-page progress">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Progress</h1>
          <p className="ui-page-subtitle">Each course gets its own mastery graph and unit roadmap. Judgment uses quiz history, accuracy, and notes.</p>
        </div>
      </header>

      {courses.length === 0 || !pulse ? (
        <div className="ui-panel">
          <div className="ui-empty">
            <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" />
            <p className="ui-empty__title">No courses yet</p>
            <p className="ui-empty__copy">Add a course in Tools and this page will grow a graph and roadmap for it.</p>
            <a className="ui-button ui-button--primary" href="#tools">Open Tools</a>
          </div>
        </div>
      ) : (
        <>
          <nav className="ui-tabs progress__courses" role="tablist" aria-label="Courses">
            {courses.map((course) => (
              <button
                key={course.name}
                type="button"
                role="tab"
                aria-selected={course.name === pulse.course.name}
                className="ui-tab progress__course"
                onClick={() => {
                  setSelected(course.name)
                  setFocusUnit('')
                  setHover(null)
                }}
              >
                <span className="ui-course-mark ui-course-mark--sm" style={{ ['--course' as string]: course.tone ?? '#0b58f5' }} aria-hidden="true">{courseInitial(course.name)}</span>
                <span className="progress__course-name">{course.name}</span>
              </button>
            ))}
          </nav>

          <CourseBoard
            pulse={pulse}
            stats={stats}
            focusUnit={focusUnit}
            hover={hover}
            infoOpen={infoOpen}
            onInfo={() => setInfoOpen((open) => !open)}
            onFocus={setFocusUnit}
            onHover={setHover}
          />
        </>
      )}
    </div>
  )
}

function CourseBoard({
  pulse,
  stats,
  focusUnit,
  hover,
  infoOpen,
  onInfo,
  onFocus,
  onHover,
}: {
  pulse: CoursePulse
  stats: ProgressData | null
  focusUnit: string
  hover: number | null
  infoOpen: boolean
  onInfo: () => void
  onFocus: (name: string) => void
  onHover: (index: number | null) => void
}) {
  const { palette, course } = pulse
  const hasUnits = course.units.length > 0
  const activeLine = pulse.series.find((line) => line.name === focusUnit)
  const hoverIndex = hover ?? pulse.labels.length - 1
  const hoverValue = (activeLine?.values ?? pulse.overall)[hoverIndex] ?? pulse.mastery

  useEffect(() => {
    if (!infoOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onInfo()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [infoOpen, onInfo])

  return (
    <div className="progress__board">
      <section className="ui-panel progress__summary" style={{ ['--course' as string]: palette.tone }} aria-label={`${course.name} summary`}>
        <div className="progress__summary-main">
          <span className="progress__eyebrow">
            <span className="ui-course-mark ui-course-mark--sm" aria-hidden="true">{courseInitial(course.name)}</span>
            {course.name}
          </span>
          <p className="progress__mastery">
            {pulse.mastery}
            <span className="progress__mastery-unit">mastery</span>
          </p>
          <p className="progress__reason">{pulse.reason}</p>
        </div>
        <div className="progress__summary-side">
          <div className="progress__badges">
            <span className={`ui-badge ${verdictTone(pulse.verdict)}`}>{VERDICT_COPY[pulse.verdict].label}</span>
            <span className={`ui-badge ${pulse.live ? 'ui-badge--positive' : ''}`}>
              {pulse.live ? 'Live quizzes' : hasUnits ? 'No quizzes yet' : 'No units yet'}
            </span>
          </div>
          <div className="progress__info-anchor">
            <button
              type="button"
              className="ui-button ui-button--ghost ui-button--sm progress__info"
              aria-expanded={infoOpen}
              aria-controls="progress-info-panel"
              onClick={onInfo}
            >
              <InfoMark />
              How progress works
            </button>
            {infoOpen ? <ProgressInfo onClose={onInfo} /> : null}
          </div>
        </div>
      </section>

      <section className="ui-panel ui-stats progress__stats" aria-label="Account stats">
        <div className="ui-stat ui-tone--orange">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.flame}</span>Streak</span>
          <span className="ui-stat__value">{stats?.login_streak ?? '—'}<span className="ui-stat__unit">{stats?.login_streak === 1 ? 'day' : 'days'}</span></span>
        </div>
        <div className="ui-stat ui-tone--violet">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.sparkle}</span>XP</span>
          <span className="ui-stat__value">{stats ? stats.total_xp.toLocaleString() : '—'}</span>
        </div>
        <div className={`ui-stat ${stats && stats.attempts && stats.accuracy < 70 ? 'ui-tone--amber' : 'ui-tone--green'}`}>
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.check}</span>Accuracy</span>
          <span className="ui-stat__value">{stats ? `${stats.accuracy}%` : '—'}</span>
        </div>
        <div className="ui-stat ui-tone--blue">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.arrow}</span>Next up</span>
          <span className="ui-stat__value progress__next">{pulse.recommended || '—'}</span>
        </div>
      </section>

      <section className="ui-section" aria-labelledby="progress-graph-title">
        <div className="ui-section-head">
          <h2 className="ui-section-title" id="progress-graph-title">{course.name} mastery by session</h2>
          <span className="ui-count">
            {hasUnits
              ? `${activeLine ? activeLine.name : 'Course average'} · session ${hoverIndex + 1} · ${hoverValue}%`
              : 'Add units in Tools to start this graph'}
          </span>
        </div>
        <figure className="ui-panel progress__graph">
          {hasUnits ? (
            <>
              <PulseGraph pulse={pulse} focusUnit={focusUnit} hover={hover} onHover={onHover} />
              <ul className="progress__legend" aria-label="Show a line">
                <li>
                  <button type="button" aria-pressed={!focusUnit} className="progress__legend-item" onClick={() => onFocus('')}>
                    <i style={{ background: palette.line }} />
                    Average
                  </button>
                </li>
                {pulse.series.map((line) => (
                  <li key={line.name}>
                    <button
                      type="button"
                      aria-pressed={focusUnit === line.name}
                      className="progress__legend-item"
                      onClick={() => onFocus(focusUnit === line.name ? '' : line.name)}
                    >
                      <i style={{ background: line.color }} />
                      {line.name}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="progress__note">This course has no units yet, so there is nothing to plot.</p>
          )}
          {hasUnits && !pulse.live ? (
            <p className="progress__note">Quiz these units in Tools to fill the graph.</p>
          ) : null}
        </figure>
      </section>

      <section className="ui-section" aria-labelledby="progress-roadmap-title">
        <div className="ui-section-head">
          <h2 className="ui-section-title" id="progress-roadmap-title">Unit roadmap</h2>
          <span className="ui-count">The next unit to work on is marked.</span>
        </div>
        {hasUnits ? (
          <ol className="ui-cards progress__trail">
            {pulse.units.map((unit, index) => (
              <RoadNode
                key={unit.name}
                unit={unit}
                color={pulse.series[index]?.color ?? palette.line}
                next={unit.name === pulse.recommended}
                selected={unit.name === focusUnit}
                onSelect={() => onFocus(focusUnit === unit.name ? '' : unit.name)}
              />
            ))}
          </ol>
        ) : (
          <div className="ui-panel">
            <p className="progress__note">
              Create units for {course.name} in <a className="ui-link" href="#tools">Tools</a>, then they will show up here.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}

function PulseGraph({
  pulse,
  focusUnit,
  hover,
  onHover,
}: {
  pulse: CoursePulse
  focusUnit: string
  hover: number | null
  onHover: (index: number | null) => void
}) {
  const { w, h, x, y } = GRAPH
  const ticks = [0, 25, 50, 75, 100]
  const focused = pulse.series.find((line) => line.name === focusUnit)
  const shown = focused ? [focused] : pulse.series
  const main = focused?.values ?? pulse.overall
  const mainColor = focused?.color ?? pulse.palette.line
  const hoverIndex = hover ?? main.length - 1
  const points = main.map((value, index) => {
    const innerW = w - x * 2
    const innerH = h - y * 2
    return {
      x: x + (main.length === 1 ? innerW / 2 : (index / (main.length - 1)) * innerW),
      y: y + (1 - value / 100) * innerH,
    }
  })
  const mark = points[hoverIndex]

  function nearest(clientX: number, target: SVGSVGElement) {
    const box = target.getBoundingClientRect()
    const local = ((clientX - box.left) / box.width) * w
    let best = 0
    let dist = Infinity
    points.forEach((point, index) => {
      const gap = Math.abs(point.x - local)
      if (gap < dist) {
        dist = gap
        best = index
      }
    })
    onHover(best)
  }

  return (
    <svg
      className="progress-svg"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`${pulse.course.name} mastery from session 1 to ${pulse.labels.length}`}
      onMouseMove={(event) => nearest(event.clientX, event.currentTarget)}
      onMouseLeave={() => onHover(null)}
    >
      <defs>
        <linearGradient id={`pulse-fill-${cssId(pulse.course.name)}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={mainColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={mainColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => {
        const gy = y + (1 - tick / 100) * (h - y * 2)
        return (
          <g key={tick}>
            <line className="progress-svg__grid" x1={x} x2={w - x} y1={gy} y2={gy} />
            <text className="progress-svg__tick" x={x - 8} y={gy + 4}>
              {tick}
            </text>
          </g>
        )
      })}
      <path
        d={areaPath(main, w, h, x, y)}
        fill={`url(#pulse-fill-${cssId(pulse.course.name)})`}
      />
      {shown.map((line) => (
        <path
          key={line.name}
          d={smoothPath(line.values, w, h, x, y)}
          fill="none"
          stroke={line.color}
          strokeWidth={focused || pulse.series.length === 1 ? 4 : 2.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={focused || !focusUnit ? 1 : 0.4}
        />
      ))}
      {!focused && pulse.series.length > 1 ? (
        <path
          d={smoothPath(pulse.overall, w, h, x, y)}
          fill="none"
          stroke={pulse.palette.line}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="5 6"
          opacity="0.85"
        />
      ) : null}
      {pulse.labels.map((label, index) => (
        <text key={label} className="progress-svg__label" x={points[index]?.x ?? 0} y={h - 4}>
          {label}
        </text>
      ))}
      {mark ? (
        <>
          <line className="progress-svg__hover" x1={mark.x} x2={mark.x} y1={y} y2={h - y} />
          <circle cx={mark.x} cy={mark.y} r="6.5" fill={mainColor} stroke="#ffffff" strokeWidth="3" />
        </>
      ) : null}
    </svg>
  )
}

function RoadNode({
  unit,
  color,
  next,
  selected,
  onSelect,
}: {
  unit: UnitJudgment
  color: string
  next: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        className={`ui-card progress__node${next ? ' is-next' : ''}${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="progress__node-top">
          <span className="progress__ring" style={{ background: ring(unit.mastery, color) }}>
            <b>{unit.mastery}</b>
          </span>
          {next ? <span className="ui-badge ui-badge--accent">Next up</span> : null}
        </span>
        <span className="ui-card__title">{unit.name}</span>
        <span className="progress__node-meta">
          <span className={`ui-badge ${verdictTone(unit.verdict)}`}>{VERDICT_COPY[unit.verdict].label}</span>
          <span className="ui-count">
            {unit.attempts > 0
              ? `${unit.correct}/${unit.attempts} correct · ${unit.delta >= 0 ? '+' : ''}${unit.delta} pts`
              : unit.notes > 0
                ? `${unit.notes} note${unit.notes === 1 ? '' : 's'} added`
                : 'No quizzes yet'}
          </span>
        </span>
      </button>
    </li>
  )
}

function InfoMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 10.4v6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="7.6" r="1.1" fill="currentColor" />
    </svg>
  )
}

function ProgressInfo({ onClose }: { onClose: () => void }) {
  return (
    <aside id="progress-info-panel" className="progress__info-panel" role="dialog" aria-labelledby="progress-info-title">
      <header>
        <h3 id="progress-info-title">How progress works</h3>
        <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={onClose} aria-label="Close progress info">
          Close
        </button>
      </header>
      <section>
        <h4>What mastery is</h4>
        <p>
          Mastery is a 0–100 score for how well you know a unit. The big number at the top is the average of every unit in this course.
        </p>
        <p>
          Early on, the score stays pulled toward 38% so one lucky quiz does not make a unit look finished. After about six answers it follows your real accuracy.
        </p>
      </section>
      <section>
        <h4>How we grade</h4>
        <p>Each unit gets a verdict from its own quiz history:</p>
        <ul>
          <li><strong>Locked</strong> — no notes or quizzes yet</li>
          <li><strong>Seeded</strong> — notes are in, but you have not quizzed</li>
          <li><strong>Warming</strong> — fewer than four answers, so the trend is not reliable</li>
          <li><strong>Rising / Slipping</strong> — your last 6 answers are 12+ points better or worse than the 6 before</li>
          <li><strong>Sharp</strong> — 82%+ mastery and holding there</li>
          <li><strong>Stuck</strong> — enough tries, still under 45%</li>
          <li><strong>Steady</strong> — about the same session to session</li>
        </ul>
      </section>
      <section>
        <h4>What brings mastery up</h4>
        <ul>
          <li>Correct quiz answers in that unit — this is the main lift</li>
          <li>More attempts, so the score trusts your accuracy instead of the 38% start</li>
          <li>Depositing notes — a small bonus, up to +8</li>
        </ul>
        <p>Wrong answers pull the score down. XP and streak on this page are account-wide, not the same as unit mastery.</p>
      </section>
    </aside>
  )
}

function ring(mastery: number, color: string) {
  return `conic-gradient(${color} ${mastery * 3.6}deg, #e8edf5 0deg)`
}

function verdictTone(verdict: UnitJudgment['verdict']) {
  if (verdict === 'sharp' || verdict === 'rising') return 'ui-badge--positive'
  if (verdict === 'stuck') return 'ui-badge--danger'
  if (verdict === 'slipping') return 'ui-badge--warning'
  if (verdict === 'steady' || verdict === 'warming') return 'ui-badge--accent'
  return ''
}

function cssId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
