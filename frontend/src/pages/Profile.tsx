import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import type { FriendsHub, PersonSuggestion, Profile as ProfileData, Progress as ProgressData, StudyGroup } from '../lib/api'
import { useData } from '../lib/dataSource'
import type { AuthSession } from '../lib/auth'
import type { Course } from '../lib/types'
import { AvatarControl } from '../lib/AvatarControl'
import { withCourseTones } from '../lib/session'
import { courseInitial, toneClass, toneForName } from '../lib/tones'
import './Profile.css'

/*
 * Friends & groups: who you study with. Identity and totals on top, study groups
 * and the weekly league in the main column, people, quests, notifications and
 * privacy to the side. Cached social data renders first and refreshes behind it.
 */

const XP_PER_LEVEL = 100
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function xpLevel(totalXp: number) {
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1
  const inLevel = totalXp % XP_PER_LEVEL
  return { level, inLevel, toNext: XP_PER_LEVEL - inLevel }
}

function formatTopic(topic: string) {
  return topic.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.slice(0, 1) ?? '?').toUpperCase()
}

function percent(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
}

// Closes the ⋯ menu a button lives in once its action is chosen.
function closeMenu(event: MouseEvent<HTMLElement>) {
  event.currentTarget.closest('details')?.removeAttribute('open')
}

type Notice = { text: string; error?: boolean }

type ProfileProps = {
  session: AuthSession | null
  onError?: (message: string) => void
}

export function Profile({ session, onError }: ProfileProps) {
  const data = useData()
  const token = session?.access_token
  const studentId = session?.user.id ?? data.getStudentId()
  const [profile, setProfile] = useState<ProfileData | null>(() => token ? data.getCachedProfile(token) : null)
  const [stats, setStats] = useState<ProgressData | null>(() => data.getCachedProgress(studentId))
  const [courses, setCourses] = useState<Course[]>(() => withCourseTones(data.loadNotebook().courses))
  const [activeCourse, setActiveCourse] = useState(() => data.loadNotebook().activeCourse)
  const [social, setSocial] = useState<FriendsHub | null>(() => token ? data.getCachedFriends(token) : null)
  const [groups, setGroups] = useState<StudyGroup[] | null>(() => token ? data.getCachedStudyGroups(token) : null)
  const [socialFailed, setSocialFailed] = useState(false)
  const [seenToken, setSeenToken] = useState(token)
  const [activeGroupId, setActiveGroupId] = useState('')
  const [showGroupSetup, setShowGroupSetup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [groupCode, setGroupCode] = useState('')
  const [friendCode, setFriendCode] = useState('')
  const [socialBusy, setSocialBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [peopleQuery, setPeopleQuery] = useState('')
  const [peopleResults, setPeopleResults] = useState<PersonSuggestion[]>([])
  const [searched, setSearched] = useState('')

  // A different account (or signing out) swaps to that account's cached data during render.
  if (seenToken !== token) {
    setSeenToken(token)
    setProfile(token ? data.getCachedProfile(token) : null)
    setSocial(token ? data.getCachedFriends(token) : null)
    setGroups(token ? data.getCachedStudyGroups(token) : null)
    setSocialFailed(false)
  }

  const say = useCallback((text: string, error = false) => setNotice({ text, error }), [])

  useEffect(() => {
    if (!notice || notice.error) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    void data.getProgress(studentId, session?.access_token, true)
      .then(setStats)
      .catch(() => setStats(null))
  }, [data, studentId, session?.access_token])

  useEffect(() => {
    if (!session) return
    void data.getAccountProfile(session.access_token, true)
      .then(setProfile)
      .catch(() => onError?.('Could not load your profile.'))
  }, [data, session, onError])

  const fetchSocial = useCallback((force: boolean) => {
    if (!session) return Promise.resolve(null)
    return Promise.allSettled([
      data.getFriends(session.access_token, force),
      data.getStudyGroups(session.access_token, force),
    ])
  }, [data, session])

  const applySocial = useCallback((results: Awaited<ReturnType<typeof fetchSocial>>) => {
    if (!results) return
    const [friendsResult, groupsResult] = results
    if (friendsResult.status === 'fulfilled') {
      setSocial(friendsResult.value)
      setSocialFailed(false)
    } else {
      setSocialFailed(true)
      onError?.('Could not load friends right now.')
    }
    if (groupsResult.status === 'fulfilled') {
      setGroups(groupsResult.value)
      setActiveGroupId((current) => current || groupsResult.value[0]?.id || '')
    } else {
      setGroups((current) => current ?? [])
    }
  }, [onError])

  const refreshSocial = useCallback(async (force = true) => {
    applySocial(await fetchSocial(force))
  }, [fetchSocial, applySocial])

  useEffect(() => {
    let active = true
    void fetchSocial(true).then((results) => { if (active) applySocial(results) })
    return () => { active = false }
  }, [fetchSocial, applySocial])

  useEffect(() => {
    const syncNotebook = () => {
      const notebook = data.loadNotebook()
      setCourses(withCourseTones(notebook.courses))
      setActiveCourse(notebook.activeCourse)
    }
    syncNotebook()
    window.addEventListener('storage', syncNotebook)
    window.addEventListener('hashchange', syncNotebook)
    return () => {
      window.removeEventListener('storage', syncNotebook)
      window.removeEventListener('hashchange', syncNotebook)
    }
  }, [data])

  async function addFriend(event: FormEvent) {
    event.preventDefault()
    if (!session || !friendCode.trim()) return
    setSocialBusy(true)
    setNotice(null)
    try {
      await data.sendFriendRequest(friendCode.trim(), session.access_token)
      setFriendCode('')
      say('Friend request sent.')
      await refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not send that request.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function findPeople(event: FormEvent) {
    event.preventDefault()
    if (!session || peopleQuery.trim().length < 2) return
    setSocialBusy(true)
    try {
      setPeopleResults(await data.searchFriends(peopleQuery, session.access_token))
      setSearched(peopleQuery.trim())
    } catch {
      say('Search is not working right now. Try again in a moment.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function addSuggested(person: PersonSuggestion) {
    if (!session) return
    setSocialBusy(true)
    try {
      await data.sendFriendRequest(person.friend_code, session.access_token)
      setPeopleResults((current) => current.filter((item) => item.student_id !== person.student_id))
      say(`Friend request sent to ${person.display_name}.`)
      await refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : `Could not send a request to ${person.display_name}.`, true)
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
        say('Friend ID copied. Paste it into Messages, Instagram, or any app.')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      say('Could not open sharing. You can copy the ID from the top of this page.', true)
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
      await data.reactToActivity(eventId, session.access_token)
    } catch {
      await refreshSocial()
    }
  }

  async function markNotificationsRead() {
    if (!session) return
    try {
      await data.readSocialNotifications(session.access_token)
      setSocial((current) => current ? { ...current, notifications: current.notifications.map((item) => ({ ...item, is_read: true })) } : current)
      void refreshSocial()
    } catch {
      say('Could not mark notifications as read.', true)
    }
  }

  // Optimistic: the switch moves at once and moves back if saving fails.
  async function togglePrivacy(field: 'discoverable' | 'allow_friend_requests') {
    if (!session || !profile) return
    const previous = profile
    const discoverable = field === 'discoverable' ? !profile.discoverable : profile.discoverable
    const requests = field === 'allow_friend_requests' ? !profile.allow_friend_requests : profile.allow_friend_requests
    setProfile({ ...profile, discoverable, allow_friend_requests: requests })
    try {
      await data.saveSocialPrivacy(discoverable, requests, session.access_token)
    } catch {
      setProfile(previous)
      say('Could not save that privacy setting. It has been put back.', true)
    }
  }

  async function blockFriend(friendId: string) {
    if (!session || !data.confirm('Block this person? They will be removed and unable to find or contact you.')) return
    try {
      await data.blockSocialUser(friendId, session.access_token)
      say('Person blocked.')
      await refreshSocial()
    } catch {
      say('Could not block that person. Try again.', true)
    }
  }

  async function reportFriend(friendId: string) {
    if (!session || !data.confirm('Send a safety report about this person?')) return
    try {
      await data.reportSocialUser(friendId, session.access_token)
      say('Report sent. Thank you for helping keep bindit safe.')
    } catch {
      say('Could not send that report. Try again.', true)
    }
  }

  async function answerRequest(requestId: number, accept: boolean) {
    if (!session) return
    setSocialBusy(true)
    try {
      await data.answerFriendRequest(requestId, accept, session.access_token)
      say(accept ? 'You are friends now.' : 'Request declined.')
      await refreshSocial()
    } catch {
      say('Could not answer that request. Try again.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function beginQuest(friendId: string) {
    if (!session) return
    setSocialBusy(true)
    try {
      await data.startFriendQuest(friendId, session.access_token)
      say('Friend quest started. Earn 100 XP together this week.')
      await refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not start that quest.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function unfriend(friendId: string) {
    if (!session || !data.confirm('Remove this friend?')) return
    setSocialBusy(true)
    try {
      await data.removeFriend(friendId, session.access_token)
      say('Friend removed.')
      await refreshSocial()
    } catch {
      say('Could not remove that friend. Try again.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function makeGroup(event: FormEvent) {
    event.preventDefault()
    if (!session || groupName.trim().length < 2) return
    setSocialBusy(true)
    setNotice(null)
    try {
      const group = await data.createStudyGroup({ name: groupName.trim(), description: groupDescription.trim(), weekly_goal_xp: 500 }, session.access_token)
      setGroups((current) => [group, ...(current ?? [])])
      setActiveGroupId(group.id)
      setGroupName('')
      setGroupDescription('')
      setShowGroupSetup(false)
      say(`${group.name} is ready. Share code ${group.invite_code} with your friends.`)
      void refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not create that group.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function joinGroup(event: FormEvent) {
    event.preventDefault()
    if (!session || groupCode.trim().length < 6) return
    setSocialBusy(true)
    setNotice(null)
    try {
      const group = await data.joinStudyGroup(groupCode.trim(), session.access_token)
      setGroups((current) => [group, ...(current ?? []).filter((item) => item.id !== group.id)])
      setActiveGroupId(group.id)
      setGroupCode('')
      setShowGroupSetup(false)
      say(`Joined ${group.name}.`)
      void refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not join that group.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function copyGroupCode(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      say('Group invite code copied.')
    } catch {
      say(`Could not copy automatically. The code is ${code}.`, true)
    }
  }

  async function exitGroup(group: StudyGroup) {
    if (!session || group.role === 'owner' || !data.confirm(`Leave ${group.name}?`)) return
    try {
      await data.leaveStudyGroup(group.id, session.access_token)
      setGroups((current) => (current ?? []).filter((item) => item.id !== group.id))
      setActiveGroupId('')
      say(`Left ${group.name}.`)
    } catch {
      say(`Could not leave ${group.name}. Try again.`, true)
    }
  }

  function retrySocial() {
    setSocialFailed(false)
    void refreshSocial(true)
  }

  const totalXp = profile?.total_xp ?? stats?.total_xp ?? 0
  const { level, inLevel, toNext } = xpLevel(totalXp)
  const loginStreak = profile?.login_streak ?? stats?.login_streak ?? 0
  const unitStats = stats?.topics ?? []
  const username = profile?.username ?? 'Learner'
  const displayName = profile?.display_name ?? username
  const tag = profile?.friend_code ?? '—'
  const groupList = groups ?? []
  const activeGroup = groupList.find((group) => group.id === activeGroupId) ?? groupList[0] ?? null
  const socialLoading = Boolean(session) && !social && !socialFailed
  const groupsLoading = Boolean(session) && groups === null && !socialFailed
  const people = peopleResults.length ? peopleResults : social?.suggestions ?? []
  const unread = social?.notifications.filter((item) => !item.is_read).length ?? 0
  const failedAlert = socialFailed && !social ? (
    <div className="ui-alert" role="alert">
      <span>Friends and groups could not be loaded.</span>
      <button type="button" className="ui-button ui-button--sm" onClick={retrySocial}>Try again</button>
    </div>
  ) : null

  return (
    <div className="ui-page profile">
      <header className="ui-page-header profile__header">
        <div className="profile__identity">
          <AvatarControl name={displayName} onError={onError} />
          <div className="profile__identity-text">
            <span className="ui-eyebrow">Friends &amp; groups</span>
            <h1 className="ui-page-title profile__name">{displayName}</h1>
            <p className="profile__handle">
              {profile ? <span>@{profile.username}</span> : null}
              <span>Friend ID <span className="profile__code">{tag}</span></span>
            </p>
          </div>
        </div>
        <div className="profile__header-actions">
          {profile?.friend_code ? (
            <button className="ui-button ui-button--primary" type="button" onClick={() => void shareFriendId()}>
              <ShareMark />
              Share friend ID
            </button>
          ) : null}
          <a className="ui-button" href="#settings">
            <GearMark />
            Settings
          </a>
        </div>
      </header>

      <section className="ui-panel ui-stats profile__stats" aria-label="Your stats">
        <div className="ui-stat">
          <span className="ui-stat__label">Level</span>
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
        <div className="ui-stat">
          <span className="ui-stat__label">Total XP</span>
          <span className="ui-stat__value">{totalXp.toLocaleString()}</span>
          <span className="ui-stat__meta">{toNext} XP to level {level + 1}</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat__label">Login streak</span>
          <span className="ui-stat__value profile__streak">
            {loginStreak}<span className="ui-stat__unit">{loginStreak === 1 ? 'day' : 'days'}</span>
            {loginStreak >= 7 ? <img className="ui-mascot-cheer profile__streak-mascot" src="/bindit-mascot-cutout.webp" alt="" width="28" height="34" title={`${loginStreak}-day streak`} /> : null}
          </span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat__label">Friends</span>
          <span className="ui-stat__value">{social ? social.friends.length : socialLoading ? <span className="ui-skeleton profile__stat-skeleton" /> : 0}</span>
          {social?.requests.length ? <span className="ui-stat__meta">{social.requests.length} pending {social.requests.length === 1 ? 'request' : 'requests'}</span> : null}
        </div>
      </section>

      {failedAlert}

      <div className="profile__grid">
        <div className="profile__main">
          <section className="ui-section" aria-labelledby="study-groups-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="study-groups-title">
                Study groups {groupList.length ? <span className="ui-count">{groupList.length}</span> : null}
              </h2>
              {session ? (
                <button className="ui-button ui-button--sm" type="button" aria-expanded={showGroupSetup} aria-controls="group-setup" onClick={() => setShowGroupSetup((current) => !current)}>
                  {showGroupSetup ? 'Close' : 'New or join'}
                </button>
              ) : null}
            </div>

            {showGroupSetup ? (
              <div className="ui-panel profile__group-setup" id="group-setup">
                <form className="profile__form" onSubmit={makeGroup}>
                  <h3 className="profile__form-title">Start a group</h3>
                  <label className="ui-field">
                    <span>Group name</span>
                    <input className="ui-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="AP Bio study circle" maxLength={48} />
                  </label>
                  <label className="ui-field">
                    <span>What are you studying? <span className="profile__optional">Optional</span></span>
                    <input className="ui-input" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} placeholder="Weekly review before unit tests" maxLength={160} />
                  </label>
                  <button className="ui-button" disabled={socialBusy || groupName.trim().length < 2}>Create group</button>
                </form>
                <form className="profile__form" onSubmit={joinGroup}>
                  <h3 className="profile__form-title">Join with a code</h3>
                  <label className="ui-field">
                    <span>Invite code</span>
                    <input className="ui-input profile__code-input" value={groupCode} onChange={(event) => setGroupCode(event.target.value.toUpperCase())} placeholder="8-character code" maxLength={10} aria-label="Study group invite code" />
                  </label>
                  <p className="profile__form-help">Ask a group owner for the code on their group page.</p>
                  <button className="ui-button" disabled={socialBusy || groupCode.trim().length < 6}>Join group</button>
                </form>
              </div>
            ) : null}

            {groupsLoading && !groupList.length ? (
              <div className="ui-panel profile__group-body" aria-busy="true" aria-label="Loading study groups">
                <span className="ui-skeleton profile__skeleton-title" />
                <span className="ui-skeleton profile__skeleton-line" />
                <span className="ui-skeleton profile__skeleton-meter" />
                <SkeletonRows rows={2} />
              </div>
            ) : groupList.length && activeGroup ? (
              <div className="ui-panel profile__groups">
                {groupList.length > 1 ? (
                  <div className="ui-tabs profile__group-tabs" role="tablist" aria-label="Your study groups">
                    {groupList.map((group) => (
                      <button
                        key={group.id}
                        type="button"
                        role="tab"
                        id={`group-tab-${group.id}`}
                        className="ui-tab"
                        aria-selected={activeGroup.id === group.id}
                        aria-controls="group-panel"
                        onClick={() => setActiveGroupId(group.id)}
                      >
                        {group.name}<span className="ui-count">{group.members.length}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div
                  className="profile__group-body"
                  id="group-panel"
                  role={groupList.length > 1 ? 'tabpanel' : undefined}
                  aria-labelledby={groupList.length > 1 ? `group-tab-${activeGroup.id}` : undefined}
                >
                  <div className="profile__group-top">
                    <div className="profile__group-heading">
                      <h3 className="profile__group-name">{activeGroup.name}</h3>
                      <p className="profile__group-copy">{activeGroup.description || 'A private place to keep each other moving.'}</p>
                      <p className="profile__group-meta">
                        {activeGroup.members.length} {activeGroup.members.length === 1 ? 'member' : 'members'} · {activeGroup.role === 'owner' ? 'You own this group' : 'You are a member'}
                      </p>
                    </div>
                    <button type="button" className="profile__invite" onClick={() => void copyGroupCode(activeGroup.invite_code)} aria-label={`Copy invite code ${activeGroup.invite_code}`}>
                      <span>Invite code</span>
                      <strong>{activeGroup.invite_code}</strong>
                      <small><CopyMark /> Copy</small>
                    </button>
                  </div>

                  <div className="profile__goal">
                    <div className="profile__goal-line">
                      <span>Weekly group goal</span>
                      <span><strong>{activeGroup.weekly_xp.toLocaleString()}</strong> of {activeGroup.weekly_goal_xp.toLocaleString()} XP · {percent(activeGroup.weekly_xp, activeGroup.weekly_goal_xp)}%</span>
                    </div>
                    <div className="ui-meter" role="progressbar" aria-label={`${activeGroup.name} weekly XP`} aria-valuemin={0} aria-valuemax={activeGroup.weekly_goal_xp} aria-valuenow={Math.min(activeGroup.weekly_xp, activeGroup.weekly_goal_xp)}>
                      <span style={{ width: `${percent(activeGroup.weekly_xp, activeGroup.weekly_goal_xp)}%` }} />
                    </div>
                  </div>

                  <div className="profile__group-columns">
                    <div>
                      <h4 className="profile__label">Members this week</h4>
                      <ol className="ui-list profile__compact">
                        {activeGroup.members.map((member, index) => (
                          <PersonRow
                            key={member.student_id}
                            name={member.display_name}
                            label={member.student_id === studentId ? 'You' : member.display_name}
                            meta={`@${member.username}`}
                            rank={index + 1}
                            me={member.student_id === studentId}
                          >
                            {member.role === 'owner' ? <span className="ui-badge">Owner</span> : null}
                            <span className="ui-row__aside">{member.weekly_xp} XP</span>
                          </PersonRow>
                        ))}
                      </ol>
                    </div>
                    <div>
                      <h4 className="profile__label">Recent momentum</h4>
                      {activeGroup.activity.length ? (
                        <ul className="ui-list profile__compact">
                          {activeGroup.activity.slice(0, 5).map((item) => (
                            <PersonRow
                              key={item.id}
                              name={item.display_name}
                              label={item.student_id === studentId ? 'You' : item.display_name}
                              meta={shortDate.format(new Date(item.created_at))}
                            >
                              <span className="ui-row__aside profile__xp-gain">+{item.xp} XP</span>
                            </PersonRow>
                          ))}
                        </ul>
                      ) : <p className="profile__empty profile__empty--boxed">Nothing yet this week. Finish a quiz to start the feed.</p>}
                    </div>
                  </div>

                  {activeGroup.role !== 'owner' ? (
                    <div className="profile__group-footer">
                      <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => void exitGroup(activeGroup)}>Leave group</button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : !showGroupSetup && !(socialFailed && !social) ? (
              <div className="profile__placeholder">
                <span className="ui-icon"><UsersMark /></span>
                <div>
                  <p className="profile__placeholder-title">No study groups yet</p>
                  <p className="profile__placeholder-copy">
                    {session ? 'Start one or join with a code. Members pool XP toward a weekly goal.' : 'Log in to start or join a study group.'}
                  </p>
                </div>
                {session ? <button type="button" className="ui-button ui-button--sm" onClick={() => setShowGroupSetup(true)}>Start or join a group</button> : null}
              </div>
            ) : null}
          </section>

          <section className="ui-section" aria-labelledby="league-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="league-title">Weekly league</h2>
              <span className="ui-count">Resets Monday</span>
            </div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={3} /> : !social?.leaderboard.length ? (
                <p className="profile__empty">Add a friend to start your weekly competition.</p>
              ) : (
                <ol className="ui-list">
                  {social.leaderboard.map((friend, index) => (
                    <PersonRow
                      key={friend.student_id}
                      name={friend.display_name}
                      label={friend.student_id === studentId ? 'You' : friend.display_name}
                      meta={friend.active_today ? 'Active today' : `${friend.streak} day study streak`}
                      rank={index + 1}
                      me={friend.student_id === studentId}
                    >
                      <span className="ui-row__aside profile__league-xp">{friend.weekly_xp} XP</span>
                    </PersonRow>
                  ))}
                </ol>
              )}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="activity-title">
            <div className="ui-section-head"><h2 className="ui-section-title" id="activity-title">Friend activity</h2></div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={2} /> : social?.activity.length ? (
                <ul className="ui-list">
                  {social.activity.slice(0, 6).map((event) => (
                    <PersonRow
                      key={event.id}
                      name={event.display_name}
                      label={`${event.student_id === studentId ? 'You' : event.display_name} earned ${event.xp} XP`}
                      meta={new Date(event.created_at).toLocaleDateString()}
                    >
                      {event.student_id !== studentId ? (
                        <button
                          type="button"
                          className={`ui-button ui-button--sm profile__cheer${event.reacted ? ' is-on' : ''}`}
                          aria-pressed={event.reacted}
                          onClick={() => void celebrate(event.id)}
                        >
                          High five{event.reaction_count ? ` · ${event.reaction_count}` : ''}
                          <span className="sr-only"> for {event.display_name}</span>
                        </button>
                      ) : null}
                    </PersonRow>
                  ))}
                </ul>
              ) : <p className="profile__empty">Study activity from you and your friends will appear here.</p>}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="record-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="record-title">Record</h2>
              <a className="ui-link" href="#progress">Full progress</a>
            </div>
            <div className="ui-panel">
              {unitStats.length === 0 ? (
                <p className="profile__empty">Take a quiz in Tools to track unit accuracy here.</p>
              ) : (
                <ul className="ui-list">
                  {unitStats.map((unit) => (
                    <li key={unit.topic} className="profile__record">
                      <div className="profile__goal-line">
                        <span className="profile__record-name">{formatTopic(unit.topic)}</span>
                        <span><strong>{Math.round(unit.accuracy)}%</strong> · {unit.correct_answers} of {unit.attempts} correct</span>
                      </div>
                      <div className="ui-meter" role="progressbar" aria-label={`${formatTopic(unit.topic)} accuracy`} aria-valuenow={unit.accuracy} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: `${unit.accuracy}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <aside className="profile__side" aria-label="People">
          <section className="ui-section" aria-labelledby="friends-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="friends-title">Friends</h2>
              <span className="ui-count">{social?.friends.length ?? 0}</span>
            </div>
            <div className="ui-panel profile__friends">
              {social?.requests.length ? (
                <div className="profile__block profile__requests">
                  <h3 className="profile__label">
                    Requests <span className="ui-badge ui-badge--accent">{social.requests.length}</span>
                  </h3>
                  <ul className="ui-list">
                    {social.requests.map((request) => (
                      <PersonRow key={request.request_id} name={request.display_name} label={request.display_name} meta={`@${request.username} wants to be friends`}>
                        <span className="profile__row-actions">
                          <button className="ui-button ui-button--sm" type="button" onClick={() => void answerRequest(request.request_id, true)} disabled={socialBusy} aria-label={`Accept ${request.display_name}`}>Accept</button>
                          <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void answerRequest(request.request_id, false)} disabled={socialBusy} aria-label={`Decline ${request.display_name}`}>Decline</button>
                        </span>
                      </PersonRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {session ? (
                <div className="profile__friend-forms">
                  <form className="profile__inline-form" onSubmit={findPeople} role="search">
                    <input className="ui-input" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} placeholder="Search name or username" maxLength={40} aria-label="Search people" />
                    <button className="ui-button" disabled={socialBusy || peopleQuery.trim().length < 2}>Search</button>
                  </form>
                  <form className="profile__inline-form" onSubmit={addFriend}>
                    <input className="ui-input profile__code-input" value={friendCode} onChange={(event) => setFriendCode(event.target.value.toUpperCase())} placeholder="Or enter a friend ID" maxLength={12} aria-label="Friend ID" />
                    <button className="ui-button" disabled={socialBusy || !friendCode.trim()}>Add</button>
                  </form>
                </div>
              ) : null}

              {people.length ? (
                <div className="profile__block">
                  <h3 className="profile__label">{peopleResults.length ? `Results for “${searched}”` : 'Suggested for you'}</h3>
                  <ul className="ui-list">
                    {people.slice(0, 4).map((person) => (
                      <PersonRow key={person.student_id} name={person.display_name} label={person.display_name} meta={`@${person.username}`}>
                        <button className="ui-button ui-button--sm" type="button" onClick={() => void addSuggested(person)} disabled={socialBusy} aria-label={`Add ${person.display_name}`}>Add</button>
                      </PersonRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {socialLoading ? (
                <div className="profile__block"><SkeletonRows rows={3} /></div>
              ) : social?.friends.length ? (
                <div className="profile__block">
                  <h3 className="profile__label">Your friends</h3>
                  <ul className="ui-list">
                    {social.friends.map((friend) => (
                      <PersonRow
                        key={friend.student_id}
                        name={friend.display_name}
                        label={friend.display_name}
                        meta={`${friend.friend_streak} day friend streak · ${friend.weekly_xp} XP this week`}
                      >
                        <button className="ui-button ui-button--sm" type="button" onClick={() => void beginQuest(friend.student_id)} disabled={socialBusy} aria-label={`Start a quest with ${friend.display_name}`}>Quest</button>
                        <details className="profile__menu">
                          <summary aria-label={`Options for ${friend.display_name}`}>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                          </summary>
                          <div className="ui-menu profile__menu-list">
                            <button className="ui-menu__item" type="button" onClick={(event) => { closeMenu(event); void unfriend(friend.student_id) }}>Remove friend</button>
                            <button className="ui-menu__item" type="button" onClick={(event) => { closeMenu(event); void reportFriend(friend.student_id) }}>Report</button>
                            <button className="ui-menu__item ui-menu__item--danger" type="button" onClick={(event) => { closeMenu(event); void blockFriend(friend.student_id) }}>Block</button>
                          </div>
                        </details>
                      </PersonRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {session && social && !social.friends.length && !social.requests.length ? (
                <div className="ui-empty profile__friends-empty">
                  <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="104" height="125" />
                  <p className="ui-empty__title">No friends yet</p>
                  <p className="ui-empty__copy">Search for classmates above or share your friend ID to start a weekly league.</p>
                </div>
              ) : null}
              <p className="profile__hint">
                {!session || !profile?.friend_code ? 'Log in to get a friend ID you can share.' : 'Share friend ID sends it with your phone’s share menu.'}
              </p>
            </div>
          </section>

          <section className="ui-section" aria-labelledby="quests-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="quests-title">Friend quests</h2>
              <span className="ui-count">100 XP together in a week</span>
            </div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={1} /> : (
                <>
                  {social?.quests.length ? (
                    <ul className="ui-list">
                      {social.quests.map((quest) => (
                        <li className="profile__quest" key={quest.id}>
                          <div className="profile__goal-line">
                            <span className="profile__record-name">You + {quest.friend_name}</span>
                            <span><strong>{quest.progress_xp}</strong> of {quest.target_xp} XP</span>
                          </div>
                          <div className="ui-meter" role="progressbar" aria-label={`Quest with ${quest.friend_name}`} aria-valuemin={0} aria-valuemax={quest.target_xp} aria-valuenow={Math.min(quest.progress_xp, quest.target_xp)}>
                            <span style={{ width: `${percent(quest.progress_xp, quest.target_xp)}%` }} />
                          </div>
                          <span className="profile__quest-meta">
                            {quest.progress_xp >= quest.target_xp ? 'Complete' : `${quest.target_xp - quest.progress_xp} XP to go`} · ends {shortDate.format(new Date(quest.expires_at))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {!social?.quests.length && social?.friends.length ? (
                    <div className="profile__quest-start">
                      <p className="profile__empty profile__empty--flush">No quest running. Pair up with a friend and earn 100 XP together this week.</p>
                      <button className="ui-button ui-button--sm" type="button" disabled={socialBusy} onClick={() => void beginQuest(social.friends[0].student_id)}>Start a quest with {social.friends[0].display_name}</button>
                    </div>
                  ) : null}
                  {!social?.friends.length ? <p className="profile__empty">Friend quests unlock after you add a friend.</p> : null}
                </>
              )}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="notifications-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="notifications-title">
                Notifications {unread ? <span className="ui-badge ui-badge--accent">{unread} new</span> : null}
              </h2>
              {unread ? <button className="ui-link" type="button" onClick={() => void markNotificationsRead()}>Mark all read</button> : null}
            </div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={2} plain /> : social?.notifications.length ? (
                <ul className="ui-list">
                  {social.notifications.slice(0, 5).map((item) => (
                    <li key={item.id} className={`profile__notification${item.is_read ? '' : ' is-unread'}`}>
                      <span className="profile__notification-dot" aria-hidden="true" />
                      <span className="profile__notification-text">
                        {item.is_read ? null : <span className="sr-only">New: </span>}
                        {item.message}
                      </span>
                      <time dateTime={item.created_at}>{shortDate.format(new Date(item.created_at))}</time>
                    </li>
                  ))}
                </ul>
              ) : <p className="profile__empty">You’re all caught up.</p>}
            </div>
          </section>

          {profile ? (
            <section className="ui-section" aria-labelledby="privacy-title">
              <div className="ui-section-head"><h2 className="ui-section-title" id="privacy-title">Privacy and safety</h2></div>
              <div className="ui-panel">
                <label className="ui-row profile__toggle">
                  <span className="ui-row__main">
                    <span className="ui-row__title">Appear in search</span>
                    <span className="profile__toggle-meta">Let learners find your profile.</span>
                  </span>
                  <input className="ui-checkbox profile__switch" type="checkbox" role="switch" checked={profile.discoverable} onChange={() => void togglePrivacy('discoverable')} />
                </label>
                <label className="ui-row profile__toggle">
                  <span className="ui-row__main">
                    <span className="ui-row__title">Friend requests</span>
                    <span className="profile__toggle-meta">Allow new people to add you.</span>
                  </span>
                  <input className="ui-checkbox profile__switch" type="checkbox" role="switch" checked={profile.allow_friend_requests} onChange={() => void togglePrivacy('allow_friend_requests')} />
                </label>
                <p className="profile__hint">To block or report someone, open the ⋯ menu beside their name in Friends.</p>
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
                <ul className="profile__courses">
                  {courses.map((course) => (
                    <li
                      key={course.name}
                      className={`profile__course${course.name === activeCourse ? ' is-active' : ''}`}
                      style={{ '--course': course.tone ?? 'var(--color-brand)' } as CSSProperties}
                    >
                      <span className="ui-course-mark ui-course-mark--sm" aria-hidden="true">{courseInitial(course.name)}</span>
                      <span className="profile__course-name">{course.name}</span>
                      {course.name === activeCourse ? <span className="ui-badge">Active</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>

      {notice ? (
        <div className="app-toast" role={notice.error ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
    </div>
  )
}

function PersonRow({
  name,
  label,
  meta,
  rank,
  me,
  children,
}: {
  name: string
  label: string
  meta: string
  rank?: number
  me?: boolean
  children?: ReactNode
}) {
  return (
    <li className={`ui-row profile__person${me ? ' profile__me' : ''}`}>
      {rank ? <span className="profile__rank">{rank}</span> : null}
      <span className={`ui-avatar ${toneClass(toneForName(name))}`} aria-hidden="true">{initials(name)}</span>
      <span className="ui-row__main">
        <span className="ui-row__title">{label}</span>
        <span className="profile__row-meta">{meta}</span>
      </span>
      {children}
    </li>
  )
}

function SkeletonRows({ rows, plain }: { rows: number; plain?: boolean }) {
  return (
    <ul className="ui-list profile__skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="ui-row">
          {plain ? null : <span className="ui-skeleton profile__skeleton-avatar" />}
          <span className="ui-row__main">
            <span className="ui-skeleton profile__skeleton-name" />
            <span className="ui-skeleton profile__skeleton-meta" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function GearMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function ShareMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V3M7.5 7.5 12 3l4.5 4.5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  )
}

function CopyMark() {
  return (
    <svg className="profile__inline-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

function UsersMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </svg>
  )
}
