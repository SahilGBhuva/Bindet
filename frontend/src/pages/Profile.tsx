import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { answerFriendRequest, blockSocialUser, createStudyGroup, getAccountProfile, getCachedFriends, getCachedProfile, getCachedProgress, getCachedStudyGroups, getFriends, getProgress, getStudyGroups, joinStudyGroup, leaveStudyGroup, reactToActivity, readSocialNotifications, removeFriend, reportSocialUser, saveSocialPrivacy, searchFriends, sendFriendRequest, startFriendQuest, type FriendsHub, type PersonSuggestion, type Profile as ProfileData, type Progress as ProgressData, type StudyGroup } from '../lib/api'
import type { AuthSession } from '../lib/auth'
import { getStudentId, loadNotebook } from '../lib/session'
import type { Course } from '../lib/types'
import { AvatarControl } from '../lib/AvatarControl'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import { Icons } from '../components/Icons'
import './Profile.css'

const XP_PER_LEVEL = 100

function xpLevel(totalXp: number) {
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1
  const inLevel = totalXp % XP_PER_LEVEL
  return { level, inLevel, toNext: XP_PER_LEVEL - inLevel }
}

function formatTopic(topic: string) {
  return topic.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

type ProfileProps = {
  session: AuthSession | null
  onError?: (message: string) => void
}

export function Profile({ session, onError }: ProfileProps) {
  const studentId = session?.user.id ?? getStudentId()
  const [profile, setProfile] = useState<ProfileData | null>(() => session ? getCachedProfile(session.access_token) : null)
  const [stats, setStats] = useState<ProgressData | null>(() => getCachedProgress(studentId))
  const [courses, setCourses] = useState<Course[]>(() => loadNotebook().courses)
  const [activeCourse, setActiveCourse] = useState(() => loadNotebook().activeCourse)
  const [social, setSocial] = useState<FriendsHub | null>(() => session ? getCachedFriends(session.access_token) : null)
  const [groups, setGroups] = useState<StudyGroup[]>(() => session ? getCachedStudyGroups(session.access_token) ?? [] : [])
  const [activeGroupId, setActiveGroupId] = useState('')
  const [showGroupSetup, setShowGroupSetup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [groupCode, setGroupCode] = useState('')
  const [friendCode, setFriendCode] = useState('')
  const [socialBusy, setSocialBusy] = useState(false)
  const [socialMessage, setSocialMessage] = useState('')
  const [peopleQuery, setPeopleQuery] = useState('')
  const [peopleResults, setPeopleResults] = useState<PersonSuggestion[]>([])

  useEffect(() => {
    void getProgress(studentId, session?.access_token, true)
      .then(setStats)
      .catch(() => setStats(null))
  }, [studentId, session?.access_token])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }
    void getAccountProfile(session.access_token, true)
      .then(setProfile)
      .catch(() => onError?.('Could not load your profile.'))
  }, [session, onError])

  const refreshSocial = useCallback(async (force = true) => {
    if (!session) return
    const [friendsResult, groupsResult] = await Promise.allSettled([
      getFriends(session.access_token, force),
      getStudyGroups(session.access_token, force),
    ])
    if (friendsResult.status === 'fulfilled') setSocial(friendsResult.value)
    else {
      onError?.('Could not load friends right now.')
    }
    if (groupsResult.status === 'fulfilled') {
      setGroups(groupsResult.value)
      setActiveGroupId((current) => current || groupsResult.value[0]?.id || '')
    }
  }, [session, onError])

  useEffect(() => {
    if (!session) {
      setSocial(null)
      setGroups([])
      return
    }
    const cachedFriends = getCachedFriends(session.access_token)
    const cachedGroups = getCachedStudyGroups(session.access_token)
    if (cachedFriends) setSocial(cachedFriends)
    if (cachedGroups) {
      setGroups(cachedGroups)
      setActiveGroupId((current) => current || cachedGroups[0]?.id || '')
    }
    void refreshSocial(true)
  }, [session, refreshSocial])

  async function addFriend(event: FormEvent) {
    event.preventDefault()
    if (!session || !friendCode.trim()) return
    setSocialBusy(true)
    setSocialMessage('')
    try {
      await sendFriendRequest(friendCode.trim(), session.access_token)
      setFriendCode('')
      setSocialMessage('Friend request sent!')
      await refreshSocial()
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : 'Could not send that request.')
    } finally {
      setSocialBusy(false)
    }
  }

  async function findPeople(event: FormEvent) {
    event.preventDefault()
    if (!session || peopleQuery.trim().length < 2) return
    setSocialBusy(true)
    try {
      setPeopleResults(await searchFriends(peopleQuery, session.access_token))
    } finally {
      setSocialBusy(false)
    }
  }

  async function addSuggested(person: PersonSuggestion) {
    if (!session) return
    setSocialBusy(true)
    try {
      await sendFriendRequest(person.friend_code, session.access_token)
      setPeopleResults((current) => current.filter((item) => item.student_id !== person.student_id))
      setSocialMessage(`Friend request sent to ${person.display_name}.`)
      await refreshSocial()
    } finally {
      setSocialBusy(false)
    }
  }

  async function shareFriendId() {
    if (!profile?.friend_code) return
    const share = { title: 'Add me on bindit', text: `Add me on bindit with friend ID ${profile.friend_code}`, url: window.location.origin }
    try {
      if (navigator.share) await navigator.share(share)
      else {
        await navigator.clipboard.writeText(`${share.text} — ${share.url}`)
        setSocialMessage('Friend ID copied. Paste it into Messages, Instagram, or any app.')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSocialMessage('Could not open sharing. You can copy the ID above.')
    }
  }

  async function celebrate(eventId: number) {
    if (!session) return
    setSocial((current) => current ? {
      ...current,
      activity: current.activity.map((item) => item.id === eventId ? {
        ...item, reacted: !item.reacted, reaction_count: Math.max(0, item.reaction_count + (item.reacted ? -1 : 1)),
      } : item),
    } : current)
    try {
      await reactToActivity(eventId, session.access_token)
    } catch {
      await refreshSocial()
    }
  }

  async function markNotificationsRead() {
    if (!session) return
    await readSocialNotifications(session.access_token)
    setSocial((current) => current ? { ...current, notifications: current.notifications.map((item) => ({ ...item, is_read: true })) } : current)
    void refreshSocial()
  }

  async function togglePrivacy(field: 'discoverable' | 'allow_friend_requests') {
    if (!session || !profile) return
    const discoverable = field === 'discoverable' ? !profile.discoverable : profile.discoverable
    const requests = field === 'allow_friend_requests' ? !profile.allow_friend_requests : profile.allow_friend_requests
    await saveSocialPrivacy(discoverable, requests, session.access_token)
    setProfile({ ...profile, discoverable, allow_friend_requests: requests })
  }

  async function blockFriend(friendId: string) {
    if (!session || !window.confirm('Block this person? They will be removed and unable to find or contact you.')) return
    await blockSocialUser(friendId, session.access_token)
    setSocialMessage('Person blocked.')
    await refreshSocial()
  }

  async function reportFriend(friendId: string) {
    if (!session || !window.confirm('Send a safety report about this person?')) return
    await reportSocialUser(friendId, session.access_token)
    setSocialMessage('Report sent. Thank you for helping keep bindit safe.')
  }

  async function answerRequest(requestId: number, accept: boolean) {
    if (!session) return
    setSocialBusy(true)
    try {
      await answerFriendRequest(requestId, accept, session.access_token)
      setSocialMessage(accept ? 'You are friends now!' : 'Request declined.')
      await refreshSocial()
    } finally {
      setSocialBusy(false)
    }
  }

  async function beginQuest(friendId: string) {
    if (!session) return
    setSocialBusy(true)
    try {
      await startFriendQuest(friendId, session.access_token)
      setSocialMessage('Friend Quest started — earn 100 XP together this week!')
      await refreshSocial()
    } finally {
      setSocialBusy(false)
    }
  }

  async function unfriend(friendId: string) {
    if (!session || !window.confirm('Remove this friend?')) return
    setSocialBusy(true)
    try {
      await removeFriend(friendId, session.access_token)
      setSocialMessage('Friend removed.')
      await refreshSocial()
    } finally {
      setSocialBusy(false)
    }
  }

  async function makeGroup(event: FormEvent) {
    event.preventDefault()
    if (!session || groupName.trim().length < 2) return
    setSocialBusy(true)
    setSocialMessage('')
    try {
      const group = await createStudyGroup({ name: groupName.trim(), description: groupDescription.trim(), weekly_goal_xp: 500 }, session.access_token)
      setGroups((current) => [group, ...current])
      setActiveGroupId(group.id)
      setGroupName('')
      setGroupDescription('')
      setShowGroupSetup(false)
      setSocialMessage(`${group.name} is ready. Share code ${group.invite_code} with your friends.`)
      void refreshSocial()
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : 'Could not create that group.')
    } finally {
      setSocialBusy(false)
    }
  }

  async function joinGroup(event: FormEvent) {
    event.preventDefault()
    if (!session || groupCode.trim().length < 6) return
    setSocialBusy(true)
    setSocialMessage('')
    try {
      const group = await joinStudyGroup(groupCode.trim(), session.access_token)
      setGroups((current) => [group, ...current.filter((item) => item.id !== group.id)])
      setActiveGroupId(group.id)
      setGroupCode('')
      setShowGroupSetup(false)
      setSocialMessage(`Joined ${group.name}.`)
      void refreshSocial()
    } catch (error) {
      setSocialMessage(error instanceof Error ? error.message : 'Could not join that group.')
    } finally {
      setSocialBusy(false)
    }
  }

  async function copyGroupCode(code: string) {
    await navigator.clipboard.writeText(code)
    setSocialMessage('Group invite code copied.')
  }

  async function exitGroup(group: StudyGroup) {
    if (!session || group.role === 'owner' || !window.confirm(`Leave ${group.name}?`)) return
    await leaveStudyGroup(group.id, session.access_token)
    setGroups((current) => current.filter((item) => item.id !== group.id))
    setActiveGroupId('')
    setSocialMessage(`Left ${group.name}.`)
  }

  useEffect(() => {
    const syncNotebook = () => {
      const notebook = loadNotebook()
      setCourses(notebook.courses)
      setActiveCourse(notebook.activeCourse)
    }
    syncNotebook()
    window.addEventListener('storage', syncNotebook)
    window.addEventListener('hashchange', syncNotebook)
    return () => {
      window.removeEventListener('storage', syncNotebook)
      window.removeEventListener('hashchange', syncNotebook)
    }
  }, [])

  const totalXp = profile?.total_xp ?? stats?.total_xp ?? 0
  const { level, inLevel, toNext } = xpLevel(totalXp)
  const loginStreak = profile?.login_streak ?? stats?.login_streak ?? 0
  const unitStats = stats?.topics ?? []
  const username = profile?.username ?? 'Guest'
  const tag = profile?.friend_code ?? '—'
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null

  return (
    <div className="ui-page profile">
      {!session ? (
        <div className="ui-panel profile__guest" role="note">
          <span>Log in to save your progress and get a friend code.</span>
          <a className="ui-button ui-button--primary ui-button--sm" href="#settings">Log in</a>
        </div>
      ) : null}

      <header className="ui-page-header profile__header">
        <div className="profile__identity">
          <AvatarControl onError={onError} />
          <div className="profile__identity-text">
            <h1 className="ui-page-title profile__name">{profile?.display_name ?? username}</h1>
            <p className="ui-page-subtitle">
              {profile ? `@${profile.username} · ` : ''}Friend code <span className="profile__code">{tag}</span>
            </p>
          </div>
        </div>
        <a className="ui-button" href="#settings">
          <GearMark />
          Settings
        </a>
      </header>

      <section className="ui-panel ui-stats profile__stats" aria-label="Your stats">
        <div className="ui-stat ui-tone--blue">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.level}</span>Level</span>
          <span className="ui-stat__value">{level}</span>
          <div
            className="ui-meter"
            role="progressbar"
            aria-valuenow={inLevel}
            aria-valuemin={0}
            aria-valuemax={XP_PER_LEVEL}
            aria-label={`${inLevel} of ${XP_PER_LEVEL} XP toward level ${level + 1}`}
          >
            <span style={{ width: `${(inLevel / XP_PER_LEVEL) * 100}%` }} />
          </div>
        </div>
        <div className="ui-stat ui-tone--violet">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.sparkle}</span>Total XP</span>
          <span className="ui-stat__value">{totalXp.toLocaleString()}</span>
          <span className="ui-stat__meta">{toNext} XP to level {level + 1}</span>
        </div>
        <div className="ui-stat ui-tone--orange">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.flame}</span>Login streak</span>
          <span className="ui-stat__value">{loginStreak}<span className="ui-stat__unit">{loginStreak === 1 ? 'day' : 'days'}</span></span>
          {loginStreak >= 7 ? <img className="ui-mascot-cheer profile__streak-mascot" src="/bindit-mascot.webp" alt="" title={`${loginStreak}-day streak`} /> : null}
        </div>
        <div className="ui-stat ui-tone--pink">
          <span className="ui-stat__label"><span className="ui-stat__icon">{Icons.users}</span>Friends</span>
          <span className="ui-stat__value">{social?.friends.length ?? 0}</span>
          {social?.requests.length ? <span className="ui-stat__meta">{social.requests.length} pending {social.requests.length === 1 ? 'request' : 'requests'}</span> : null}
        </div>
      </section>

      {socialMessage ? <p className="profile__message" role="status">{socialMessage}</p> : null}

      <div className="profile__grid">
        <div className="profile__main">
          <section className="ui-section" aria-labelledby="study-groups-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="study-groups-title">Study groups</h2>
              {session ? (
                <button className="ui-button ui-button--sm" type="button" onClick={() => setShowGroupSetup((current) => !current)}>
                  {showGroupSetup ? 'Close' : 'New group'}
                </button>
              ) : null}
            </div>

            {showGroupSetup ? (
              <div className="ui-panel profile__group-setup">
                <form className="profile__form" onSubmit={makeGroup}>
                  <span className="ui-card__eyebrow">Create</span>
                  <p className="ui-card__title">Start a focused group</p>
                  <input className="ui-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" maxLength={48} aria-label="Group name" />
                  <input className="ui-input" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} placeholder="What are you studying?" maxLength={160} aria-label="Group description" />
                  <button className="ui-button ui-button--primary" disabled={socialBusy || groupName.trim().length < 2}>Create group</button>
                </form>
                <form className="profile__form" onSubmit={joinGroup}>
                  <span className="ui-card__eyebrow">Join</span>
                  <p className="ui-card__title">Join with a code</p>
                  <input className="ui-input" value={groupCode} onChange={(event) => setGroupCode(event.target.value.toUpperCase())} placeholder="8-character code" maxLength={10} aria-label="Study group invite code" />
                  <button className="ui-button" disabled={socialBusy || groupCode.trim().length < 6}>Join group</button>
                </form>
              </div>
            ) : null}

            {groups.length ? (
              <div className="ui-panel profile__group ui-tone--teal">
                {groups.length > 1 ? (
                  <div className="ui-tabs profile__group-tabs" role="tablist" aria-label="Your study groups">
                    {groups.map((group) => (
                      <button key={group.id} type="button" role="tab" className="ui-tab" aria-selected={activeGroup?.id === group.id} onClick={() => setActiveGroupId(group.id)}>
                        {group.name}<span className="ui-count">{group.members.length}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {activeGroup ? (
                  <div className="profile__group-body">
                    <div className="profile__group-top">
                      <div className="profile__group-heading">
                        <span className="ui-card__eyebrow ui-tone--teal"><UsersMark /> {activeGroup.members.length} {activeGroup.members.length === 1 ? 'member' : 'members'}</span>
                        <h3 className="ui-card__title">{activeGroup.name}</h3>
                        <p className="ui-card__copy">{activeGroup.description || 'A private place to keep each other moving.'}</p>
                      </div>
                      <button type="button" className="profile__invite" onClick={() => void copyGroupCode(activeGroup.invite_code)} aria-label={`Copy invite code ${activeGroup.invite_code}`}>
                        <span>Invite code</span>
                        <strong>{activeGroup.invite_code}</strong>
                      </button>
                    </div>
                    <div className="profile__goal">
                      <div className="profile__goal-line">
                        <span>Weekly group goal</span>
                        <strong>{activeGroup.weekly_xp} / {activeGroup.weekly_goal_xp} XP</strong>
                      </div>
                      <div className="ui-meter" role="progressbar" aria-label={`${activeGroup.name} weekly XP`} aria-valuemin={0} aria-valuemax={activeGroup.weekly_goal_xp} aria-valuenow={Math.min(activeGroup.weekly_xp, activeGroup.weekly_goal_xp)}>
                        <span style={{ width: `${Math.min(100, activeGroup.weekly_xp / activeGroup.weekly_goal_xp * 100)}%` }} />
                      </div>
                    </div>
                    <div className="profile__group-columns">
                      <div>
                        <p className="profile__label">Members</p>
                        <ol className="ui-list profile__compact">
                          {activeGroup.members.map((member, index) => (
                            <li key={member.student_id} className="ui-row">
                              <span className="profile__rank">{index + 1}</span>
                              <span className={`ui-avatar ${toneClass(toneForName(member.display_name))}`} aria-hidden="true">{member.display_name.slice(0, 1).toUpperCase()}</span>
                              <div className="ui-row__main">
                                <span className="ui-row__title">{member.student_id === studentId ? 'You' : member.display_name}</span>
                                <span className="ui-row__meta">{member.role === 'owner' ? 'Group owner' : `@${member.username}`}</span>
                              </div>
                              <span className="ui-row__aside">{member.weekly_xp} XP</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <p className="profile__label">Recent momentum</p>
                        {activeGroup.activity.length ? (
                          <ul className="ui-list profile__compact">
                            {activeGroup.activity.slice(0, 5).map((item) => (
                              <li key={item.id} className="ui-row">
                                <div className="ui-row__main">
                                  <span className="ui-row__title">{item.display_name}</span>
                                  <span className="ui-row__meta">{new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                                </div>
                                <span className="ui-badge ui-badge--positive">+{item.xp} XP</span>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="profile__empty">Complete a lesson to start the feed.</p>}
                      </div>
                    </div>
                    {activeGroup.role !== 'owner' ? (
                      <div className="profile__group-footer">
                        <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => void exitGroup(activeGroup)}>Leave group</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <button type="button" className="ui-card profile__group-empty ui-tone--teal" onClick={() => setShowGroupSetup(true)} disabled={!session}>
                <span className="ui-icon"><UsersMark /></span>
                <span className="ui-card__title">Create your first study group</span>
                <span className="ui-card__copy">Invite friends, combine XP, and build momentum together.</span>
              </button>
            )}
          </section>

          <section className="ui-section" aria-labelledby="league-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="league-title">Weekly league</h2>
              <span className="ui-count">Resets Monday</span>
            </div>
            <div className="ui-panel">
              {!social?.leaderboard.length ? <p className="profile__empty">Add a friend to start your weekly competition.</p> : (
                <ol className="ui-list">
                  {social.leaderboard.map((friend, index) => (
                    <li key={friend.student_id} className={`ui-row${friend.student_id === studentId ? ' profile__me' : ''}`}>
                      <span className="profile__rank">{index + 1}</span>
                      <span className={`ui-avatar ${toneClass(toneForName(friend.display_name))}`} aria-hidden="true">{friend.display_name.slice(0, 1).toUpperCase()}</span>
                      <div className="ui-row__main">
                        <span className="ui-row__title">{friend.student_id === studentId ? 'You' : friend.display_name}</span>
                        <span className="ui-row__meta">{friend.active_today ? 'Active today' : `${friend.streak} day study streak`}</span>
                      </div>
                      <span className="ui-row__aside">{friend.weekly_xp} XP</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="activity-title">
            <div className="ui-section-head"><h2 className="ui-section-title" id="activity-title">Friend activity</h2></div>
            <div className="ui-panel">
              {social?.activity.length ? (
                <ul className="ui-list">
                  {social.activity.slice(0, 6).map((event) => (
                    <li key={event.id} className="ui-row">
                      <span className={`ui-avatar ${toneClass(toneForName(event.display_name))}`} aria-hidden="true">{event.display_name.slice(0, 1).toUpperCase()}</span>
                      <div className="ui-row__main">
                        <span className="ui-row__title">{event.student_id === studentId ? 'You' : event.display_name} earned {event.xp} XP</span>
                        <span className="ui-row__meta">{new Date(event.created_at).toLocaleDateString()}</span>
                      </div>
                      {event.student_id !== studentId ? (
                        <button
                          type="button"
                          className={`ui-button ui-button--sm${event.reacted ? ' ui-button--primary' : ''}`}
                          aria-pressed={event.reacted}
                          onClick={() => void celebrate(event.id)}
                          aria-label="Celebrate this activity"
                        >
                          High five{event.reaction_count ? ` · ${event.reaction_count}` : ''}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : <p className="profile__empty">Study activity from you and your friends will appear here.</p>}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="record-title">
            <div className="ui-section-head"><h2 className="ui-section-title" id="record-title">Record</h2></div>
            <div className="ui-panel">
              {unitStats.length === 0 ? (
                <p className="profile__empty">Take a quiz in Tools to track unit accuracy here.</p>
              ) : (
                <ul className="ui-list">
                  {unitStats.map((unit) => (
                    <li key={unit.topic} className="profile__record">
                      <div className="profile__goal-line">
                        <strong>{formatTopic(unit.topic)}</strong>
                        <span>{unit.accuracy}%</span>
                      </div>
                      <div className="ui-meter" role="progressbar" aria-label={`${formatTopic(unit.topic)} accuracy`} aria-valuenow={unit.accuracy} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: `${unit.accuracy}%` }} />
                      </div>
                      <span className="ui-row__meta">{unit.correct_answers} of {unit.attempts} correct</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <aside className="profile__side">
          <section className="ui-section" aria-labelledby="friends-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="friends-title">Friends</h2>
              <span className="ui-count">{social?.friends.length ?? 0}</span>
            </div>
            <div className="ui-panel profile__friends">
              {profile?.friend_code ? (
                <div className="profile__friend-id">
                  <div>
                    <span className="ui-card__eyebrow">Your friend ID</span>
                    <strong className="profile__code profile__code--lg">{profile.friend_code}</strong>
                  </div>
                  <button className="ui-button ui-button--primary ui-button--sm" type="button" onClick={() => void shareFriendId()}>Share ID</button>
                </div>
              ) : null}
              {session ? (
                <div className="profile__friend-forms">
                  <form className="profile__inline-form" onSubmit={findPeople}>
                    <input className="ui-input" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} placeholder="Search name or username" maxLength={40} aria-label="Search people" />
                    <button className="ui-button ui-button--sm" disabled={socialBusy || peopleQuery.trim().length < 2}>Search</button>
                  </form>
                  <form className="profile__inline-form" onSubmit={addFriend}>
                    <input className="ui-input" value={friendCode} onChange={(event) => setFriendCode(event.target.value.toUpperCase())} placeholder="Or enter a friend ID" maxLength={12} aria-label="Friend ID" />
                    <button className="ui-button ui-button--sm" disabled={socialBusy || !friendCode.trim()}>Add</button>
                  </form>
                </div>
              ) : null}

              {(peopleResults.length ? peopleResults : social?.suggestions ?? []).length ? (
                <div className="profile__group-list">
                  <p className="profile__label">{peopleResults.length ? 'Search results' : 'Suggested'}</p>
                  <ul className="ui-list">
                    {(peopleResults.length ? peopleResults : social?.suggestions ?? []).slice(0, 4).map((person) => (
                      <li className="ui-row" key={person.student_id}>
                        <span className={`ui-avatar ${toneClass(toneForName(person.display_name))}`} aria-hidden="true">{person.display_name.slice(0, 1).toUpperCase()}</span>
                        <div className="ui-row__main">
                          <span className="ui-row__title">{person.display_name}</span>
                          <span className="ui-row__meta">@{person.username}</span>
                        </div>
                        <button className="ui-button ui-button--sm" type="button" onClick={() => void addSuggested(person)} disabled={socialBusy}>Add</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {social?.requests.length ? (
                <div className="profile__group-list">
                  <p className="profile__label">Requests</p>
                  <ul className="ui-list">
                    {social.requests.map((request) => (
                      <li className="ui-row" key={request.request_id}>
                        <span className={`ui-avatar ${toneClass(toneForName(request.display_name))}`} aria-hidden="true">{request.display_name.slice(0, 1).toUpperCase()}</span>
                        <div className="ui-row__main">
                          <span className="ui-row__title">{request.display_name}</span>
                          <span className="ui-row__meta">@{request.username}</span>
                        </div>
                        <button className="ui-button ui-button--primary ui-button--sm" type="button" onClick={() => void answerRequest(request.request_id, true)} disabled={socialBusy}>Accept</button>
                        <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void answerRequest(request.request_id, false)} disabled={socialBusy} aria-label={`Decline ${request.display_name}`}>Decline</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {social?.friends.length ? (
                <div className="profile__group-list">
                  <p className="profile__label">Your friends</p>
                  <ul className="ui-list">
                    {social.friends.map((friend) => (
                      <li className="ui-row profile__friend" key={friend.student_id}>
                        <span className={`ui-avatar ${toneClass(toneForName(friend.display_name))}`} aria-hidden="true">{friend.display_name.slice(0, 1).toUpperCase()}</span>
                        <div className="ui-row__main">
                          <span className="ui-row__title">{friend.display_name}</span>
                          <span className="ui-row__meta">{friend.friend_streak} day friend streak · {friend.weekly_xp} XP this week</span>
                        </div>
                        <button className="ui-button ui-button--sm" type="button" onClick={() => void beginQuest(friend.student_id)} disabled={socialBusy}>Quest</button>
                        <details className="profile__menu">
                          <summary aria-label={`Options for ${friend.display_name}`}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                          </summary>
                          <div className="ui-menu profile__menu-list">
                            <button className="ui-menu__item" type="button" onClick={() => void unfriend(friend.student_id)}>Remove</button>
                            <button className="ui-menu__item" type="button" onClick={() => void reportFriend(friend.student_id)}>Report</button>
                            <button className="ui-menu__item ui-menu__item--danger" type="button" onClick={() => void blockFriend(friend.student_id)}>Block</button>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {session && social && !social.friends.length && !social.requests.length ? (
                <div className="ui-empty profile__friends-empty">
                  <img className="ui-empty__mascot" src="/bindit-mascot.webp" alt="" />
                  <p className="ui-empty__title">No friends yet</p>
                  <p className="ui-empty__copy">Search for classmates above or share your friend ID to start a weekly league.</p>
                </div>
              ) : null}
              <p className="profile__hint">
                {!session || !profile?.friend_code ? 'Log in to get a friend ID you can share.' : 'Use Share ID to send it with your phone’s share menu.'}
              </p>
            </div>
          </section>

          <section className="ui-section" aria-labelledby="quests-title">
            <div className="ui-section-head"><h2 className="ui-section-title" id="quests-title">Friend quests</h2></div>
            <div className="ui-panel ui-panel--padded profile__stack">
              {social?.quests.map((quest) => (
                <div className="profile__quest" key={quest.id}>
                  <div className="profile__goal-line">
                    <strong>You + {quest.friend_name}</strong>
                    <span>{quest.progress_xp} / {quest.target_xp} XP</span>
                  </div>
                  <div className="ui-meter" role="progressbar" aria-label={`Quest with ${quest.friend_name}`} aria-valuemin={0} aria-valuemax={quest.target_xp} aria-valuenow={Math.min(quest.progress_xp, quest.target_xp)}>
                    <span style={{ width: `${Math.min(100, quest.progress_xp / quest.target_xp * 100)}%` }} />
                  </div>
                </div>
              ))}
              {!social?.quests.length && social?.friends.length ? (
                <button className="ui-button ui-button--primary" disabled={socialBusy} onClick={() => void beginQuest(social.friends[0].student_id)}>Start a 100 XP quest with {social.friends[0].display_name}</button>
              ) : null}
              {!social?.friends.length ? <p className="profile__empty profile__empty--flush">Friend quests unlock after you add a friend.</p> : null}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="notifications-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="notifications-title">Notifications</h2>
              {social?.notifications.some((item) => !item.is_read) ? <button className="ui-link" type="button" onClick={() => void markNotificationsRead()}>Mark read</button> : null}
            </div>
            <div className="ui-panel">
              {social?.notifications.length ? (
                <ul className="ui-list">
                  {social.notifications.slice(0, 5).map((item) => (
                    <li key={item.id} className={`profile__notification${item.is_read ? '' : ' is-unread'}`}>{item.message}</li>
                  ))}
                </ul>
              ) : <p className="profile__empty">You’re all caught up.</p>}
            </div>
          </section>

          {profile ? (
            <section className="ui-section" aria-labelledby="privacy-title">
              <div className="ui-section-head"><h2 className="ui-section-title" id="privacy-title">Social privacy</h2></div>
              <div className="ui-panel">
                <label className="ui-row profile__toggle">
                  <div className="ui-row__main">
                    <span className="ui-row__title">Appear in search</span>
                    <span className="ui-row__meta">Let learners find your profile.</span>
                  </div>
                  <input className="ui-checkbox" type="checkbox" checked={profile.discoverable} onChange={() => void togglePrivacy('discoverable')} />
                </label>
                <label className="ui-row profile__toggle">
                  <div className="ui-row__main">
                    <span className="ui-row__title">Friend requests</span>
                    <span className="ui-row__meta">Allow new people to add you.</span>
                  </div>
                  <input className="ui-checkbox" type="checkbox" checked={profile.allow_friend_requests} onChange={() => void togglePrivacy('allow_friend_requests')} />
                </label>
              </div>
            </section>
          ) : null}

          <section className="ui-section" aria-labelledby="studying-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="studying-title">Currently studying</h2>
              {courses.length ? <a className="ui-link" href="#tools">Open Tools</a> : null}
            </div>
            <div className="ui-panel ui-panel--padded">
              {courses.length === 0 ? (
                <p className="profile__empty profile__empty--flush">Add courses in Tools to see them here.</p>
              ) : (
                <div className="profile__courses">
                  {courses.map((course) => (
                    <span
                      key={course.name}
                      className={`ui-badge ui-badge--course profile__course${course.name === activeCourse ? ' is-active' : ''}`}
                      style={{ ['--course' as string]: course.tone ?? '#0b58f5' }}
                    >
                      <span className="ui-course-mark profile__course-mark" aria-hidden="true">{courseInitial(course.name)}</span>
                      {course.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

function GearMark() {
  return (
    <svg className="profile__button-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function UsersMark() {
  return (
    <svg className="profile__inline-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </svg>
  )
}
