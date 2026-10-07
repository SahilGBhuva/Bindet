import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icons } from '../components/Icons'
import { MathText } from '../components/math/Math'
import { getFriends, getStudyGroups } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import {
  CHALLENGE_MAX_CARDS, CHOICE_MIN_CARDS, ROUND_LENGTHS, STREAK_BONUS_FROM,
  createChallenge, declineChallenge, getBests, getChallenge, getChallenges, getPracticeCards, getPracticeScopes, getRecentRounds,
  lengthLabel, modeLabel, scopeLabel, scoreAnswers, submitChallengeResult, submitRound,
  type Challenge, type PracticeBest, type PracticeRound, type PracticeScope, type RoundLength, type RoundMode, type RoundResult,
} from '../lib/practiceLab'
import { loadNotebook, withCourseTones } from '../lib/session'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import { useDrawer } from '../lib/useDrawer'
import './Games.css'

/*
 * Practice lab: timed rounds on the student's saved flashcards, personal bests, and
 * challenges with friends. Everything here runs on cards already saved, so no AI is called.
 */

/* ---- Types and helpers -------------------------------------------------------- */

type DeckCard = { id: string; front: string; back: string; unit: string }
type Game = {
  source: 'round' | 'review' | 'challenge'
  course: string
  unit: string
  length: RoundLength
  mode: RoundMode
  deck: DeckCard[]
  // Every card in scope: where multiple-choice answers come from, and what Play again uses.
  pool: DeckCard[]
  choices: string[][]
  startedAt: number
  challenge?: Challenge
}
type Finished = { game: Game; results: boolean[] }
type Saved = { kind: 'round'; data: RoundResult } | { kind: 'challenge'; data: { challenge: Challenge; xp_earned: number } }
type Settings = { course: string; unit: string; length: RoundLength; mode: RoundMode }

const SETTINGS_KEY = 'bindit:practice:settings'

function readSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>
  } catch {
    return {}
  }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable; the choice still applies now.
  }
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

/* Four answers for each card: its own back and three other cards' backs, from the same unit when it has enough. */
function buildChoices(deck: DeckCard[], pool: DeckCard[]): string[][] {
  return deck.map((card) => {
    const others = (cards: DeckCard[]) => [...new Set(cards.map((item) => item.back).filter((back) => back !== card.back))]
    let candidates = others(pool.filter((item) => item.unit === card.unit))
    if (candidates.length < 3) candidates = others(pool)
    return shuffle([card.back, ...shuffle(candidates).slice(0, 3)])
  })
}

function courseTone(name: string) {
  const saved = loadNotebook().courses.find((course) => course.name === name)?.tone
  return saved ?? withCourseTones([{ name, units: [] }])[0].tone ?? 'var(--color-accent)'
}

function shortDate(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function daysLeft(value: string) {
  const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000)
  return days <= 1 ? 'expires today' : `${days} days left`
}

function accuracyOf(correct: number | null, total: number | null) {
  return correct !== null && total ? Math.round((correct / total) * 100) : 0
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function Avatar({ name }: { name: string }) {
  return <span className={`ui-avatar ${toneClass(toneForName(name))}`} aria-hidden="true">{courseInitial(name)}</span>
}

function CourseMark({ course }: { course: string }) {
  return <span className="ui-course-mark" style={{ '--course': courseTone(course) } as CSSProperties} aria-hidden="true">{courseInitial(course)}</span>
}

/* ---- Page ---------------------------------------------------------------------------- */

export function Games({ session }: { session: AuthSession | null }) {
  const token = session?.access_token
  const selfId = session?.user.id ?? ''
  const [game, setGame] = useState<Game | null>(null)
  const [finished, setFinished] = useState<Finished | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const finish = useCallback((done: Finished) => {
    setGame(null)
    setFinished(done)
    window.scrollTo({ top: 0 })
  }, [])

  if (!token) {
    return (
      <div className="ui-page practice">
        <div className="ui-empty">
          <h1 className="ui-empty__title">Practice lab</h1>
          <p className="ui-empty__copy">Sign in to play quick rounds with your saved flashcards.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`ui-page practice${game ? ' is-playing' : ''}`}>
      {game ? (
        <RoundPlayer game={game} onFinish={(results) => finish({ game, results })} />
      ) : finished ? (
        <RoundSummary
          token={token}
          selfId={selfId}
          finished={finished}
          onAgain={(next) => { setFinished(null); setGame(next) }}
          onBack={() => setFinished(null)}
          onNotice={setNotice}
        />
      ) : (
        <Lobby token={token} selfId={selfId} onStart={setGame} onNotice={setNotice} />
      )}
      {notice ? <p className="app-toast" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></p> : null}
    </div>
  )
}

/* ---- Lobby --------------------------------------------------------------------------- */

type LobbyData = { scopes: PracticeScope[]; bests: PracticeBest[]; challenges: Challenge[]; rounds: PracticeRound[] }

function Lobby({ token, selfId, onStart, onNotice }: { token: string; selfId: string; onStart: (game: Game) => void; onNotice: (text: string) => void }) {
  const [data, setData] = useState<LobbyData | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const saved = useMemo(() => readSettings(), [])
  const [course, setCourse] = useState(saved.course ?? '')
  const [unit, setUnit] = useState(saved.unit ?? '')
  const [length, setLength] = useState<RoundLength>(saved.length ?? 60)
  const [mode, setMode] = useState<RoundMode>(saved.mode ?? 'self')
  const [busy, setBusy] = useState<string | null>(null)
  const [startError, setStartError] = useState('')
  const [challengeDeck, setChallengeDeck] = useState<DeckCard[] | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([getPracticeScopes(token), getBests(token), getChallenges(token), getRecentRounds(5, token)])
      .then(([scopes, bests, challenges, rounds]) => { if (live) { setData({ scopes, bests, challenges, rounds }); setError('') } })
      .catch((caught) => { if (live) setError(errorText(caught, 'The practice lab couldn’t load.')) })
    return () => { live = false }
  }, [token, reload])

  const courses = useMemo(() => [...new Set((data?.scopes ?? []).map((scope) => scope.course))], [data])
  const activeCourse = courses.includes(course) ? course : courses[0] ?? ''
  const units = (data?.scopes ?? []).filter((scope) => scope.course === activeCourse)
  const activeUnit = unit && units.some((scope) => scope.unit === unit) ? unit : ''
  const allCount = units.reduce((sum, scope) => sum + scope.card_count, 0)
  const cardCount = activeUnit ? units.find((scope) => scope.unit === activeUnit)?.card_count ?? 0 : allCount
  const choiceAllowed = cardCount >= CHOICE_MIN_CARDS
  const activeMode: RoundMode = mode === 'choice' && !choiceAllowed ? 'self' : mode
  const best = data?.bests.find((item) => item.course === activeCourse && item.unit === activeUnit && item.length_s === length && item.mode === activeMode)
  const myTurn = (data?.challenges ?? []).filter((item) => item.my_turn)
  const others = (data?.challenges ?? []).filter((item) => !item.my_turn)

  async function loadDeck() {
    const cards = await getPracticeCards(activeCourse, activeUnit, token)
    if (!cards.length) throw new Error('This unit has no saved flashcards yet.')
    return cards
  }

  async function start() {
    if (busy || !activeCourse) return
    setBusy('start')
    setStartError('')
    saveSettings({ course: activeCourse, unit: activeUnit, length, mode: activeMode })
    try {
      const pool = await loadDeck()
      const deck = shuffle(pool)
      onStart({ source: 'round', course: activeCourse, unit: activeUnit, length, mode: activeMode, deck, pool, choices: activeMode === 'choice' ? buildChoices(deck, pool) : [], startedAt: Date.now() })
    } catch (caught) {
      setStartError(errorText(caught, 'Couldn’t load your cards. Try again.'))
      setBusy(null)
    }
  }

  async function openChallenge() {
    if (busy || !activeCourse) return
    setBusy('challenge')
    setStartError('')
    try {
      setChallengeDeck(shuffle(await loadDeck()).slice(0, CHALLENGE_MAX_CARDS))
    } catch (caught) {
      setStartError(errorText(caught, 'Couldn’t load your cards. Try again.'))
    }
    setBusy(null)
  }

  async function play(challenge: Challenge) {
    if (busy) return
    setBusy(challenge.id)
    try {
      const full = await getChallenge(challenge.id, token)
      const deck = (full.cards ?? []).map((card) => ({ id: String(card.index), front: card.front, back: card.back, unit: card.unit }))
      onStart({
        source: 'challenge', course: full.course, unit: full.unit, length: full.length_s, mode: full.mode, deck, pool: deck,
        choices: full.mode === 'choice' ? buildChoices(deck, deck) : [], startedAt: Date.now(), challenge: full,
      })
    } catch (caught) {
      onNotice(errorText(caught, 'That challenge couldn’t be opened.'))
      setBusy(null)
      setReload((value) => value + 1)
    }
  }

  async function decline(challenge: Challenge) {
    if (busy) return
    setBusy(challenge.id)
    try {
      await declineChallenge(challenge.id, token)
      onNotice(`Declined ${challenge.opponent.display_name}’s challenge.`)
    } catch (caught) {
      onNotice(errorText(caught, 'Couldn’t decline that challenge.'))
    }
    setBusy(null)
    setReload((value) => value + 1)
  }

  const header = (
    <header className="ui-page-header">
      <div>
        <span className="ui-eyebrow">Practice</span>
        <h1 className="ui-page-title">Practice lab</h1>
        <p className="ui-page-subtitle">Timed rounds on the flashcards you’ve already saved. Beat your best, then challenge a friend to the same cards.</p>
      </div>
    </header>
  )

  if (error && !data) {
    return (
      <>
        {header}
        <div className="ui-alert" role="alert"><span>{error}</span><button type="button" className="ui-button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>
      </>
    )
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="practice__layout" aria-busy="true" aria-label="Loading the practice lab">
          <div className="ui-panel practice__setup"><span className="ui-skeleton practice__skeleton" /><span className="ui-skeleton practice__skeleton" /><span className="ui-skeleton practice__skeleton practice__skeleton--short" /></div>
          <div className="ui-panel practice__side"><span className="ui-skeleton practice__skeleton" /><span className="ui-skeleton practice__skeleton practice__skeleton--short" /></div>
        </div>
      </>
    )
  }

  return (
    <>
      {header}

      {myTurn.length ? (
        <section className="ui-section practice__section" aria-labelledby="practice-inbox">
          <div className="ui-section-head"><h2 className="ui-section-title" id="practice-inbox">Your turn</h2><span className="ui-count">{myTurn.length}</span></div>
          <ul className="ui-panel ui-list practice__inbox">
            {myTurn.map((item) => (
              <li key={item.id} className="practice__challenge-row">
                <Avatar name={item.opponent.display_name} />
                <div className="practice__row-text">
                  <span className="practice__row-title">
                    {item.role === 'received' ? <><b>{item.opponent.display_name}</b> challenged you</> : <>Your challenge to <b>{item.opponent.display_name}</b></>}
                  </span>
                  <span className="practice__row-meta">
                    {scopeLabel(item.course, item.unit)} · {lengthLabel(item.length_s)} · {modeLabel(item.mode)} · {item.card_count} {item.card_count === 1 ? 'card' : 'cards'} · {daysLeft(item.expires_at)}
                  </span>
                  {item.their_score !== null ? <span className="practice__to-beat">Score to beat: <b>{item.their_score}</b></span> : null}
                </div>
                <div className="practice__row-actions">
                  {item.role === 'received' ? <button type="button" className="ui-button ui-button--ghost ui-button--sm" disabled={!!busy} onClick={() => void decline(item)}>Decline</button> : null}
                  <button type="button" className={`ui-button ui-button--primary ui-button--sm${busy === item.id ? ' is-busy' : ''}`} disabled={!!busy} onClick={() => void play(item)}>Play</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="practice__layout">
        <section className="ui-panel practice__setup ui-tone--orange" aria-labelledby="practice-round">
          <div className="practice__setup-head">
            <span className="ui-icon" aria-hidden="true">{Icons.bolt}</span>
            <div>
              <h2 className="practice__setup-title" id="practice-round">Quick round</h2>
              <p className="practice__setup-copy">See the question, recall the answer, then mark it. Five right in a row and each answer after counts double.</p>
            </div>
          </div>

          {data.scopes.length === 0 ? (
            <div className="practice__no-cards">
              <p><b>No saved flashcards yet.</b> Rounds use the flashcards made from your notes. Open a unit in Study, add notes and make its flashcards, then come back.</p>
              <a className="ui-button ui-button--primary" href="#tools">Open Study</a>
            </div>
          ) : (
            <>
              <div className="practice__fields">
                <label className="ui-field">
                  <span>Course</span>
                  <select className="ui-select" value={activeCourse} onChange={(event) => { setCourse(event.target.value); setUnit('') }}>
                    {courses.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="ui-field">
                  <span>Unit</span>
                  <select className="ui-select" value={activeUnit} onChange={(event) => setUnit(event.target.value)}>
                    <option value="">All units ({allCount} {allCount === 1 ? 'card' : 'cards'})</option>
                    {units.map((scope) => <option key={scope.unit} value={scope.unit}>{scope.unit} ({scope.card_count} {scope.card_count === 1 ? 'card' : 'cards'})</option>)}
                  </select>
                </label>
              </div>
              <div className="practice__options">
                <div className="practice__option">
                  <span className="practice__option-label" id="practice-length">Length</span>
                  <div className="ui-segmented" role="group" aria-labelledby="practice-length">
                    {ROUND_LENGTHS.map((option) => (
                      <button key={option.value} type="button" className="ui-segmented__item" aria-pressed={length === option.value} onClick={() => setLength(option.value)}>{option.label}</button>
                    ))}
                  </div>
                </div>
                <div className="practice__option">
                  <span className="practice__option-label" id="practice-mode">Answer by</span>
                  <div className="ui-segmented" role="group" aria-labelledby="practice-mode">
                    <button type="button" className="ui-segmented__item" aria-pressed={activeMode === 'self'} onClick={() => setMode('self')}>Self-check</button>
                    <button type="button" className="ui-segmented__item" aria-pressed={activeMode === 'choice'} disabled={!choiceAllowed} title={choiceAllowed ? undefined : 'Needs at least 4 cards'} onClick={() => setMode('choice')}>Multiple choice</button>
                  </div>
                </div>
              </div>
              {!choiceAllowed ? <p className="practice__hint">Multiple choice needs at least 4 cards in the unit.</p> : null}
              <p className="practice__best-line ui-tone--amber">
                <span className="practice__best-icon" aria-hidden="true">{Icons.trophy}</span>
                {best
                  ? <span>Your best here: <b>{best.best_score} points</b>, {best.best_accuracy}% right, {shortDate(best.achieved_at)}</span>
                  : <span>No best yet for this unit, length and mode.</span>}
              </p>
              {startError ? <div className="ui-alert" role="alert"><span>{startError}</span></div> : null}
              <div className="practice__actions">
                <button type="button" className={`ui-button ui-button--primary${busy === 'start' ? ' is-busy' : ''}`} disabled={!!busy || !cardCount} onClick={() => void start()}>Start round</button>
                <button type="button" className={`ui-button${busy === 'challenge' ? ' is-busy' : ''}`} disabled={!!busy || !cardCount} onClick={() => void openChallenge()}>
                  Challenge a friend
                </button>
              </div>
            </>
          )}
        </section>

        <section className="ui-panel practice__side" aria-labelledby="practice-bests">
          <div className="practice__side-head ui-tone--amber">
            <span className="ui-icon" aria-hidden="true">{Icons.trophy}</span>
            <h2 className="practice__setup-title" id="practice-bests">Personal bests</h2>
          </div>
          {data.bests.length ? (
            <ul className="practice__bests">
              {data.bests.map((item) => (
                <li key={`${item.course}|${item.unit}|${item.length_s}|${item.mode}`}>
                  <CourseMark course={item.course} />
                  <span className="practice__row-text">
                    <span className="practice__row-title">{item.unit || 'All units'}</span>
                    <span className="practice__row-meta">{item.course} · {lengthLabel(item.length_s)} · {modeLabel(item.mode)}</span>
                  </span>
                  <span className="practice__best-score"><b>{item.best_score}</b><small>{item.best_accuracy}% · {shortDate(item.achieved_at)}</small></span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="practice__side-empty">Finish a round and your best score for that unit, length and mode is kept here.</p>
          )}
        </section>
      </div>

      {others.length ? (
        <section className="ui-section practice__section" aria-labelledby="practice-challenges">
          <div className="ui-section-head"><h2 className="ui-section-title" id="practice-challenges">Challenges</h2></div>
          <ul className="ui-panel ui-list practice__inbox">
            {others.map((item) => <li key={item.id}><ChallengeRow challenge={item} /></li>)}
          </ul>
        </section>
      ) : null}

      {data.rounds.length ? (
        <section className="ui-section practice__section" aria-labelledby="practice-recent">
          <div className="ui-section-head"><h2 className="ui-section-title" id="practice-recent">Recent rounds</h2></div>
          <ul className="ui-panel ui-list practice__recent">
            {data.rounds.map((item) => (
              <li key={item.id} className="ui-course-row" style={{ '--course': courseTone(item.course) } as CSSProperties}>
                <span className="practice__row-text">
                  <span className="practice__row-title">{scopeLabel(item.course, item.unit)}</span>
                  <span className="practice__row-meta">{item.challenge_id ? 'Challenge · ' : ''}{lengthLabel(item.length_s)} · {modeLabel(item.mode)} · {shortDate(item.created_at)}</span>
                </span>
                <span className="practice__recent-score"><b>{item.score}</b> pts · {item.correct}/{item.total} right · {item.xp ? `+${item.xp} XP` : 'no XP'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {challengeDeck ? (
        <ChallengeDialog
          token={token}
          selfId={selfId}
          course={activeCourse}
          unit={activeUnit}
          length={length}
          mode={activeMode}
          deck={challengeDeck}
          onClose={() => setChallengeDeck(null)}
          onSent={(challenge) => {
            setChallengeDeck(null)
            onNotice(`Challenge sent to ${challenge.opponent.display_name}. Play your turn under “Your turn”.`)
            setReload((value) => value + 1)
          }}
        />
      ) : null}
    </>
  )
}

function ChallengeRow({ challenge }: { challenge: Challenge }) {
  const [open, setOpen] = useState(false)
  const name = challenge.opponent.display_name
  let status: { text: string; tone: string }
  if (challenge.status === 'completed') {
    status = challenge.winner === 'me' ? { text: 'You won', tone: 'positive' } : challenge.winner === 'tie' ? { text: 'Tie', tone: 'accent' } : { text: `${name} won`, tone: 'warning' }
  } else if (challenge.status === 'pending') {
    status = { text: `Waiting for ${name}`, tone: '' }
  } else {
    status = { text: challenge.status === 'expired' ? 'Expired' : 'Declined', tone: '' }
  }
  return (
    <>
      <div className="practice__challenge-row">
        <Avatar name={name} />
        <div className="practice__row-text">
          <span className="practice__row-title">{challenge.role === 'sent' ? <>You challenged <b>{name}</b></> : <><b>{name}</b> challenged you</>}</span>
          <span className="practice__row-meta">{scopeLabel(challenge.course, challenge.unit)} · {lengthLabel(challenge.length_s)} · {modeLabel(challenge.mode)} · {shortDate(challenge.created_at)}</span>
        </div>
        <div className="practice__row-actions">
          {challenge.status === 'completed' ? (
            <span className="practice__versus" aria-label={`You ${challenge.my_score}, ${name} ${challenge.their_score}`}>
              <b>{challenge.my_score}</b><span aria-hidden="true">–</span><b>{challenge.their_score}</b>
            </span>
          ) : challenge.my_score !== null ? (
            <span className="practice__versus"><small>You</small><b>{challenge.my_score}</b></span>
          ) : null}
          <span className={`ui-badge${status.tone ? ` ui-badge--${status.tone}` : ''}`}>{status.text}</span>
          {challenge.status === 'completed' ? (
            <button type="button" className="ui-button ui-button--ghost ui-button--sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide' : 'Result'}</button>
          ) : null}
        </div>
      </div>
      {open ? <div className="practice__row-result"><ChallengeResultCard challenge={challenge} /></div> : null}
    </>
  )
}

/* ---- Playing a round ------------------------------------------------------------------- */

function RoundPlayer({ game, onFinish }: { game: Game; onFinish: (results: boolean[]) => void }) {
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [results, setResults] = useState<boolean[]>([])
  const [picked, setPicked] = useState<number | null>(null)
  const [now, setNow] = useState(game.startedAt)
  const resultsRef = useRef<boolean[]>([])
  const doneRef = useRef(false)
  const pickTimer = useRef(0)
  const cardRef = useRef<HTMLDivElement>(null)
  const total = game.length * 1000

  const end = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    window.clearTimeout(pickTimer.current)
    onFinish(resultsRef.current)
  }, [onFinish])

  useEffect(() => {
    const tick = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current - game.startedAt >= total) end()
    }, 200)
    return () => { window.clearInterval(tick); window.clearTimeout(pickTimer.current) }
  }, [game.startedAt, total, end])

  useEffect(() => { cardRef.current?.focus({ preventScroll: true }) }, [index])

  const record = useCallback((right: boolean) => {
    if (doneRef.current) return
    const next = [...resultsRef.current, right]
    resultsRef.current = next
    setResults(next)
    setRevealed(false)
    setPicked(null)
    if (next.length >= game.deck.length) end()
    else setIndex(next.length)
  }, [game.deck.length, end])

  const pick = useCallback((choice: number) => {
    if (picked !== null || doneRef.current) return
    setPicked(choice)
    const right = game.choices[index]?.[choice] === game.deck[index].back
    pickTimer.current = window.setTimeout(() => record(right), right ? 450 : 1100)
  }, [picked, game, index, record])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      if (game.mode === 'choice') {
        const number = Number(key)
        if (number >= 1 && number <= (game.choices[index]?.length ?? 0)) { event.preventDefault(); pick(number - 1) }
        return
      }
      if (!revealed && (key === ' ' || key === 'enter')) {
        // Enter on a focused button is that button's own click.
        if (key === 'enter' && target?.closest('button')) return
        event.preventDefault()
        setRevealed(true)
      } else if (revealed && (key === 'j' || key === '1')) {
        event.preventDefault()
        record(true)
      } else if (revealed && (key === 'k' || key === '2')) {
        event.preventDefault()
        record(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [game, index, revealed, pick, record])

  const card = game.deck[index]
  const remaining = Math.max(0, total - (now - game.startedAt))
  const seconds = Math.ceil(remaining / 1000)
  const scored = scoreAnswers(results)
  let streak = 0
  for (let position = results.length - 1; position >= 0 && results[position]; position -= 1) streak += 1
  const hot = streak >= STREAK_BONUS_FROM - 1
  const challenger = game.challenge && game.challenge.role === 'received' ? game.challenge.opponent.display_name : ''

  return (
    <section className="practice__play" style={{ '--course': courseTone(game.course) } as CSSProperties} aria-label="Quick round">
      <div className="practice__hud">
        <div className="practice__hud-scope">
          <CourseMark course={game.course} />
          <span className="practice__row-text">
            <span className="practice__row-title">{game.source === 'challenge' ? (challenger ? `${challenger}’s challenge` : 'Your challenge') : scopeLabel(game.course, game.unit)}</span>
            <span className="practice__row-meta">{game.source === 'challenge' ? `${scopeLabel(game.course, game.unit)} · ` : ''}{modeLabel(game.mode)} · card {Math.min(index + 1, game.deck.length)} of {game.deck.length}</span>
          </span>
        </div>
        <div className="practice__hud-stats">
          <span className="practice__hud-stat ui-tone--blue"><small>Score</small><b>{scored.score}</b></span>
          <span className={`practice__hud-stat ui-tone--orange${hot ? ' is-hot' : ''}`}>
            <small>Streak</small><b>{streak}{streak >= STREAK_BONUS_FROM ? <em>×2</em> : null}</b>
          </span>
          <span className={`practice__hud-stat practice__timer${seconds <= 10 ? ' is-low' : ''}`} role="timer" aria-label={`${seconds} seconds left`}>
            <small>Time</small><b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</b>
          </span>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={end}>End round</button>
        </div>
      </div>
      <div className="practice__time" aria-hidden="true"><span style={{ transform: `scaleX(${remaining / total})` }} /></div>

      {card ? (
        <div className={`practice__card${revealed ? ' is-revealed' : ''}`} ref={cardRef} tabIndex={-1} key={index} aria-live="polite">
          <span className="practice__card-label">Question{game.unit || !card.unit ? '' : ` · ${card.unit}`}</span>
          <p className="practice__card-text"><MathText text={card.front} /></p>
          {game.mode === 'self' && revealed ? (
            <div className="practice__answer">
              <span className="practice__card-label">Answer</span>
              <p className="practice__card-text practice__card-text--answer"><MathText text={card.back} /></p>
            </div>
          ) : null}
        </div>
      ) : null}

      {card && game.mode === 'self' ? (
        revealed ? (
          <div className="practice__grade">
            <button type="button" className="ui-button practice__grade-button is-right" onClick={() => record(true)}>
              {Icons.check}<span>Got it</span><kbd>J</kbd>
            </button>
            <button type="button" className="ui-button practice__grade-button is-wrong" onClick={() => record(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg><span>Missed it</span><kbd>K</kbd>
            </button>
          </div>
        ) : (
          <div className="practice__grade">
            <button type="button" className="ui-button ui-button--primary practice__reveal" onClick={() => setRevealed(true)}>Show answer <kbd>Space</kbd></button>
          </div>
        )
      ) : null}

      {card && game.mode === 'choice' ? (
        <div className="practice__choices" role="group" aria-label="Choose the answer">
          {(game.choices[index] ?? []).map((choice, position) => {
            const isAnswer = choice === card.back
            const state = picked === null ? '' : isAnswer ? ' is-right' : picked === position ? ' is-wrong' : ' is-dim'
            return (
              <button key={`${index}-${position}`} type="button" className={`practice__choice${state}`} disabled={picked !== null} onClick={() => pick(position)}>
                <kbd>{position + 1}</kbd><span><MathText text={choice} /></span>
              </button>
            )
          })}
        </div>
      ) : null}

      <p className="practice__keys">
        {game.mode === 'self' ? 'Keys: Space shows the answer, then J or 1 for got it, K or 2 for missed it.' : 'Keys: 1 to 4 pick an answer.'}
      </p>
    </section>
  )
}

/* ---- End of a round ---------------------------------------------------------------------- */

function RoundSummary({ token, selfId, finished, onAgain, onBack, onNotice }: {
  token: string
  selfId: string
  finished: Finished
  onAgain: (game: Game) => void
  onBack: () => void
  onNotice: (text: string) => void
}) {
  const { game, results } = finished
  const scored = scoreAnswers(results)
  const accuracy = scored.total ? Math.round((scored.correct / scored.total) * 100) : 0
  const missed = game.deck.filter((_, position) => results[position] === false)
  const [saved, setSaved] = useState<RoundResult | null>(null)
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [xp, setXp] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [challengeOpen, setChallengeOpen] = useState(false)
  const [challengeSent, setChallengeSent] = useState(false)
  const nothing = results.length === 0

  // Sent once per finished round (and again only on Try again), even if the effect runs twice.
  const pending = useRef<{ attempt: number; promise: Promise<Saved> } | null>(null)
  useEffect(() => {
    if (nothing) return
    let live = true
    if (!pending.current || pending.current.attempt !== attempt) {
      const promise: Promise<Saved> = game.source === 'challenge' && game.challenge
        ? submitChallengeResult(game.challenge.id, results, token).then((data) => ({ kind: 'challenge' as const, data }))
        : submitRound({
          course: game.course, unit: game.unit, length_s: game.length, mode: game.mode,
          answers: results.map((correct, position) => ({ card_id: game.deck[position].id, correct })),
        }, token).then((data) => ({ kind: 'round' as const, data }))
      pending.current = { attempt, promise }
    }
    pending.current.promise.then((outcome) => {
      if (!live) return
      setSaveError('')
      setXp(outcome.data.xp_earned)
      if (outcome.kind === 'challenge') setChallenge(outcome.data.challenge)
      else setSaved(outcome.data)
    }).catch((caught) => { if (live) setSaveError(errorText(caught, 'This round couldn’t be saved.')) })
    return () => { live = false }
  }, [game, results, token, nothing, attempt])

  function again(deck: DeckCard[], source: Game['source']) {
    const order = shuffle(deck)
    onAgain({ ...game, source, deck: order, choices: game.mode === 'choice' ? buildChoices(order, game.pool) : [], startedAt: Date.now(), challenge: undefined })
  }

  const newBest = !!saved?.new_best
  const title = nothing ? 'No cards answered' : newBest ? 'New personal best!' : game.source === 'challenge' ? 'Challenge played' : 'Round over'
  const ownCards = game.source !== 'challenge'

  return (
    <section className="practice__summary" aria-labelledby="practice-summary-title">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">{scopeLabel(game.course, game.unit)} · {lengthLabel(game.length)} · {modeLabel(game.mode)}</span>
          <h1 className={`ui-page-title${newBest ? ' practice__title--best' : ''}`} id="practice-summary-title">
            {newBest ? <span className="ui-icon ui-tone--amber practice__title-icon" aria-hidden="true">{Icons.trophy}</span> : null}
            {title}
          </h1>
          {newBest && saved?.previous_best ? <p className="ui-page-subtitle">Your previous best was {saved.previous_best.best_score} points ({saved.previous_best.best_accuracy}% right).</p> : null}
          {!newBest && saved?.best && !nothing ? <p className="ui-page-subtitle">Your best for this unit, length and mode is {saved.best.best_score} points.</p> : null}
          {game.source === 'review' ? <p className="ui-page-subtitle">A round on the cards you missed.</p> : null}
        </div>
      </header>

      {nothing ? (
        <p className="practice__lede">The round ended before any card was marked, so nothing was saved.</p>
      ) : (
        <div className="ui-panel ui-stats practice__stats" aria-label="Round results">
          <div className="ui-stat ui-tone--blue"><span className="ui-stat__label">Score</span><span className="ui-stat__value practice__stat-value">{scored.score}</span><span className="ui-stat__meta">{scored.correct} right of {scored.total}</span></div>
          <div className={`ui-stat ${accuracy >= 70 ? 'ui-tone--green' : 'ui-tone--amber'}`}><span className="ui-stat__label">Accuracy</span><span className="ui-stat__value practice__stat-value">{accuracy}<span className="ui-stat__unit">%</span></span></div>
          <div className="ui-stat ui-tone--orange"><span className="ui-stat__label">Best streak</span><span className="ui-stat__value practice__stat-value">{scored.bestStreak}</span>{scored.bestStreak >= STREAK_BONUS_FROM ? <span className="ui-stat__meta">Double points from 5 in a row</span> : null}</div>
          <div className="ui-stat ui-tone--violet">
            <span className="ui-stat__label">XP</span>
            <span className="ui-stat__value practice__stat-value">{xp === null ? (saveError ? '–' : <span className="ui-skeleton practice__stat-skeleton" />) : `+${xp}`}</span>
            {xp === 0 && scored.correct > 0 ? <span className="ui-stat__meta">Today’s practice XP is used up. Scores and bests still count.</span> : null}
          </div>
        </div>
      )}

      {saveError ? (
        <div className="ui-alert" role="alert">
          <span>{saveError}</span>
          <button type="button" className="ui-button" onClick={() => { setSaveError(''); setAttempt((value) => value + 1) }}>Try again</button>
        </div>
      ) : null}

      {challenge ? <ChallengeResultCard challenge={challenge} /> : null}

      <div className="practice__actions practice__summary-actions">
        {ownCards ? <button type="button" className="ui-button ui-button--primary" onClick={() => again(game.pool, 'round')}>Play again</button> : null}
        {ownCards && saved && game.source === 'round' && !challengeSent ? <button type="button" className="ui-button" onClick={() => setChallengeOpen(true)}>Challenge a friend</button> : null}
        <button type="button" className={`ui-button${ownCards ? ' ui-button--ghost' : ' ui-button--primary'}`} onClick={onBack}>Back to Practice lab</button>
      </div>

      {missed.length ? (
        <section className="ui-section practice__section" aria-labelledby="practice-missed">
          <div className="ui-section-head practice__missed-head">
            <h2 className="ui-section-title" id="practice-missed">Cards you missed <span className="ui-count">{missed.length}</span></h2>
            {ownCards ? <button type="button" className="ui-button ui-button--sm" onClick={() => again(missed, 'review')}>Practice these again</button> : null}
          </div>
          <ul className="ui-panel ui-list practice__missed">
            {missed.map((card) => (
              <li key={card.id} className="ui-course-row" style={{ '--course': courseTone(game.course) } as CSSProperties}>
                <span className="practice__missed-front"><MathText text={card.front} /></span>
                <span className="practice__missed-back"><MathText text={card.back} /></span>
              </li>
            ))}
          </ul>
          {ownCards ? <p className="practice__lede">You can also flip through them in <a className="ui-link" href="#tools">Study</a>.</p> : null}
        </section>
      ) : null}

      {challengeOpen ? (
        <ChallengeDialog
          token={token}
          selfId={selfId}
          course={game.course}
          unit={game.unit}
          length={game.length}
          mode={game.mode}
          deck={game.deck.slice(0, CHALLENGE_MAX_CARDS)}
          answers={results.slice(0, CHALLENGE_MAX_CARDS)}
          onClose={() => setChallengeOpen(false)}
          onSent={(sent) => { setChallengeOpen(false); setChallengeSent(true); onNotice(`Challenge sent to ${sent.opponent.display_name}. Your score from this round is your entry.`) }}
        />
      ) : null}
    </section>
  )
}

function ChallengeResultCard({ challenge }: { challenge: Challenge }) {
  const name = challenge.opponent.display_name
  const verdict = challenge.status !== 'completed'
    ? `Waiting for ${name} to play. You’ll get a notification with the result.`
    : challenge.winner === 'me' ? `You won against ${name}.` : challenge.winner === 'tie' ? `It’s a tie with ${name}.` : `${name} won this one.`
  return (
    <section className="ui-panel practice__result" aria-label="Challenge result">
      <div className={`practice__result-side ui-tone--blue${challenge.winner === 'me' ? ' is-winner' : ''}`}>
        <span className="practice__result-name">You</span>
        <b className="practice__result-score">{challenge.my_score ?? '–'}</b>
        <span className="practice__row-meta">{accuracyOf(challenge.my_correct, challenge.my_total)}% right · {challenge.my_correct ?? 0} of {challenge.my_total ?? 0}</span>
      </div>
      <span className="practice__result-vs" aria-hidden="true">vs</span>
      <div className={`practice__result-side ${toneClass(toneForName(name))}${challenge.winner === 'them' ? ' is-winner' : ''}`}>
        <span className="practice__result-name">{name}</span>
        <b className="practice__result-score">{challenge.their_score ?? '–'}</b>
        <span className="practice__row-meta">{challenge.their_score === null ? 'Not played yet' : `${accuracyOf(challenge.their_correct, challenge.their_total)}% right · ${challenge.their_correct} of ${challenge.their_total}`}</span>
      </div>
      <p className="practice__result-verdict">{verdict}</p>
    </section>
  )
}

/* ---- Picking a friend to challenge ------------------------------------------------------- */

type Candidate = { student_id: string; display_name: string; detail: string }

function ChallengeDialog({ token, selfId, course, unit, length, mode, deck, answers, onClose, onSent }: {
  token: string
  selfId: string
  course: string
  unit: string
  length: RoundLength
  mode: RoundMode
  deck: DeckCard[]
  answers?: boolean[]
  onClose: () => void
  onSent: (challenge: Challenge) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [people, setPeople] = useState<Candidate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = () => { if (!busy) onClose() }
  useDrawer({ open: true, onClose: cancel, panel })
  const challengeMode: RoundMode = mode === 'choice' && deck.length < CHOICE_MIN_CARDS ? 'self' : mode

  useEffect(() => {
    let live = true
    Promise.all([getFriends(token), getStudyGroups(token).catch(() => [])]).then(([hub, groups]) => {
      if (!live) return
      const seen = new Set<string>([selfId])
      const list: Candidate[] = []
      for (const friend of hub.friends) {
        if (seen.has(friend.student_id)) continue
        seen.add(friend.student_id)
        list.push({ student_id: friend.student_id, display_name: friend.display_name, detail: `Friend · @${friend.username}` })
      }
      for (const group of groups) {
        for (const member of group.members) {
          if (seen.has(member.student_id)) continue
          seen.add(member.student_id)
          list.push({ student_id: member.student_id, display_name: member.display_name, detail: `In ${group.name}` })
        }
      }
      setPeople(list)
    }).catch((caught) => { if (live) setLoadError(errorText(caught, 'Your friends couldn’t load.')) })
    return () => { live = false }
  }, [token, selfId])

  async function send() {
    if (!chosen || busy) return
    setBusy(true)
    setError('')
    try {
      const sent = await createChallenge({
        to_id: chosen, course, unit, length_s: length, mode: challengeMode, card_ids: deck.map((card) => card.id),
        ...(answers && answers.length ? { answers: answers.slice(0, deck.length) } : {}),
      }, token)
      onSent(sent)
    } catch (caught) {
      setError(errorText(caught, 'Couldn’t send the challenge. Try again.'))
      setBusy(false)
    }
  }

  return (
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel() }}>
      <div ref={panel} className="ui-dialog practice__dialog" role="dialog" aria-modal="true" aria-labelledby="challenge-title">
        <header className="ui-dialog__header">
          <h2 className="ui-dialog__title" id="challenge-title">Challenge a friend</h2>
        </header>
        <div className="practice__dialog-body">
          <p className="practice__dialog-lede">
            They play the same {deck.length} {deck.length === 1 ? 'card' : 'cards'} in the same order: {scopeLabel(course, unit)}, {lengthLabel(length)}, {modeLabel(challengeMode).toLowerCase()}.
            {answers?.length ? ' Your score from this round is your entry.' : ' You play your own turn after sending.'} Challenges expire after 7 days.
          </p>
          <div className="ui-alert ui-alert--info practice__share-note">
            <span><b>Your friend will see these flashcards.</b> The question and answer text of these cards is copied into the challenge and shared only with the person you pick. Your notes stay private.</span>
          </div>
          {loadError ? <div className="ui-alert" role="alert"><span>{loadError}</span></div> : null}
          {people === null && !loadError ? <div className="practice__people" aria-busy="true"><span className="ui-skeleton practice__skeleton" /><span className="ui-skeleton practice__skeleton" /></div> : null}
          {people && !people.length ? (
            <p className="practice__dialog-lede">You can challenge friends and people in your study groups. Add a friend in <a className="ui-link" href="#profile">Friends &amp; groups</a> first.</p>
          ) : null}
          {people?.length ? (
            <fieldset className="practice__people">
              <legend className="practice__option-label">Who?</legend>
              {people.map((person) => (
                <label key={person.student_id} className={`practice__person${chosen === person.student_id ? ' is-chosen' : ''}`}>
                  <input type="radio" name="challenge-person" aria-label={`${person.display_name}, ${person.detail}`} value={person.student_id} checked={chosen === person.student_id} onChange={() => setChosen(person.student_id)} />
                  <Avatar name={person.display_name} />
                  <span className="practice__row-text">
                    <span className="practice__row-title">{person.display_name}</span>
                    <span className="practice__row-meta">{person.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}
        </div>
        <footer className="ui-dialog__footer">
          <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={cancel}>Cancel</button>
          <button type="button" className={`ui-button ui-button--primary${busy ? ' is-busy' : ''}`} disabled={!chosen || busy} onClick={() => void send()}>Send challenge</button>
        </footer>
      </div>
    </div>
  )
}
