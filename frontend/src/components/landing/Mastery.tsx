import { useMemo, type CSSProperties } from 'react'
import { VERDICT_COPY } from '../../lib/progress'
import { toneClass, toneForName } from '../../lib/tones'
import { demoMastery, demoSocial } from './story'

/*
 * Mastered: the demo student's nine units as a constellation. Every ring is the
 * unit's real mastery score and verdict, computed by the same code as the
 * Progress page. Units of one course are joined in that course's color.
 */

/* Centre of each unit on the map, as percentages of its width and height. */
const SPOTS: Record<string, [number, number]> = {
  Functions: [5, 33],
  Logarithms: [21, 13],
  'Colonial era': [9, 72],
  Revolution: [28, 81],
  Evolution: [37, 46],
  Genetics: [53, 15],
  Cells: [71, 44],
  Stoichiometry: [54, 76],
  Atoms: [82, 78],
}

const FAINT_LINKS: [string, string][] = [['Logarithms', 'Evolution'], ['Evolution', 'Revolution'], ['Evolution', 'Stoichiometry'], ['Cells', 'Atoms']]

const LEGEND = [
  { verdict: 'seeded' as const, fill: 0 },
  { verdict: 'steady' as const, fill: 58 },
  { verdict: 'sharp' as const, fill: 86 },
]

function Ring({ fill }: { fill?: number }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle className="lp-ring__track" cx="50" cy="50" r="44" />
      <circle className="lp-ring__arc" cx="50" cy="50" r="44" pathLength={100} transform="rotate(-90 50 50)" style={fill === undefined ? undefined : { strokeDashoffset: 100 - fill }} />
    </svg>
  )
}

export function Mastery() {
  const courses = useMemo(() => demoMastery(), [])
  const social = useMemo(() => demoSocial(), [])
  const units = courses.flatMap((course) => course.units.map((unit) => ({ ...unit, next: unit.name === course.next && unit.verdict === 'stuck' })))

  return (
    <section className="lp-mastery" id="mastery" aria-labelledby="lp-mastery-title">
      <div className="lp-mastery__map" data-reveal>
        <svg className="lp-mastery__links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {FAINT_LINKS.map(([a, b]) => (
            <path key={`${a}-${b}`} className="is-faint" d={`M${SPOTS[a][0]} ${SPOTS[a][1]}L${SPOTS[b][0]} ${SPOTS[b][1]}`} vectorEffect="non-scaling-stroke" />
          ))}
          {courses.flatMap((course) =>
            course.units.slice(1).map((unit, index) => {
              const from = SPOTS[course.units[index].name]
              const to = SPOTS[unit.name]
              return from && to ? <path key={unit.name} d={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`} stroke={course.tone} vectorEffect="non-scaling-stroke" /> : null
            }),
          )}
        </svg>
        <ul className="lp-mastery__nodes" aria-label="The demo student’s units and their mastery">
          {units.map((unit, index) => {
            const spot = SPOTS[unit.name] ?? [50, 50]
            return (
              <li
                key={unit.name}
                className={`lp-node is-${unit.verdict}`}
                style={{ '--x': `${spot[0]}%`, '--y': `${spot[1]}%`, '--m': unit.mastery, '--size': `${78 + unit.mastery * 0.95}px`, '--course': unit.tone, '--i': index } as CSSProperties}
              >
                <span className="lp-node__ring">
                  <Ring />
                  <b>{unit.mastery}</b>
                </span>
                <span className="lp-node__name">{unit.name}</span>
                <span className="lp-node__verdict">
                  {VERDICT_COPY[unit.verdict].label}
                  {unit.next ? <em>Next up</em> : null}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="lp-mastery__copy">
        <p className="lp-kicker" data-reveal>Mastered</p>
        <h2 className="lp-serif lp-mastery__title" id="lp-mastery-title" data-reveal>Watch it<br /><em>stick.</em></h2>
        <p className="lp-mastery__lead" data-reveal>
          Every unit earns a mastery score from your quiz history. bindit shows what is sharp, what is stuck, and what to study next.
        </p>
        <dl className="lp-mastery__legend" data-reveal>
          {LEGEND.map((item) => (
            <div key={item.verdict} className={`lp-node is-${item.verdict}`}>
              <dt><span className="lp-node__ring"><Ring fill={item.fill} /></span>{VERDICT_COPY[item.verdict].label}</dt>
              <dd>{VERDICT_COPY[item.verdict].hint.replace(' — ', ', ')}</dd>
            </div>
          ))}
        </dl>
        <p className="lp-fineprint" data-reveal>
          These are Maya’s numbers, the demo student in the live demo above: {social.accuracy}% accuracy, a {social.streak}-day streak and {social.xp.toLocaleString()} XP.
        </p>
      </div>
    </section>
  )
}

/* Together: the social side of bindit, set as type and real rows instead of cards. */
export function Together() {
  const social = useMemo(() => demoSocial(), [])
  const top = Math.max(1, ...social.leaderboard.map((friend) => friend.weekly_xp))
  const quest = social.quest

  return (
    <section className="lp-together" aria-labelledby="lp-together-title">
      <div className="lp-together__copy">
        <h2 className="lp-serif lp-together__title" id="lp-together-title" data-reveal>Better with<br /><em>your people.</em></h2>
        <p className="lp-together__lead" data-reveal>
          Keep a daily streak, climb a weekly league with friends, team up on 100 XP quests, and start a study group with an invite code.
        </p>
      </div>

      <div className="lp-together__board" data-reveal>
        <p className="lp-together__caption">This week’s league <span>demo data</span></p>
        <ol className="lp-league">
          {social.leaderboard.map((friend, index) => (
            <li key={friend.student_id} className={`${toneClass(toneForName(friend.display_name))}${friend.username === 'maya_r' ? ' is-you' : ''}`} style={{ '--w': friend.weekly_xp / top, '--i': index } as CSSProperties}>
              <span className="lp-league__rank">{index + 1}</span>
              <span className="lp-league__avatar" aria-hidden="true">{friend.display_name.charAt(0)}</span>
              <span className="lp-league__name">{friend.display_name}{friend.username === 'maya_r' ? <i> · you</i> : null}</span>
              <span className="lp-league__bar" aria-hidden="true"><i /></span>
              <span className="lp-league__xp">{friend.weekly_xp} XP</span>
            </li>
          ))}
        </ol>
        {quest ? (
          <div className="lp-quest" style={{ '--w': quest.progress_xp / quest.target_xp } as CSSProperties}>
            <p><b>Friend quest</b> with {quest.friend_name}<span>{quest.progress_xp} / {quest.target_xp} XP</span></p>
            <span className="lp-quest__bar" role="img" aria-label={`${quest.progress_xp} of ${quest.target_xp} XP`}><i /></span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
