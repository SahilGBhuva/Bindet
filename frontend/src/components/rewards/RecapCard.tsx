import { useEffect, useState } from 'react'
import type { WeeklyRecap } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { recapRange } from '../../lib/rewards'
import { toneClass } from '../../lib/tones'
import { rewardIcon } from './RewardIcon'
import './Rewards.css'

/*
 * Home's weekly recap: from the first visit after Monday 12:00 am (the student's local
 * time) until dismissed, a look back at last week built from what the server already
 * keeps. Only celebrates; a quiet week simply shows no card.
 */
export function RecapCard({ token }: { token?: string }) {
  const data = useData()
  const [recap, setRecap] = useState<WeeklyRecap | null>(null)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    data.getLastWeekRecap(token, controller.signal).then(setRecap).catch(() => { /* optional card: stay hidden */ })
    return () => controller.abort()
  }, [data, token])

  if (!token || !recap?.show || closing) return null

  async function dismiss() {
    setClosing(true)
    try {
      await data.dismissLastWeekRecap(token)
    } catch {
      setClosing(false)
    }
  }

  const stats = [
    { key: 'days', tone: 'orange', icon: 'calendar', label: 'Days studied', value: `${recap.days_studied}`, small: ' of 7' },
    { key: 'xp', tone: 'violet', icon: 'sparkle', label: 'XP earned', value: recap.xp.toLocaleString(), small: '' },
    { key: 'cards', tone: 'teal', icon: 'cards', label: 'Cards reviewed', value: recap.cards_reviewed.toLocaleString(), small: '' },
    { key: 'streak', tone: 'amber', icon: 'flame', label: 'Longest streak', value: `${recap.longest_streak}`, small: recap.longest_streak === 1 ? ' day' : ' days' },
  ] as const

  return (
    <section className="rr" aria-labelledby="rr-title">
      <div className="rr__band">
        <span className="rr__band-icon" aria-hidden="true">{rewardIcon('trophy')}</span>
        <div className="rr__heading">
          <p className="rr__eyebrow">Your week · {recapRange(recap.week_start, recap.week_end)}</p>
          <h2 className="rr__title" id="rr-title">Last week, wrapped up</h2>
        </div>
        <button type="button" className="rr__close" onClick={() => void dismiss()} aria-label="Dismiss last week’s recap">
          {rewardIcon('x')}
        </button>
      </div>
      <ul className="rr__stats">
        {stats.map((stat) => (
          <li key={stat.key} className={`rr__stat ${toneClass(stat.tone)}`}>
            <span className="rr__stat-icon" aria-hidden="true">{rewardIcon(stat.icon)}</span>
            <span className="rr__stat-label">{stat.label}</span>
            <span className="rr__stat-value">{stat.value}{stat.small ? <small>{stat.small}</small> : null}</span>
          </li>
        ))}
      </ul>
      <div className="rr__foot">
        {recap.best_subject ? (
          <p className="rr__line"><span className="rr__line-label">Best subject</span> <strong>{recap.best_subject}</strong></p>
        ) : null}
        {recap.badges_earned.length ? (
          <div className="rr__line">
            <span className="rr__line-label">Badges earned</span>
            <ul className="rr__badges">
              {recap.badges_earned.map((badge) => (
                <li key={badge.id} className={`rr__badge ${toneClass(badge.tone)}`}>
                  <span aria-hidden="true">{rewardIcon(badge.icon)}</span>{badge.title}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <button type="button" className="ui-button ui-button--sm rr__done" onClick={() => void dismiss()}>Nice, got it</button>
      </div>
    </section>
  )
}
