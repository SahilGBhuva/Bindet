import { useCallback, useEffect, useRef, useState } from 'react'
import type { TodayQuests } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { onRewards, questCount, questPercent, questTones, QUEST_ICON } from '../../lib/rewards'
import { toneClass } from '../../lib/tones'
import { rewardIcon } from './RewardIcon'
import './Rewards.css'

/*
 * Home's "Today's quests": three small goals for the student's local day, each with a
 * colored icon chip and a progress bar, then today's chest. Once the quests and the daily
 * goal are done, the card says so and invites the student to stop: no more tasks appear.
 * Refreshes whenever an API response carries rewards (lib/api.ts REWARDS_EVENT).
 */
export function QuestsCard({ token }: { token?: string }) {
  const data = useData()
  const [state, setState] = useState<TodayQuests | null>(null)
  const [failed, setFailed] = useState(false)
  const timer = useRef(0)

  const load = useCallback((signal?: AbortSignal) => {
    if (!token) return
    data.getQuestsToday(token, signal)
      .then((next) => { setState(next); setFailed(false) })
      .catch((error) => { if (!signal?.aborted) setFailed(true); void error })
  }, [data, token])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    // A study action elsewhere (a review, a quiz answer) moved a quest: read again, once.
    const stop = onRewards(() => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => load(), 400)
    })
    // Coming back to the tab (maybe the next day): the day's quests may have changed.
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller.abort()
      stop()
      window.clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  if (!token) return null
  if (!state) {
    return failed ? (
      <section className="rq ui-alert" aria-label="Today's quests">
        <span>Today’s quests couldn’t load.</span>
        <button type="button" className="ui-button ui-button--sm" onClick={() => { setFailed(false); load() }}>Try again</button>
      </section>
    ) : (
      <section className="rq" aria-busy="true" aria-label="Loading today's quests">
        <div className="rq__band"><span className="ui-skeleton rq__skeleton-title" /></div>
        <div className="rq__body">
          {[0, 1, 2].map((key) => <span key={key} className="ui-skeleton rq__skeleton-row" />)}
        </div>
      </section>
    )
  }
  if (!state.quests.length) return null

  const tones = questTones(state.quests.map((quest) => quest.id))
  const doneCount = state.quests.filter((quest) => quest.done).length
  const allQuests = doneCount === state.quests.length

  if (state.all_done) {
    return (
      <section className="rq rq--done" aria-labelledby="rq-title">
        <div className="rq__band rq__band--done">
          <img className="ui-mascot-cheer rq__cheer" src="/bindit-mascot-cutout.webp" alt="" width="36" height="43" />
          <div className="rq__heading">
            <h2 className="rq__title" id="rq-title">All done for today <span aria-hidden="true">🎉</span></h2>
            <p className="rq__sub">Great work. Come back tomorrow for new quests.</p>
          </div>
        </div>
        <ul className="rq__done-list" aria-label="Finished today">
          {state.quests.map((quest, index) => (
            <li key={quest.id} className={`rq__done-chip ${toneClass(tones[index])}`}>
              <span className="rq__done-check" aria-hidden="true">{rewardIcon('check')}</span>
              {quest.title}
            </li>
          ))}
          <li className="rq__done-chip ui-tone--amber">
            <span className="rq__done-check" aria-hidden="true">{rewardIcon('chestOpen')}</span>
            Chest +{state.chest.xp} XP
          </li>
        </ul>
      </section>
    )
  }

  return (
    <section className="rq" aria-labelledby="rq-title">
      <div className="rq__band">
        <span className="rq__band-icon ui-tone--violet" aria-hidden="true">{rewardIcon('target')}</span>
        <div className="rq__heading">
          <h2 className="rq__title" id="rq-title">Today’s quests</h2>
          <p className="rq__sub">Three small goals. Each one is worth +{state.quests[0]?.xp ?? 5} XP.</p>
        </div>
        <span className="rq__tally">{doneCount} of {state.quests.length}<span className="sr-only"> done</span></span>
      </div>
      <ol className="rq__list">
        {state.quests.map((quest, index) => {
          const percent = questPercent(quest)
          return (
            <li key={quest.id} className={`rq__quest ${toneClass(tones[index])}${quest.done ? ' is-done' : ''}`}>
              <span className="rq__icon" aria-hidden="true">{rewardIcon(quest.done ? 'check' : QUEST_ICON[quest.id] ?? 'sparkle')}</span>
              <span className="rq__main">
                <span className="rq__quest-title">
                  {quest.title}
                  {quest.done ? <span className="sr-only">, done</span> : null}
                </span>
                <span
                  className="rq__meter"
                  role="progressbar"
                  aria-label={`${quest.title}: ${questCount(quest)}`}
                  aria-valuemin={0}
                  aria-valuemax={quest.target}
                  aria-valuenow={Math.min(quest.progress, quest.target)}
                >
                  <span style={{ width: `${percent}%` }} />
                </span>
              </span>
              <span className="rq__count">{quest.done ? `+${quest.xp} XP` : questCount(quest)}</span>
            </li>
          )
        })}
      </ol>
      <div className={`rq__chest ${allQuests ? 'is-open' : ''}`}>
        <span className="rq__chest-icon" aria-hidden="true">{rewardIcon(allQuests ? 'chestOpen' : 'chest')}</span>
        <span className="rq__chest-text">
          <strong>{allQuests ? 'Chest opened' : 'Today’s chest'}</strong>
          <span>
            {allQuests
              ? `+${state.chest.xp} XP. Reach your daily goal (${state.goal.xp} / ${state.goal.target} XP) to wrap up the day.`
              : `Finish all three to open it: +${state.chest.xp} XP.`}
          </span>
        </span>
      </div>
    </section>
  )
}
