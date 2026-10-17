import { useEffect, useState } from 'react'
import { parseServerTime, type Badge, type BadgeList } from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { badgePercent, onServerRewards } from '../../lib/rewards'
import { toneClass } from '../../lib/tones'
import { rewardIcon } from './RewardIcon'
import './Rewards.css'

const earnedDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/* One badge tile: bright with its tone when earned, dim with progress while locked. */
export function BadgeTile({ badge }: { badge: Badge }) {
  const percent = badgePercent(badge.progress, badge.target)
  return (
    <li className={`rb ${toneClass(badge.tone)}${badge.earned ? ' is-earned' : ' is-locked'}`}>
      <span className="rb__icon" aria-hidden="true">{rewardIcon(badge.icon)}</span>
      <span className="rb__text">
        <span className="rb__title">{badge.title}<span className="sr-only">{badge.earned ? ', earned' : ', not earned yet'}</span></span>
        <span className="rb__desc">{badge.description}</span>
        {badge.earned && badge.earned_at ? (
          <span className="rb__meta">Earned {earnedDate.format(new Date(parseServerTime(badge.earned_at)))}</span>
        ) : badge.target && badge.progress !== null && badge.target > 1 ? (
          <span className="rb__progress">
            <span className="rb__meter" role="progressbar" aria-label={`${badge.title} progress`} aria-valuemin={0} aria-valuemax={badge.target} aria-valuenow={badge.progress}>
              <span style={{ width: `${percent}%` }} />
            </span>
            <span className="rb__meta">{badge.progress} / {badge.target}</span>
          </span>
        ) : null}
      </span>
    </li>
  )
}

/* Friends & groups: every badge, earned ones first, plus the streak freezes in the bank. */
export function BadgesSection({ token }: { token?: string }) {
  const data = useData()
  const [list, setList] = useState<BadgeList | null>(null)
  const [failed, setFailed] = useState(false)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!token) return
    let live = true
    const load = () => data.getBadges(token)
      .then((next) => { if (live) { setList(next); setFailed(false) } })
      .catch(() => { if (live) setFailed(true) })
    void load()
    const stop = onServerRewards((detail) => { if (detail.badges_earned?.length || detail.streak_saved) void load() })
    return () => { live = false; stop() }
  }, [data, token])

  if (!token || data.sandboxed) return null
  const earned = list?.badges.filter((badge) => badge.earned) ?? []
  const locked = list?.badges.filter((badge) => !badge.earned) ?? []
  // Phones: the earned ones and the closest few locked ones, the rest behind "Show all".
  const lockedShown = showAll ? locked : locked.toSorted((a, b) => badgePercent(b.progress, b.target) - badgePercent(a.progress, a.target)).slice(0, Math.max(0, 6 - earned.length))
  const freezes = list?.freezes.banked ?? 0

  return (
    <section className="ui-section rb-section" aria-labelledby="badges-title">
      <div className="ui-section-head">
        <h2 className="ui-section-title" id="badges-title">
          <span className="profile__head-icon ui-tone--amber">{rewardIcon('trophy')}</span>
          Badges {list ? <span className="ui-count">{list.earned} of {list.total}</span> : null}
        </h2>
        {list ? (
          <span className={`rb-freeze ui-tone--teal${freezes ? '' : ' is-empty'}`} title="A streak freeze covers one missed day automatically. You earn one each week you study, up to 2.">
            <span aria-hidden="true">{rewardIcon('freeze')}</span>
            {freezes} of {list.freezes.max}<span className="rb-freeze__word"> streak freezes</span>
            <span className="sr-only"> banked</span>
          </span>
        ) : null}
      </div>
      <div className="ui-panel rb-panel">
        {failed && !list ? (
          <div className="ui-alert" role="alert">
            <span>Badges couldn’t load.</span>
            <button type="button" className="ui-button ui-button--sm" onClick={() => { setFailed(false); void data.getBadges(token).then(setList).catch(() => setFailed(true)) }}>Try again</button>
          </div>
        ) : !list ? (
          <ul className="rb-grid" aria-busy="true" aria-label="Loading badges">
            {[0, 1, 2, 3].map((key) => <li key={key} className="ui-skeleton rb-skeleton" />)}
          </ul>
        ) : (
          <>
            {earned.length ? null : <p className="rb-empty">Your first badge is close. Add notes or review a few cards to earn one.</p>}
            <ul className="rb-grid" aria-label="Badges">
              {earned.map((badge) => <BadgeTile key={badge.id} badge={badge} />)}
              {lockedShown.map((badge) => <BadgeTile key={badge.id} badge={badge} />)}
            </ul>
            {locked.length > lockedShown.length || showAll ? (
              <button type="button" className="ui-button ui-button--sm rb-more" aria-expanded={showAll} onClick={() => setShowAll((current) => !current)}>
                {showAll ? 'Show fewer' : `Show all ${list.total} badges`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}

/* A friend's earned badges, inside their streak detail (friends only, like the rest of it). */
export function FriendBadges({ token, friendId, name }: { token?: string; friendId: string; name: string }) {
  const data = useData()
  const [badges, setBadges] = useState<Badge[] | null>(null)

  useEffect(() => {
    if (!token || data.sandboxed) return
    const controller = new AbortController()
    data.getFriendBadges(friendId, token, controller.signal).then((result) => setBadges(result.badges)).catch(() => setBadges([]))
    return () => controller.abort()
  }, [data, token, friendId])

  if (!badges?.length) return null
  return (
    <div className="rb-friend">
      <h4 className="profile__label">{name}’s badges</h4>
      <ul className="rb-friend__list">
        {badges.map((badge) => (
          <li key={badge.id} className={`rb-friend__chip ${toneClass(badge.tone)}`} title={badge.description}>
            <span aria-hidden="true">{rewardIcon(badge.icon)}</span>{badge.title}
          </li>
        ))}
      </ul>
    </div>
  )
}
