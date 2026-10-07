import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { Progress as ProgressData } from '../lib/api'
import { useData } from '../lib/dataSource'
import type { AuthSession } from '../lib/auth'
import {
  VERDICT_COPY,
  buildCoursePulse,
  type CoursePulse,
  type UnitJudgment,
} from '../lib/progress'
import { withCourseTones } from '../lib/session'
import { courseInitial } from '../lib/tones'
import './Progress.css'

/*
 * Progress reads like a short report: one headline mastery figure per course,
 * the mastery trend by quiz session, every unit with its verdict, and the
 * account-wide XP and streak summarized underneath.
 */

const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

type ProgressProps = {
  session: AuthSession | null
}

export function Progress({ session }: ProgressProps) {
  const data = useData()
  const studentId = session?.user.id ?? data.getStudentId()
  const [stats, setStats] = useState<ProgressData | null>(() => data.getCachedProgress(studentId))
  const [statsFailed, setStatsFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [notebook, setNotebook] = useState(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  })
  const [attempts, setAttempts] = useState(() => data.loadUnitAttempts())
  const [selected, setSelected] = useState(() => notebook.activeCourse || notebook.courses[0]?.name || '')
  const [focusUnit, setFocusUnit] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const toggleInfo = useCallback(() => setInfoOpen((open) => !open), [])

  useEffect(() => {
    let active = true
    void data.getProgress(studentId, session?.access_token, true)
      .then((value) => {
        if (!active) return
        setStats(value)
        setStatsFailed(false)
        // Quiz answers recorded elsewhere may have landed since the page opened.
        setAttempts(data.loadUnitAttempts())
      })
      .catch(() => { if (active) setStatsFailed(true) })
    return () => { active = false }
  }, [data, studentId, session?.access_token, reload])

  useEffect(() => {
    const sync = () => {
      const loaded = data.loadNotebook()
      const courses = withCourseTones(loaded.courses)
      setNotebook({ ...loaded, courses })
      setAttempts(data.loadUnitAttempts())
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

  const courses = notebook.courses
  const activeCourse = courses.find((course) => course.name === selected) ?? courses[0]
  const pulse = useMemo(
    () =>
      activeCourse
        ? buildCoursePulse(activeCourse, notebook.deposits, attempts, stats?.topics ?? [])
        : null,
    [activeCourse, notebook.deposits, attempts, stats],
  )

  // Opens Study on the recommended unit, the same way Home opens a course.
  function practiceNext() {
    if (!pulse?.recommended) return
    data.saveNotebook({ ...data.loadNotebook(), activeCourse: pulse.course.name, activeUnit: pulse.recommended })
  }

  return (
    <div className="ui-page progress">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Progress</span>
          <h1 className="ui-page-title">Mastery report</h1>
          <p className="ui-page-subtitle">
            Each course is judged unit by unit from your quiz history, accuracy and notes.
          </p>
        </div>
        {pulse?.recommended ? (
          <a className="ui-button ui-button--primary progress__practice" href="#tools" onClick={practiceNext} aria-label={`Practice ${pulse.recommended}`}>
            <span className="progress__practice-text">Practice {pulse.recommended}</span>
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </header>

      {courses.length === 0 || !pulse ? (
        <div className="ui-panel">
          <div className="ui-empty">
            <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="104" height="125" />
            <h2 className="ui-empty__title">No courses yet</h2>
            <p className="ui-empty__copy">Add a course and its units in Study. Each one gets a mastery report here once you start quizzing.</p>
            <a className="ui-button ui-button--primary" href="#tools">Open Study</a>
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
                  setAttempts(data.loadUnitAttempts())
                }}
              >
                <span className="ui-course-mark ui-course-mark--sm" style={{ '--course': course.tone ?? 'var(--color-brand)' } as CSSProperties} aria-hidden="true">{courseInitial(course.name)}</span>
                <span className="progress__course-name">{course.name}</span>
              </button>
            ))}
          </nav>

          <CourseBoard
            pulse={pulse}
            focusUnit={focusUnit}
            hover={hover}
            infoOpen={infoOpen}
            onInfo={toggleInfo}
            onFocus={setFocusUnit}
            onHover={setHover}
          />
        </>
      )}

      <AccountSummary
        stats={stats}
        failed={statsFailed && !stats}
        onRetry={() => {
          setStatsFailed(false)
          setReload((value) => value + 1)
        }}
      />
    </div>
  )
}

function CourseBoard({
  pulse,
  focusUnit,
  hover,
  infoOpen,
  onInfo,
  onFocus,
  onHover,
}: {
  pulse: CoursePulse
  focusUnit: string
  hover: number | null
  infoOpen: boolean
  onInfo: () => void
  onFocus: (name: string) => void
  onHover: (index: number | null) => void
}) {
  const { palette, course } = pulse
  const hasUnits = course.units.length > 0
  const quizzed = pulse.units.filter((unit) => unit.attempts > 0).length
  const answers = pulse.units.reduce((sum, unit) => sum + unit.attempts, 0)
  const sharp = pulse.units.filter((unit) => unit.verdict === 'sharp').length

  return (
    <div className="progress__board" style={{ '--course': palette.tone } as CSSProperties}>
      <section className="ui-panel progress__summary" aria-labelledby="progress-summary-title">
        <div className="progress__summary-main">
          <h2 className="ui-eyebrow progress__summary-title" id="progress-summary-title">
            <span className="ui-course-mark ui-course-mark--sm" aria-hidden="true">{courseInitial(course.name)}</span>
            {course.name}
          </h2>
          <p className="progress__mastery">
            <span className="progress__mastery-value">{pulse.mastery}</span>
            <span className="progress__mastery-unit">/ 100 mastery</span>
          </p>
          <div
            className="ui-meter progress__mastery-meter"
            role="progressbar"
            aria-label={`${course.name} mastery`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pulse.mastery}
          >
            <span style={{ width: `${pulse.mastery}%` }} />
          </div>
          <p className="progress__reason">
            <span className={`ui-badge ${verdictTone(pulse.verdict)}`}>{VERDICT_COPY[pulse.verdict].label}</span>
            <span>{pulse.reason}</span>
          </p>
        </div>

        <dl className="progress__facts">
          <div>
            <dt>Next up</dt>
            <dd className="progress__fact-text">{pulse.recommended || '—'}</dd>
          </div>
          <div>
            <dt>Units quizzed</dt>
            <dd>{quizzed}<small> of {pulse.units.length}</small></dd>
          </div>
          <div>
            <dt>Answers logged</dt>
            <dd>{answers.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Sharp units</dt>
            <dd>{sharp}<small> of {pulse.units.length}</small></dd>
          </div>
        </dl>

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
      </section>

      <section className="ui-section" aria-labelledby="progress-graph-title">
        <div className="ui-section-head">
          <h2 className="ui-section-title" id="progress-graph-title">Mastery by quiz session</h2>
          <span className="ui-count">
            {hasUnits ? (pulse.live ? 'Last 8 sessions' : 'Waiting for the first quiz') : 'No units yet'}
          </span>
        </div>
        <figure className="ui-panel progress__graph">
          {hasUnits ? (
            <>
              <ul className="progress__legend" aria-label="Highlight a line">
                <li>
                  <button type="button" aria-pressed={!focusUnit} className="progress__legend-item" onClick={() => onFocus('')}>
                    <i className="progress__key progress__key--avg" aria-hidden="true" />
                    Course average
                  </button>
                </li>
                {pulse.series.length > 1 ? pulse.series.map((line) => (
                  <li key={line.name}>
                    <button
                      type="button"
                      aria-pressed={focusUnit === line.name}
                      className="progress__legend-item"
                      onClick={() => onFocus(focusUnit === line.name ? '' : line.name)}
                    >
                      <i className="progress__key" style={{ background: line.color }} aria-hidden="true" />
                      {line.name}
                    </button>
                  </li>
                )) : null}
              </ul>
              <PulseGraph pulse={pulse} focusUnit={focusUnit} hover={hover} onHover={onHover} />
              <PulseTable pulse={pulse} />
              <figcaption className="progress__note">
                {pulse.live
                  ? 'Each session is three answers. Hover the chart, or focus it and use the arrow keys, to read every line.'
                  : <>Every line stays flat until you quiz. Quiz a unit in <a className="ui-link" href="#tools">Study</a> to start the trend.</>}
              </figcaption>
            </>
          ) : (
            <figcaption className="progress__note">
              {course.name} has no units yet, so there is nothing to plot. Create units in <a className="ui-link" href="#tools">Study</a>.
            </figcaption>
          )}
        </figure>
      </section>

      <section className="ui-section" aria-labelledby="progress-roadmap-title">
        <div className="ui-section-head">
          <h2 className="ui-section-title" id="progress-roadmap-title">Units</h2>
          {hasUnits ? <span className="ui-count">Select a unit to highlight it on the chart</span> : null}
        </div>
        {hasUnits ? (
          <ol className="ui-panel ui-list progress__trail">
            {pulse.units.map((unit, index) => (
              <RoadNode
                key={unit.name}
                index={index}
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
            <p className="progress__empty">
              Create units for {course.name} in <a className="ui-link" href="#tools">Study</a> and they will be graded here.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}

/* Tracks an element's rendered width so chart text stays at real pixel sizes. */
function useWidth<T extends Element>(fallback: number) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(Math.max(240, next))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

type Point = { x: number; y: number }

const TIP_WIDTH = 184

/* Places the readout beside the crosshair, flipping sides and clamping so it never leaves the chart. */
function tipLeft(x: number, width: number) {
  const right = x + 12
  const left = right + TIP_WIDTH > width ? x - 12 - TIP_WIDTH : right
  return Math.max(0, Math.min(width - TIP_WIDTH, left))
}

function curve(points: Point[]) {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const dx = (b.x - a.x) / 2
    d += ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
  }
  return d
}

/* Arrow keys step a chart's readout the same way the pointer does. */
function stepKey(event: ReactKeyboardEvent, current: number | null, count: number, set: (index: number | null) => void) {
  const at = current ?? count - 1
  const next =
    event.key === 'ArrowLeft' ? Math.max(0, at - 1)
      : event.key === 'ArrowRight' ? Math.min(count - 1, at + 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? count - 1
            : null
  if (next === null) {
    if (event.key === 'Escape') set(null)
    return
  }
  event.preventDefault()
  set(next)
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
  const [wrap, width] = useWidth<HTMLDivElement>(720)
  const height = width < 520 ? 200 : 240
  const pad = { left: 34, right: 14, top: 14, bottom: 28 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const ticks = [0, 25, 50, 75, 100]
  const count = pulse.labels.length
  const focused = pulse.series.find((line) => line.name === focusUnit)
  const multi = pulse.series.length > 1
  const xAt = (index: number) => pad.left + (count === 1 ? innerW / 2 : (index / (count - 1)) * innerW)
  const yAt = (value: number) => pad.top + (1 - value / 100) * innerH
  const toPoints = (values: number[]) => values.map((value, index) => ({ x: xAt(index), y: yAt(value) }))
  const mainPoints = toPoints(focused?.values ?? pulse.overall)
  const baseline = yAt(0)
  const area = mainPoints.length
    ? `${curve(mainPoints)} L ${mainPoints[mainPoints.length - 1].x} ${baseline} L ${mainPoints[0].x} ${baseline} Z`
    : ''
  const mark = hover === null ? null : mainPoints[hover]
  const at = hover ?? 0
  const rows = [
    { name: 'Course average', color: '', value: pulse.overall[at] ?? 0, avg: true },
    ...(multi ? (focused ? [focused] : pulse.series) : []).map((line) => ({ name: line.name, color: line.color, value: line.values[at] ?? 0, avg: false })),
  ]

  function nearest(clientX: number, target: SVGSVGElement) {
    const box = target.getBoundingClientRect()
    const local = ((clientX - box.left) / box.width) * width
    const raw = count === 1 ? 0 : Math.round(((local - pad.left) / innerW) * (count - 1))
    onHover(Math.min(count - 1, Math.max(0, raw)))
  }

  return (
    <div className="progress__plot" ref={wrap}>
      <svg
        className="progress-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={`${pulse.course.name} mastery over ${count} quiz sessions, now ${pulse.mastery} out of 100. Use the left and right arrow keys to read each session.`}
        onPointerMove={(event) => nearest(event.clientX, event.currentTarget)}
        onPointerLeave={() => onHover(null)}
        onBlur={() => onHover(null)}
        onKeyDown={(event) => stepKey(event, hover, count, onHover)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="progress-svg__grid" x1={pad.left} x2={width - pad.right} y1={yAt(tick)} y2={yAt(tick)} />
            <text className="progress-svg__tick" x={pad.left - 8} y={yAt(tick) + 4}>{tick}</text>
          </g>
        ))}
        {pulse.labels.map((label, index) => (
          <text key={label} className="progress-svg__label" x={xAt(index)} y={height - 8}>{index + 1}</text>
        ))}
        <path className={`progress-svg__area${focused ? '' : ' is-avg'}`} d={area} style={focused ? { fill: focused.color } : undefined} />
        {multi ? pulse.series.map((line) => {
          const isFocus = focused?.name === line.name
          return (
            <path
              key={line.name}
              className={`progress-svg__line${focused && !isFocus ? ' is-muted' : ''}${isFocus ? ' is-focus' : ''}`}
              d={curve(toPoints(line.values))}
              style={{ stroke: line.color }}
            />
          )
        }) : null}
        <path
          className={`progress-svg__line progress-svg__line--avg${focused ? ' is-muted' : ''}`}
          d={curve(toPoints(pulse.overall))}
        />
        {mark ? (
          <>
            <line className="progress-svg__hover" x1={mark.x} x2={mark.x} y1={pad.top} y2={baseline} />
            <circle className={`progress-svg__dot${focused ? '' : ' is-avg'}`} cx={mark.x} cy={mark.y} r="4.5" style={focused ? { fill: focused.color } : undefined} />
          </>
        ) : null}
      </svg>
      {mark && hover !== null ? (
        <div
          className="progress__tooltip"
          style={{ left: tipLeft(mark.x, width), width: TIP_WIDTH }}
          aria-hidden="true"
        >
          <span className="progress__tooltip-title">Session {hover + 1}</span>
          {rows.map((row) => (
            <span key={row.name} className="progress__tooltip-row">
              <i className={`progress__key${row.avg ? ' progress__key--avg' : ''}`} style={row.avg ? undefined : { background: row.color }} />
              <strong>{row.value}</strong>
              <span>{row.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {hover !== null ? `Session ${hover + 1}: ${rows.map((row) => `${row.name} ${row.value}`).join(', ')}` : ''}
      </p>
    </div>
  )
}

function PulseTable({ pulse }: { pulse: CoursePulse }) {
  const units = pulse.series.length > 1 ? pulse.series : []
  return (
    <div className="sr-only"><table>
      <caption>{pulse.course.name} mastery by quiz session, 0 to 100</caption>
      <thead>
        <tr>
          <th scope="col">Session</th>
          <th scope="col">Course average</th>
          {units.map((line) => <th key={line.name} scope="col">{line.name}</th>)}
        </tr>
      </thead>
      <tbody>
        {pulse.labels.map((label, index) => (
          <tr key={label}>
            <th scope="row">{index + 1}</th>
            <td>{pulse.overall[index]}</td>
            {units.map((line) => <td key={line.name}>{line.values[index]}</td>)}
          </tr>
        ))}
      </tbody>
    </table></div>
  )
}

function RoadNode({
  index,
  unit,
  color,
  next,
  selected,
  onSelect,
}: {
  index: number
  unit: UnitJudgment
  color: string
  next: boolean
  selected: boolean
  onSelect: () => void
}) {
  const verdict = VERDICT_COPY[unit.verdict]
  const detail = unit.attempts > 0
    ? `${unit.correct} of ${unit.attempts} correct${unit.delta ? ` · ${unit.delta > 0 ? '+' : ''}${unit.delta} pts recently` : ''}`
    : unit.notes > 0
      ? `${unit.notes} note${unit.notes === 1 ? '' : 's'} added · not quizzed yet`
      : 'No notes or quizzes yet'
  return (
    <li>
      <button
        type="button"
        className={`progress__node${next ? ' is-next' : ''}${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="progress__node-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <span className="progress__node-main">
          <span className="progress__node-name">
            <i className="progress__key" style={{ background: color }} aria-hidden="true" />
            <span className="progress__node-title">{unit.name}</span>
            {next ? <span className="ui-badge ui-badge--accent">Next up</span> : null}
          </span>
          <span className="progress__node-meta">{detail}</span>
        </span>
        <span className="progress__node-score">
          <span className="progress__node-value">{unit.mastery}<small>%</small></span>
          <span className="ui-meter" aria-hidden="true">
            <span style={{ width: `${unit.mastery}%`, background: color }} />
          </span>
        </span>
        <span className="progress__node-verdict">
          <span className={`ui-badge ${verdictTone(unit.verdict)}`}>{verdict.label}</span>
          <span className="progress__node-hint">{verdict.hint}</span>
        </span>
      </button>
    </li>
  )
}

function AccountSummary({ stats, failed, onRetry }: { stats: ProgressData | null; failed: boolean; onRetry: () => void }) {
  const loading = !stats && !failed
  const recent = stats?.recent_xp ?? []
  const week = recent.slice(-7).reduce((sum, day) => sum + day.xp, 0)
  const value = (content: ReactNode) => loading ? <span className="ui-skeleton progress__stat-skeleton" /> : content

  return (
    <section className="ui-section progress__account" aria-labelledby="progress-account-title">
      <div className="ui-section-head">
        <h2 className="ui-section-title" id="progress-account-title">XP and streak</h2>
        <span className="ui-count">Account-wide, across every course</span>
      </div>
      {failed ? (
        <div className="ui-alert" role="alert">
          <span>Your XP and streak could not be loaded. Course mastery above still works from this device.</span>
          <button type="button" className="ui-button ui-button--sm" onClick={onRetry}>Try again</button>
        </div>
      ) : (
        <div className="ui-panel progress__account-sheet" aria-busy={loading || undefined}>
          <div className="ui-stats progress__stats">
            <div className="ui-stat">
              <span className="ui-stat__label">Login streak</span>
              <span className="ui-stat__value">{value(<>{stats?.login_streak ?? 0}<span className="ui-stat__unit">{stats?.login_streak === 1 ? 'day' : 'days'}</span></>)}</span>
              {stats ? <span className="ui-stat__meta">Best {stats.best_login_streak} {stats.best_login_streak === 1 ? 'day' : 'days'}</span> : null}
            </div>
            <div className="ui-stat">
              <span className="ui-stat__label">Total XP</span>
              <span className="ui-stat__value">{value(stats?.total_xp.toLocaleString())}</span>
              {stats && recent.length ? <span className="ui-stat__meta">{week.toLocaleString()} in the last 7 days</span> : null}
            </div>
            <div className="ui-stat">
              <span className="ui-stat__label">Accuracy</span>
              <span className="ui-stat__value">{value(stats?.attempts ? `${Math.round(stats.accuracy)}%` : '—')}</span>
              {stats ? <span className="ui-stat__meta">{stats.attempts ? 'Across all answers' : 'No answers yet'}</span> : null}
            </div>
            <div className="ui-stat">
              <span className="ui-stat__label">Answers</span>
              <span className="ui-stat__value">{value(stats?.attempts.toLocaleString())}</span>
              {stats ? <span className="ui-stat__meta">{stats.correct_answers.toLocaleString()} correct</span> : null}
            </div>
          </div>
          {recent.length ? <XpChart days={recent.slice(-14)} /> : null}
        </div>
      )}
    </section>
  )
}

function niceMax(value: number) {
  if (value <= 0) return 20
  const steps = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 600, 800, 1000]
  return steps.find((step) => step >= value) ?? Math.ceil(value / 500) * 500
}

function dayDate(day: string) {
  return new Date(`${day}T12:00:00`)
}

function XpChart({ days }: { days: { day: string; xp: number }[] }) {
  const [wrap, width] = useWidth<HTMLDivElement>(720)
  const [hover, setHover] = useState<number | null>(null)
  const height = 150
  const pad = { left: 34, right: 8, top: 18, bottom: 24 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const count = days.length
  const max = niceMax(Math.max(...days.map((day) => day.xp)))
  const slot = innerW / Math.max(count, 1)
  const barW = Math.max(4, Math.min(24, slot - 6))
  const total = days.reduce((sum, day) => sum + day.xp, 0)
  const active = days.filter((day) => day.xp > 0).length
  const yAt = (value: number) => pad.top + (1 - value / max) * innerH
  const baseline = yAt(0)
  const last = count - 1
  const center = (index: number) => pad.left + slot * index + slot / 2

  // Columns grow from the baseline with a 4px rounded data end.
  function bar(index: number, xp: number) {
    const x = center(index) - barW / 2
    const top = yAt(xp)
    const h = baseline - top
    if (h <= 0) return ''
    const r = Math.min(4, h, barW / 2)
    return `M ${x} ${baseline} V ${top + r} Q ${x} ${top} ${x + r} ${top} H ${x + barW - r} Q ${x + barW} ${top} ${x + barW} ${top + r} V ${baseline} Z`
  }

  return (
    <figure className="progress__xp">
      <figcaption className="progress__xp-head">
        <span className="progress__xp-title">Daily XP, last {count} days</span>
        <span className="ui-count">{total.toLocaleString()} XP · active {active} of {count} days</span>
      </figcaption>
      <div className="progress__plot" ref={wrap}>
        <svg
          className="progress-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          tabIndex={0}
          aria-label={`Daily XP for the last ${count} days, ${total} XP in total. Use the left and right arrow keys to read each day.`}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => stepKey(event, hover, count, setHover)}
        >
          {[0, max / 2, max].map((tick) => (
            <g key={tick}>
              <line className="progress-svg__grid" x1={pad.left} x2={width - pad.right} y1={yAt(tick)} y2={yAt(tick)} />
              <text className="progress-svg__tick" x={pad.left - 8} y={yAt(tick) + 4}>{Math.round(tick)}</text>
            </g>
          ))}
          {days.map((day, index) => (
            <g key={day.day}>
              <path className={`progress-svg__bar${hover === index ? ' is-hover' : ''}`} d={bar(index, day.xp)} />
              {(last - index) % 7 === 0 ? (
                <text className="progress-svg__label" x={center(index)} y={height - 6}>
                  {index === last ? 'Today' : dayLabel.format(dayDate(day.day))}
                </text>
              ) : null}
              <rect
                className="progress-svg__hit"
                x={pad.left + slot * index}
                y={pad.top}
                width={slot}
                height={innerH}
                onPointerEnter={() => setHover(index)}
              />
            </g>
          ))}
          {hover === null && days[last]?.xp ? (
            <text className="progress-svg__value" x={center(last)} y={yAt(days[last].xp) - 6}>{days[last].xp}</text>
          ) : null}
        </svg>
        {hover !== null && days[hover] ? (
          <div
            className="progress__tooltip"
            style={{ left: tipLeft(center(hover), width), width: TIP_WIDTH }}
            aria-hidden="true"
          >
            <span className="progress__tooltip-title">{dayLong.format(dayDate(days[hover].day))}</span>
            <span className="progress__tooltip-row">
              <i className="progress__key progress__key--brand" />
              <strong>{days[hover].xp}</strong>
              <span>XP</span>
            </span>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {hover !== null && days[hover] ? `${dayLong.format(dayDate(days[hover].day))}: ${days[hover].xp} XP` : ''}
        </p>
      </div>
      <div className="sr-only"><table>
        <caption>XP earned per day</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">XP</th></tr></thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}><th scope="row">{dayLong.format(dayDate(day.day))}</th><td>{day.xp}</td></tr>
          ))}
        </tbody>
      </table></div>
    </figure>
  )
}

function InfoMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11v5.6" />
      <path d="M12 7.6h.01" />
    </svg>
  )
}

function ProgressInfo({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = panel.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (node?.contains(event.target) || opener?.contains(event.target) || (event.target instanceof Element && event.target.closest('.progress__info'))) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
      // Hand focus back to the trigger only if it was inside the panel (Escape or Close).
      const current = document.activeElement
      if (opener?.isConnected && (current === document.body || (current && node?.contains(current)))) opener.focus()
    }
  }, [onClose])

  return (
    <aside ref={panel} id="progress-info-panel" className="progress__info-panel" role="dialog" aria-labelledby="progress-info-title" tabIndex={-1}>
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

function verdictTone(verdict: UnitJudgment['verdict']) {
  if (verdict === 'sharp' || verdict === 'rising') return 'ui-badge--positive'
  if (verdict === 'stuck') return 'ui-badge--danger'
  if (verdict === 'slipping') return 'ui-badge--warning'
  if (verdict === 'steady' || verdict === 'warming') return 'ui-badge--accent'
  return ''
}
