import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import { ApiError, parseServerTime, type Friend, type FriendsHub, type PersonSuggestion, type Profile as ProfileData, type Progress as ProgressData, type SentFriendRequest, type SentFriendRequestResult, type StudyGroup } from '../lib/api'
import { useData } from '../lib/dataSource'
import type { AuthSession } from '../lib/auth'
import type { Course } from '../lib/types'
import { AvatarControl } from '../lib/AvatarControl'
import { withCourseTones } from '../lib/session'
import { TONES, courseInitial, toneClass, toneForName, type Tone } from '../lib/tones'
import { useDrawer } from '../lib/useDrawer'
import { ProfileSetupCard } from '../components/ProfileSetupCard'
import { PlanBadge } from '../components/PlanBadge'
import { Icons } from '../components/Icons'
import { canNudge, firstName, rankFriendStreaks, streakDays, streakStatusLine } from '../lib/friendStreaks'
import { useAnnounce } from '../lib/announce'
import { notificationHref, notificationLabel } from '../lib/planLabels'
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

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/* The weekly league counts XP from Monday 00:00 UTC (the server's week), so count down to the next one. */
function leagueReset(now: number) {
  const today = new Date(now)
  const daysToMonday = ((8 - today.getUTCDay()) % 7) || 7
  const left = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + daysToMonday) - now
  if (left < HOUR_MS) return 'Resets in under an hour'
  if (left < DAY_MS) {
    const hours = Math.floor(left / HOUR_MS)
    return `Resets in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  const days = Math.floor(left / DAY_MS)
  const hours = Math.floor((left % DAY_MS) / HOUR_MS)
  return `Resets in ${days}d ${hours}h`
}

/* Friend IDs are 8 hex characters. Accept spaces, dashes and lowercase, and the look-alikes O, I and L. */
const FRIEND_ID = /^[0-9A-F]{8}$/
function normalizeFriendId(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

/* Plain words for why a friend request did not go through. */
function friendRequestError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'No one has that ID. Check the 8 characters.'
    if (error.status === 403) return 'They aren’t accepting friend requests right now.'
    if (error.status === 400 && /yourself/i.test(error.message)) return 'That’s your own friend ID. Share it with a friend instead.'
  }
  return error instanceof Error && error.message ? error.message : 'Could not send that request. Try again.'
}

// Closes the ⋯ menu a button lives in once its action is chosen.
function closeMenu(event: MouseEvent<HTMLElement>) {
  event.currentTarget.closest('details')?.removeAttribute('open')
}

type Notice = { text: string; error?: boolean }
// Owner actions that need a confirmation step. 'leave' is the sole owner leaving, which deletes the group.
type GroupDialogKind = 'transfer' | 'delete' | 'leave'

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
  // Phones and tablets open the system share sheet; computers copy to the clipboard instead.
  const [nativeShare] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
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
  const [socialBusy, setSocialBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The Add a friend dialog (search, friend ID, share your ID).
  const [addOpen, setAddOpen] = useState(false)
  // Signed in, but no bindet profile yet (a new Google account): no friend ID until it is set up.
  const [profileMissing, setProfileMissing] = useState(false)
  const [groupDialog, setGroupDialog] = useState<{ kind: GroupDialogKind; groupId: string } | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  // Friends list order, the friend whose streak detail is open, and reminders sent this visit.
  const [friendSort, setFriendSort] = useState<'streak' | 'name'>('streak')
  const [openFriend, setOpenFriend] = useState<string | null>(null)
  const [nudged, setNudged] = useState<Set<string>>(() => new Set())

  // A different account (or signing out) swaps to that account's cached data during render.
  if (seenToken !== token) {
    setSeenToken(token)
    setProfile(token ? data.getCachedProfile(token) : null)
    setSocial(token ? data.getCachedFriends(token) : null)
    setGroups(token ? data.getCachedStudyGroups(token) : null)
    setSocialFailed(false)
  }

  const say = useCallback((text: string, error = false) => setNotice({ text, error }), [])
  useAnnounce(notice?.text, { error: notice?.error })

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
      .then((value) => {
        setProfile(value)
        setProfileMissing(value === null)
      })
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

  // Sends a request by friend ID (from the dialog or a suggestion), then reloads the lists so it shows as Pending.
  async function sendRequest(friendCode: string) {
    if (!session) throw new Error('Log in to add friends.')
    const result = await data.sendFriendRequest(friendCode, session.access_token)
    void refreshSocial()
    return result
  }

  async function addSuggested(person: PersonSuggestion) {
    if (!session) return
    setSocialBusy(true)
    try {
      await sendRequest(person.friend_code)
      say(`Request sent to ${firstName(person.display_name)}. They’ll see it on their Home.`)
    } catch (error) {
      say(friendRequestError(error), true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function cancelRequest(request: SentFriendRequest) {
    if (!session) return
    setSocialBusy(true)
    try {
      await data.cancelFriendRequest(request.request_id, session.access_token)
      say(`Request to ${firstName(request.display_name)} cancelled.`)
      await refreshSocial()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'request_already_accepted') {
        // They said yes before the cancel arrived; the friendship stays.
        say(`${firstName(request.display_name)} already accepted. You’re friends now.`)
        await refreshSocial().catch(() => undefined)
      } else {
        say('Could not cancel that request. Try again.', true)
      }
    } finally {
      setSocialBusy(false)
    }
  }

  async function copyFriendId() {
    if (!profile?.friend_code) return
    try {
      await navigator.clipboard.writeText(profile.friend_code)
      say(`Friend ID ${profile.friend_code} copied.`)
    } catch {
      say(`Could not copy automatically. Your friend ID is ${profile.friend_code}.`, true)
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
      say('Report sent. Thank you for helping keep bindet safe.')
    } catch {
      say('Could not send that report. Try again.', true)
    }
  }

  async function answerRequest(requestId: number, accept: boolean, name: string) {
    if (!session) return
    setSocialBusy(true)
    try {
      await data.answerFriendRequest(requestId, accept, session.access_token)
      say(accept ? `You and ${firstName(name)} are friends now.` : 'Request declined.')
      await refreshSocial()
    } catch {
      say('Could not answer that request. Try again.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function beginQuest(friendId: string) {
    if (!session) return
    // Only one quest runs per friend: starting another would just return the running one.
    const running = social?.quests.find((quest) => quest.friend_id === friendId && quest.status === 'active')
    if (running) {
      say(`You already have a quest with ${running.friend_name}: ${running.progress_xp} of ${running.target_xp} XP so far.`)
      return
    }
    setSocialBusy(true)
    try {
      const quest = await data.startFriendQuest(friendId, session.access_token)
      say(`Friend quest started. Earn ${quest?.target_xp ?? 100} XP together this week.`)
      await refreshSocial()
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not start that quest.', true)
    } finally {
      setSocialBusy(false)
    }
  }

  async function nudge(friend: Friend) {
    if (!session) return
    const name = firstName(friend.display_name)
    setSocialBusy(true)
    try {
      await data.nudgeFriend(friend.student_id, session.access_token)
      setNudged((current) => new Set(current).add(friend.student_id))
      say(`Reminder sent. ${name} will see it in their notifications.`)
    } catch (error) {
      say(error instanceof Error ? error.message : `Could not remind ${name}. Try again later.`, true)
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

  function dropGroup(groupId: string) {
    setGroups((current) => (current ?? []).filter((item) => item.id !== groupId))
    setActiveGroupId('')
  }

  async function exitGroup(group: StudyGroup) {
    if (!session) return
    // A sole owner leaving deletes the group, so that gets its own confirmation.
    if (group.role === 'owner' && group.members.length <= 1) {
      openGroupDialog('leave', group)
      return
    }
    if (!data.confirm(`Leave ${group.name}?`)) return
    try {
      await data.leaveStudyGroup(group.id, session.access_token)
      dropGroup(group.id)
      say(`Left ${group.name}.`)
    } catch (error) {
      // An owner with members gets the server's owner_must_transfer message (transfer ownership first).
      say(error instanceof Error && error.message ? error.message : `Could not leave ${group.name}. Try again.`, true)
    }
  }

  function openGroupDialog(kind: GroupDialogKind, group: StudyGroup) {
    setDialogError('')
    setGroupDialog({ kind, groupId: group.id })
  }

  async function confirmGroupDialog(group: StudyGroup, kind: GroupDialogKind, newOwnerId: string) {
    if (!session || dialogBusy) return
    setDialogBusy(true)
    setDialogError('')
    try {
      if (kind === 'transfer') {
        const updated = await data.transferStudyGroup(group.id, newOwnerId, session.access_token)
        const owner = group.members.find((member) => member.student_id === newOwnerId)
        setGroups((current) => (current ?? []).map((item) => item.id === group.id ? { ...item, ...updated, role: 'member' } : item))
        say(`${owner?.display_name ?? 'They'} now own${owner ? 's' : ''} ${group.name}. You are still a member.`)
      } else if (kind === 'delete') {
        await data.deleteStudyGroup(group.id, session.access_token)
        dropGroup(group.id)
        say(`Deleted ${group.name}. Its tasks are now personal tasks of the people who made them.`)
      } else {
        await data.leaveStudyGroup(group.id, session.access_token)
        dropGroup(group.id)
        say(`Left and deleted ${group.name}.`)
      }
      setGroupDialog(null)
      void refreshSocial()
    } catch (error) {
      setDialogError(error instanceof Error && error.message ? error.message : 'That didn’t work. Try again.')
    } finally {
      setDialogBusy(false)
    }
  }

  function retrySocial() {
    setSocialFailed(false)
    void refreshSocial(true)
  }

  const totalXp = profile?.total_xp ?? stats?.total_xp ?? 0
  const { level, inLevel, toNext } = xpLevel(totalXp)
  // The study streak, the same one Home, the league and friend streaks show.
  const streak = Math.max(stats?.streak ?? profile?.streak ?? 0, 0)
  const bestStreak = Math.max(stats?.best_streak ?? 0, streak)
  const unitStats = stats?.topics ?? []
  const username = profile?.username ?? 'Learner'
  const displayName = profile?.display_name ?? username
  const groupList = groups ?? []
  const groupTones = groupToneMap(groupList)
  const activeGroup = groupList.find((group) => group.id === activeGroupId) ?? groupList[0] ?? null
  const dialogGroup = groupDialog ? groupList.find((group) => group.id === groupDialog.groupId) ?? null : null
  const socialLoading = Boolean(session) && !social && !socialFailed
  const groupsLoading = Boolean(session) && groups === null && !socialFailed
  const suggestions = social?.suggestions ?? []
  const sent = social?.sent ?? []
  const requests = social?.requests ?? []
  const unread = social?.notifications.filter((item) => !item.is_read).length ?? 0
  const friendList = social ? (friendSort === 'streak' ? rankFriendStreaks(social.friends) : social.friends.toSorted((a, b) => a.display_name.localeCompare(b.display_name))) : []
  const league = social?.leaderboard ?? []
  const leaderXp = Math.max(0, ...league.map((person) => person.weekly_xp))
  const myLeagueIndex = league.findIndex((person) => person.student_id === studentId)
  const weekXp = myLeagueIndex >= 0 ? league[myLeagueIndex].weekly_xp : null
  // Adding friends needs a profile (that is where the friend ID lives).
  const canAdd = Boolean(session && profile)
  const openAdd = () => setAddOpen(true)
  const failedAlert = socialFailed && !social ? (
    <div className="ui-alert" role="alert">
      <span>Friends and groups could not be loaded.</span>
      <button type="button" className="ui-button ui-button--sm" onClick={retrySocial}>Try again</button>
    </div>
  ) : null

  return (
    <div className="ui-page profile">
      <header className={`profile__hero ${toneClass(toneForName(displayName || 'bindit'))}`}>
        <div className="profile__identity">
          <span className="profile__avatar-ring"><AvatarControl name={displayName} onError={onError} /></span>
          <div className="profile__identity-text">
            <span className="ui-eyebrow">Friends &amp; groups</span>
            <div className="profile__name-row">
              <h1 className="ui-page-title profile__name">{displayName}</h1>
              <PlanBadge plan={profile?.plan} className="profile__plan" />
            </div>
            <div className="profile__handle">
              {profile ? <span className="profile__username">@{profile.username}</span> : null}
              {profile?.friend_code ? (
                <button type="button" className="profile__id-chip" onClick={() => void copyFriendId()} title="Copy your friend ID">
                  <span className="profile__id-label">Friend ID</span>
                  <span className="profile__code">{profile.friend_code}</span>
                  <CopyMark />
                  <span className="sr-only">Copy</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="profile__header-actions">
          {canAdd ? (
            <button className="ui-button ui-button--primary profile__add-friend" type="button" onClick={openAdd}>
              <PlusMark />
              Add a friend
            </button>
          ) : null}
          <a className="ui-button" href="#settings">
            <GearMark />
            Settings
          </a>
        </div>
      </header>

      <ul className="profile-stats" aria-label="Your stats">
        <li className="profile-stat ui-tone--blue">
          <span className="profile-stat__icon">{Icons.level}</span>
          <span className="profile-stat__label">Level</span>
          <span className="profile-stat__value">{level}</span>
          <span
            className="profile-stat__meter"
            role="progressbar"
            aria-valuenow={inLevel}
            aria-valuemin={0}
            aria-valuemax={XP_PER_LEVEL}
            aria-label={`${inLevel} of ${XP_PER_LEVEL} XP toward level ${level + 1}`}
          >
            <span style={{ width: `${(inLevel / XP_PER_LEVEL) * 100}%` }} />
          </span>
          <span className="profile-stat__meta">{toNext} XP to level {level + 1}</span>
        </li>
        <li className="profile-stat ui-tone--violet">
          <span className="profile-stat__icon">{Icons.sparkle}</span>
          <span className="profile-stat__label">Total XP</span>
          <span className="profile-stat__value">{totalXp.toLocaleString()}</span>
          <span className="profile-stat__meta">{weekXp !== null ? `+${weekXp.toLocaleString()} this week` : 'From quizzes and practice'}</span>
        </li>
        <li className="profile-stat ui-tone--orange">
          <span className="profile-stat__icon">{Icons.flame}</span>
          <span className="profile-stat__label">Study streak</span>
          <span className="profile-stat__value">{streak}<small> {streak === 1 ? 'day' : 'days'}</small></span>
          <span className="profile-stat__meta">{bestStreak > streak ? `Best: ${streakDays(bestStreak)}` : streak ? 'Your best yet' : 'Study today to start one'}</span>
          {streak >= 7 ? <img className="ui-mascot-cheer profile-stat__cheer" src="/bindit-mascot-cutout.webp" alt="" width="36" height="43" title={`${streak}-day streak`} /> : null}
        </li>
        <li className="profile-stat ui-tone--pink">
          <span className="profile-stat__icon">{Icons.users}</span>
          <span className="profile-stat__label">Friends</span>
          <span className="profile-stat__value">{social ? social.friends.length : socialLoading ? <span className="ui-skeleton profile__stat-skeleton" /> : 0}</span>
          <span className="profile-stat__meta">
            {requests.length ? `${requests.length} ${requests.length === 1 ? 'request' : 'requests'} waiting`
              : myLeagueIndex >= 0 && league.length > 1 ? `#${myLeagueIndex + 1} of ${league.length} in your league`
                : 'Add one to start a league'}
          </span>
        </li>
      </ul>

      {session && profileMissing && !data.sandboxed ? <ProfileSetupCard className="profile__setup" /> : null}

      {failedAlert}

      <div className={`profile__grid${requests.length ? ' has-requests' : ''}`}>
        {requests.length ? (
          <section className="profile__requests" aria-labelledby="requests-title">
            <h2 className="profile__requests-title" id="requests-title">
              <span className="profile__head-icon ui-tone--pink">{Icons.users}</span>
              Friend requests
              <span className="profile__requests-count">{requests.length}</span>
            </h2>
            <ul className="ui-list">
              {requests.map((request) => (
                <PersonRow key={request.request_id} name={request.display_name} label={request.display_name} meta={`@${request.username} wants to be friends`}>
                  <span className="profile__row-actions">
                    <button className="ui-button ui-button--sm profile__btn-blue" type="button" onClick={() => void answerRequest(request.request_id, true, request.display_name)} disabled={socialBusy} aria-label={`Accept ${request.display_name}`}>Accept</button>
                    <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void answerRequest(request.request_id, false, request.display_name)} disabled={socialBusy} aria-label={`Decline ${request.display_name}`}>Decline</button>
                  </span>
                </PersonRow>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="profile__main">
          <section className="ui-section" aria-labelledby="study-groups-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="study-groups-title">
                <span className="profile__head-icon ui-tone--teal"><UsersMark /></span>
                Study groups {groupList.length ? <span className="ui-count">{groupList.length}</span> : null}
              </h2>
              {session && groupList.length ? (
                <button className="ui-button ui-button--sm" type="button" aria-expanded={showGroupSetup} aria-controls="group-setup" onClick={() => setShowGroupSetup((current) => !current)}>
                  {showGroupSetup ? 'Close' : <><PlusMark />New or join</>}
                </button>
              ) : null}
            </div>

            {showGroupSetup ? (
              <div className="ui-panel profile__group-setup" id="group-setup">
                <form className="profile__form" onSubmit={makeGroup}>
                  <h3 className="profile__form-title">Start a group</h3>
                  <label className="ui-field">
                    <span>Group name</span>
                    <input className="ui-input" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="AP Bio study circle" maxLength={48} autoComplete="off" autoCapitalize="words" enterKeyHint="next" />
                  </label>
                  <label className="ui-field">
                    <span>What are you studying? <span className="profile__optional">Optional</span></span>
                    <input className="ui-input" value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} placeholder="Weekly review before unit tests" maxLength={160} autoComplete="off" enterKeyHint="done" />
                  </label>
                  <button className="ui-button ui-button--primary" disabled={socialBusy || groupName.trim().length < 2}>Create group</button>
                </form>
                <form className="profile__form" onSubmit={joinGroup}>
                  <h3 className="profile__form-title">Join with a code</h3>
                  <label className="ui-field">
                    <span>Invite code</span>
                    <input className="ui-input profile__code-input" value={groupCode} onChange={(event) => setGroupCode(event.target.value.toUpperCase())} placeholder="8-character code" maxLength={10} aria-label="Study group invite code" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" />
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
              <>
                <ul className="profile__group-cards">
                  {groupList.map((group) => {
                    const goal = percent(group.weekly_xp, group.weekly_goal_xp)
                    const selected = activeGroup.id === group.id
                    return (
                      <li key={group.id} className={`profile__group-card ${toneClass(groupTones.get(group.id) ?? 'teal')}${selected && groupList.length > 1 ? ' is-selected' : ''}`}>
                        <div className="profile__group-card-top">
                          <span className="profile__group-mark" aria-hidden="true">{courseInitial(group.name)}</span>
                          <span className="profile__group-card-text">
                            <span className="profile__group-card-name">{group.name}</span>
                            <span className="profile__group-card-meta">{group.members.length} {group.members.length === 1 ? 'member' : 'members'} · {group.role === 'owner' ? 'You own it' : 'Member'}</span>
                          </span>
                        </div>
                        <AvatarStack names={group.members.map((member) => member.student_id === studentId ? displayName : member.display_name)} />
                        <div className="profile__group-card-goal">
                          <span><strong>{group.weekly_xp.toLocaleString()}</strong> / {group.weekly_goal_xp.toLocaleString()} XP this week</span>
                          <span className="profile__group-card-pct">{goal}%</span>
                        </div>
                        <span className="profile__group-card-meter" role="progressbar" aria-label={`${group.name} weekly goal`} aria-valuemin={0} aria-valuemax={group.weekly_goal_xp} aria-valuenow={Math.min(group.weekly_xp, group.weekly_goal_xp)}>
                          <span style={{ width: `${goal}%` }} />
                        </span>
                        <div className="profile__group-card-actions">
                          <a className="ui-button ui-button--sm profile__group-open" href={`#stats?group=${encodeURIComponent(group.id)}`}>
                            Open<span className="sr-only"> {group.name}</span>
                          </a>
                          {groupList.length > 1 ? (
                            <button type="button" className="ui-button ui-button--ghost ui-button--sm profile__group-pick" aria-pressed={selected} aria-controls="group-panel" onClick={() => setActiveGroupId(group.id)}>
                              {selected ? 'Shown below' : 'Members'}<span className="sr-only"> of {group.name}</span>
                            </button>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>

                <div className={`ui-panel profile__group-body ${toneClass(groupTones.get(activeGroup.id) ?? 'teal')}`} id="group-panel" aria-label={`${activeGroup.name} details`}>
                  <div className="profile__group-top">
                    <div className="profile__group-heading">
                      <h3 className="profile__group-name">{activeGroup.name}</h3>
                      <p className="profile__group-copy">{activeGroup.description || 'A private place to keep each other moving.'}</p>
                    </div>
                    <button type="button" className="profile__invite" onClick={() => void copyGroupCode(activeGroup.invite_code)} aria-label={`Copy invite code ${activeGroup.invite_code}`}>
                      <span>Invite code</span>
                      <strong>{activeGroup.invite_code}</strong>
                      <small><CopyMark /> Copy</small>
                    </button>
                  </div>

                  <div className="profile__group-columns">
                    <div>
                      <h4 className="profile__label">Members this week</h4>
                      <ol className="ui-list profile__compact">
                        {activeGroup.members.map((member, index) => (
                          <PersonRow
                            key={member.student_id}
                            name={member.student_id === studentId ? displayName : member.display_name}
                            label={member.student_id === studentId ? 'You' : member.display_name}
                            meta={`@${member.username}`}
                            rank={index + 1}
                            me={member.student_id === studentId}
                          >
                            {member.role === 'owner' ? <span className="ui-badge ui-badge--tone ui-tone--teal">Owner</span> : null}
                            <span className="ui-row__aside profile__league-xp">{member.weekly_xp} XP</span>
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
                              name={item.student_id === studentId ? displayName : item.display_name}
                              label={item.student_id === studentId ? 'You' : item.display_name}
                              meta={shortDate.format(new Date(parseServerTime(item.created_at)))}
                            >
                              <span className="ui-row__aside profile__xp-gain">+{item.xp} XP</span>
                            </PersonRow>
                          ))}
                        </ul>
                      ) : <p className="profile__empty profile__empty--boxed">Nothing yet this week. Finish a quiz to start the feed.</p>}
                    </div>
                  </div>

                  <div className="profile__group-footer">
                    {activeGroup.role === 'owner' ? (
                      <>
                        {activeGroup.members.length > 1 ? (
                          <button type="button" className="ui-button ui-button--sm" onClick={() => openGroupDialog('transfer', activeGroup)}>Transfer ownership</button>
                        ) : null}
                        <button type="button" className="ui-button ui-button--danger ui-button--sm" onClick={() => openGroupDialog('delete', activeGroup)}>Delete group</button>
                      </>
                    ) : null}
                    <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={() => void exitGroup(activeGroup)}>Leave group</button>
                  </div>
                </div>
              </>
            ) : !showGroupSetup && !(socialFailed && !social) ? (
              <div className="profile__placeholder ui-tone--teal">
                <span className="ui-icon profile__placeholder-icon"><UsersMark /></span>
                <div>
                  <p className="profile__placeholder-title">No study groups yet</p>
                  <p className="profile__placeholder-copy">
                    {session ? 'Members pool XP toward a weekly goal.' : 'Log in to start or join a study group.'}
                  </p>
                </div>
                {session ? <button type="button" className="ui-button ui-button--primary ui-button--sm" onClick={() => setShowGroupSetup(true)}><PlusMark />Start or join a group</button> : null}
              </div>
            ) : null}
          </section>

          <section className="ui-section" aria-labelledby="league-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="league-title">
                <span className="profile__head-icon ui-tone--amber">{Icons.trophy}</span>
                Weekly league
              </h2>
              <span className="profile__reset">{leagueReset(data.now())}</span>
            </div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={3} /> : league.length < 2 ? (
                <div className="profile__empty-cta">
                  <p>Add a friend to start a weekly XP race. It resets every Monday.</p>
                  {canAdd ? <button type="button" className="ui-button ui-button--sm profile__add-friend" onClick={openAdd}><PlusMark />Add a friend</button> : null}
                </div>
              ) : (
                <ol className="ui-list">
                  {league.map((person, index) => {
                    const me = person.student_id === studentId
                    const name = me ? displayName : person.display_name
                    const share = leaderXp > 0 ? Math.max(3, Math.round((person.weekly_xp / leaderXp) * 100)) : 0
                    return (
                      <li key={person.student_id} className={`ui-row profile__person profile__league-row${me ? ' profile__me' : ''}`}>
                        <span className={`profile__rank${index < 3 ? ` profile__rank--medal profile__rank--${index + 1}` : ''}`}>
                          <span className="sr-only">Rank </span>{index + 1}
                        </span>
                        <span className={`ui-avatar ${toneClass(toneForName(name))}`} aria-hidden="true">{initials(name)}</span>
                        <span className="ui-row__main">
                          <span className="profile__league-name">
                            <span className="ui-row__title">{me ? 'You' : person.display_name}</span>
                            <span className="profile__row-meta">{person.active_today ? 'Active today' : person.streak > 0 ? `${person.streak}-day streak` : 'No streak yet'}</span>
                          </span>
                          <span className={`profile__league-bar ${toneClass(toneForName(name))}`} aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
                        </span>
                        <span className="ui-row__aside profile__league-xp">{person.weekly_xp.toLocaleString()} XP</span>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="activity-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="activity-title">
                <span className="profile__head-icon ui-tone--green">{Icons.bolt}</span>
                Friend activity
              </h2>
            </div>
            <div className="ui-panel">
              {socialLoading ? <SkeletonRows rows={2} /> : social?.activity.length ? (
                <ul className="ui-list">
                  {social.activity.slice(0, 6).map((event) => (
                    <PersonRow
                      key={event.id}
                      name={event.student_id === studentId ? displayName : event.display_name}
                      label={`${event.student_id === studentId ? 'You' : event.display_name} earned ${event.xp} XP`}
                      meta={shortDate.format(new Date(parseServerTime(event.created_at)))}
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
              ) : (
                <div className="profile__empty-cta">
                  <p>Study activity from you and your friends shows up here.</p>
                  <a className="ui-link" href="#tools">Take a quiz</a>
                </div>
              )}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="record-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="record-title">
                <span className="profile__head-icon ui-tone--blue">{Icons.check}</span>
                Record
              </h2>
              <a className="ui-link" href="#progress">Full progress</a>
            </div>
            <div className="ui-panel">
              {unitStats.length === 0 ? (
                <div className="profile__empty-cta">
                  <p>Unit accuracy shows up here after your first quiz.</p>
                  <a className="ui-link" href="#tools">Take a quiz</a>
                </div>
              ) : (
                <ul className="ui-list">
                  {unitStats.map((unit) => (
                    <li key={unit.topic} className={`profile__record ${unit.accuracy >= 70 ? 'ui-tone--green' : 'ui-tone--amber'}`}>
                      <div className="profile__goal-line">
                        <span className="profile__record-name">{formatTopic(unit.topic)}</span>
                        <span><strong className="profile__record-pct">{Math.round(unit.accuracy)}%</strong> · {unit.correct_answers} of {unit.attempts} correct</span>
                      </div>
                      <div className="ui-meter profile__record-meter" role="progressbar" aria-label={`${formatTopic(unit.topic)} accuracy`} aria-valuenow={unit.accuracy} aria-valuemin={0} aria-valuemax={100}>
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
              <h2 className="ui-section-title" id="friends-title">
                <span className="profile__head-icon ui-tone--pink">{Icons.users}</span>
                Friends {social?.friends.length ? <span className="ui-count">{social.friends.length}</span> : null}
              </h2>
            </div>
            <div className="ui-panel profile__friends">
              {canAdd && social?.friends.length ? (
                <div className="profile__add-row">
                  <button className="ui-button ui-button--primary profile__add-friend profile__add-friend--wide" type="button" onClick={openAdd}>
                    <PlusMark />
                    Add a friend
                  </button>
                </div>
              ) : null}

              {sent.length ? (
                <div className="profile__block">
                  <h3 className="profile__label">Waiting for an answer</h3>
                  <ul className="ui-list">
                    {sent.map((request) => (
                      <PersonRow key={request.request_id} name={request.display_name} label={request.display_name} meta={`@${request.username}`}>
                        <span className="ui-badge ui-badge--tone ui-tone--amber">Pending</span>
                        <button className="ui-button ui-button--ghost ui-button--sm profile__cancel-request" type="button" onClick={() => void cancelRequest(request)} disabled={socialBusy} aria-label={`Cancel your request to ${request.display_name}`}>Cancel</button>
                      </PersonRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {socialLoading ? (
                <div className="profile__block"><SkeletonRows rows={3} /></div>
              ) : social?.friends.length ? (
                <div className="profile__block">
                  <div className="profile__friends-head">
                    <h3 className="profile__label" id="your-friends-title">Your friends</h3>
                    <div className="ui-segmented profile__friend-sort" role="group" aria-label="Sort friends">
                      <button type="button" className="ui-segmented__item" aria-pressed={friendSort === 'streak'} onClick={() => setFriendSort('streak')}>Streak</button>
                      <button type="button" className="ui-segmented__item" aria-pressed={friendSort === 'name'} onClick={() => setFriendSort('name')}>Name</button>
                    </div>
                  </div>
                  <ul className="ui-list" aria-labelledby="your-friends-title">
                    {friendList.map((friend) => {
                      const open = openFriend === friend.student_id
                      const detailId = `friend-streak-${friend.student_id}`
                      const alive = friend.friend_streak > 0
                      return (
                        <li key={friend.student_id} className={`profile__friend${open ? ' is-open' : ''}`}>
                          <div className="ui-row profile__person">
                            <span className={`ui-avatar ${toneClass(toneForName(friend.display_name))}`} aria-hidden="true">{initials(friend.display_name)}</span>
                            <span className="ui-row__main">
                              <span className="ui-row__title">{friend.display_name}</span>
                              <span className={`profile__row-meta${friend.friend_today && !friend.me_today ? ' is-your-turn' : ''}`}>{streakStatusLine(friend)}</span>
                            </span>
                            <button
                              type="button"
                              className={`profile__streak-toggle ui-tone--orange${alive ? '' : ' is-zero'}`}
                              aria-expanded={open}
                              aria-controls={detailId}
                              aria-label={`Friend streak with ${friend.display_name}: ${streakDays(friend.friend_streak)}. ${open ? 'Hide' : 'Show'} the last 14 days`}
                              title="Friend streak"
                              onClick={() => setOpenFriend(open ? null : friend.student_id)}
                            >
                              {Icons.flame}<span>{friend.friend_streak}</span>
                            </button>
                            <button className="ui-button ui-button--sm profile__quest-button ui-tone--violet" type="button" onClick={() => void beginQuest(friend.student_id)} disabled={socialBusy} aria-label={`Start a quest with ${friend.display_name}`}>Quest</button>
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
                          </div>
                          {open ? (
                            <FriendStreakDetail
                              id={detailId}
                              friend={friend}
                              nudged={nudged.has(friend.student_id)}
                              busy={socialBusy}
                              onNudge={() => void nudge(friend)}
                            />
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ) : null}

              {session && social && !social.friends.length ? (
                <div className="ui-empty profile__friends-empty">
                  <img className="ui-empty__mascot" src="/bindit-mascot-cutout.webp" alt="" width="120" height="144" />
                  <p className="ui-empty__title">No friends yet</p>
                  <p className="ui-empty__copy">Add a classmate by name or friend ID to start a weekly league and friend streaks.</p>
                  {canAdd ? (
                    <button className="ui-button ui-button--primary profile__add-friend" type="button" onClick={openAdd}>
                      <PlusMark />
                      Add a friend
                    </button>
                  ) : null}
                </div>
              ) : null}

              {suggestions.length ? (
                <div className="profile__block">
                  <h3 className="profile__label">People you may know</h3>
                  <ul className="ui-list">
                    {suggestions.slice(0, 4).map((person) => (
                      <PersonRow key={person.student_id} name={person.display_name} label={person.display_name} meta={`@${person.username}`}>
                        <button className="ui-button ui-button--sm profile__suggest-add" type="button" onClick={() => void addSuggested(person)} disabled={socialBusy} aria-label={`Add ${person.display_name}`}><PlusMark />Add</button>
                      </PersonRow>
                    ))}
                  </ul>
                </div>
              ) : null}

              {session && profileMissing ? <p className="profile__hint">Finish setting up your profile to get a friend ID you can share.</p>
                : !session ? <p className="profile__hint">Log in to get a friend ID you can share.</p> : null}
            </div>
          </section>

          <section className="ui-section" aria-labelledby="quests-title">
            <div className="ui-section-head">
              <h2 className="ui-section-title" id="quests-title">
                <span className="profile__head-icon ui-tone--violet">{Icons.swords}</span>
                Friend quests
              </h2>
              <span className="ui-count">Earn XP together in a week</span>
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
                            {quest.progress_xp >= quest.target_xp ? 'Complete' : `${quest.target_xp - quest.progress_xp} XP to go`} · ends {shortDate.format(new Date(parseServerTime(quest.expires_at)))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {!social?.quests.length && social?.friends.length ? (
                    <div className="profile__quest-start">
                      <p className="profile__empty profile__empty--flush">No quest running. Pair up with a friend and earn 100 XP together this week.</p>
                      <button className="ui-button ui-button--sm profile__quest-button ui-tone--violet" type="button" disabled={socialBusy} onClick={() => void beginQuest(social.friends[0].student_id)}>Start a quest with {social.friends[0].display_name}</button>
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
                <span className="profile__head-icon ui-tone--blue">{Icons.message}</span>
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
                        {item.kind === 'plan_granted' ? (
                          <a className="ui-link" href={notificationHref(item.kind)}>
                            <span className="ui-badge ui-badge--tone ui-tone--violet profile__notification-kind">{notificationLabel(item.kind)}</span>
                            {item.message}
                          </a>
                        ) : item.message}
                      </span>
                      <time dateTime={item.created_at}>{shortDate.format(new Date(parseServerTime(item.created_at)))}</time>
                    </li>
                  ))}
                </ul>
              ) : <p className="profile__empty">You’re all caught up.</p>}
            </div>
          </section>

          {profile ? (
            <section className="ui-section" aria-labelledby="privacy-title">
              <div className="ui-section-head">
                <h2 className="ui-section-title" id="privacy-title">
                  <span className="profile__head-icon ui-tone--green">{Icons.check}</span>
                  Privacy and safety
                </h2>
              </div>
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
              <h2 className="ui-section-title" id="studying-title">
                <span className="profile__head-icon ui-tone--orange">{Icons.target}</span>
                Currently studying
              </h2>
              {courses.length ? <a className="ui-link" href="#tools">Open Study</a> : null}
            </div>
            <div className="ui-panel ui-panel--padded">
              {courses.length === 0 ? (
                <div className="profile__empty-cta profile__empty-cta--flush">
                  <p>Your courses show up here.</p>
                  <a className="ui-link" href="#tools">Add a course</a>
                </div>
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
        <div className="app-toast">
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {addOpen && session && profile ? (
        <AddFriendDialog
          token={session.access_token}
          ownCode={profile.friend_code}
          social={social}
          nativeShare={nativeShare}
          onSend={sendRequest}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      {groupDialog && dialogGroup ? (
        <GroupOwnerDialog
          key={`${groupDialog.kind}-${dialogGroup.id}`}
          kind={groupDialog.kind}
          group={dialogGroup}
          me={studentId}
          busy={dialogBusy}
          error={dialogError}
          onCancel={() => { if (!dialogBusy) setGroupDialog(null) }}
          onConfirm={(newOwnerId) => void confirmGroupDialog(dialogGroup, groupDialog.kind, newOwnerId)}
        />
      ) : null}
    </div>
  )
}

type AddTab = 'search' | 'code' | 'share'
const ADD_TABS: { id: AddTab; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'code', label: 'Friend ID' },
  { id: 'share', label: 'Share your ID' },
]

/*
 * Add a friend: search by name or username (live, debounced), type their friend ID, or
 * share your own. A bottom sheet on phones. Sending reloads the page's lists (Pending).
 */
function AddFriendDialog({ token, ownCode, social, nativeShare, onSend, onClose }: {
  token: string
  ownCode: string
  social: FriendsHub | null
  nativeShare: boolean
  onSend: (friendCode: string) => Promise<SentFriendRequestResult>
  onClose: () => void
}) {
  const data = useData()
  const panel = useRef<HTMLDivElement>(null)
  useDrawer({ open: true, onClose, panel })
  const [tab, setTab] = useState<AddTab>('search')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; people: PersonSuggestion[]; error: string }>({ query: '', people: [], error: '' })
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState('')
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState<Notice | null>(null)
  // Sent from this dialog, before the page's lists have reloaded.
  const [sentHere, setSentHere] = useState<Set<string>>(() => new Set())
  const q = query.trim()

  // Live results: wait for a pause in typing, then ask the server. Stale answers are dropped.
  useEffect(() => {
    if (q.length < 2) return
    let live = true
    const timer = window.setTimeout(() => {
      data.searchFriends(q, token)
        .then((people) => { if (live) setFound({ query: q, people, error: '' }) })
        .catch(() => { if (live) setFound({ query: q, people: [], error: 'Search isn’t working right now. Try again in a moment, or use their friend ID.' }) })
    }, 300)
    return () => { live = false; window.clearTimeout(timer) }
  }, [data, q, token])

  const friendIds = new Set((social?.friends ?? []).map((friend) => friend.student_id))
  const pendingIds = new Set([...(social?.sent ?? []).map((request) => request.student_id), ...sentHere])
  const titleId = 'add-friend-title'

  async function send(friendCode: string, key: string) {
    setBusy(key)
    setStatus(null)
    try {
      const result = await onSend(friendCode)
      setSentHere((current) => new Set(current).add(result.friend.student_id))
      setStatus({ text: `Request sent to ${firstName(result.friend.display_name)}. They’ll see it on their Home.` })
      return true
    } catch (error) {
      const text = friendRequestError(error)
      if (key === 'code') setCodeError(text)
      else setStatus({ text, error: true })
      return false
    } finally {
      setBusy('')
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault()
    const normalized = normalizeFriendId(code)
    if (!FRIEND_ID.test(normalized)) {
      setCodeError('Friend IDs are 8 letters and numbers, like 4F2A9C01. Check what they sent you.')
      return
    }
    if (normalized === ownCode) {
      setCodeError('That’s your own friend ID. Share it with a friend instead.')
      return
    }
    if (await send(normalized, 'code')) setCode('')
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(ownCode)
      setStatus({ text: `Friend ID ${ownCode} copied.` })
    } catch {
      setStatus({ text: `Could not copy automatically. Your friend ID is ${ownCode}.`, error: true })
    }
  }

  async function shareId() {
    const share = { title: 'Add me on bindet', text: `Add me on bindet with friend ID ${ownCode}`, url: window.location.origin }
    try {
      if (nativeShare) await navigator.share(share)
      else {
        await navigator.clipboard.writeText(`${share.text} — ${share.url}`)
        setStatus({ text: 'Invite message copied. Paste it into a text or chat.' })
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setStatus({ text: `Could not share. Your friend ID is ${ownCode}.`, error: true })
    }
  }

  return (
    <div className="ui-dialog-backdrop profile__add-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={panel} className="ui-dialog profile__add-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ui-dialog__header profile__add-header">
          <h2 className="ui-dialog__title" id={titleId}>Add a friend</h2>
          <button type="button" className="profile__add-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="profile__add-body">
          <div
            className="ui-segmented profile__add-tabs"
            role="tablist"
            aria-label="Ways to add a friend"
            onKeyDown={(event) => {
              const at = ADD_TABS.findIndex((item) => item.id === tab)
              const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ADD_TABS.length - 1 }[event.key]
              if (to === undefined) return
              event.preventDefault()
              const next = ADD_TABS[(to + ADD_TABS.length) % ADD_TABS.length]
              setTab(next.id)
              document.getElementById(`add-tab-${next.id}`)?.focus()
            }}
          >
            {ADD_TABS.map((item) => (
              <button
                key={item.id}
                id={`add-tab-${item.id}`}
                type="button"
                role="tab"
                className="ui-segmented__item"
                aria-selected={tab === item.id}
                aria-controls={`add-panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'search' ? (
            <div className="profile__add-panel" id="add-panel-search" role="tabpanel" aria-labelledby="add-tab-search">
              <label className="ui-field">
                <span>Search by name or username</span>
                <input
                  className="ui-input profile__add-input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Maya, or maya_chen"
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="search"
                  autoFocus
                />
              </label>
              {q.length < 2 ? (
                <p className="profile__add-help">Type at least 2 letters. Someone who hid their profile from search can still be added by friend ID.</p>
              ) : found.query !== q ? (
                <p className="profile__add-help" aria-live="polite">Searching…</p>
              ) : found.error ? (
                <p className="profile__add-error" role="alert">{found.error}</p>
              ) : !found.people.length ? (
                <p className="profile__add-help" aria-live="polite">No one found for “{q}”. Try their username, or ask for their friend ID.</p>
              ) : (
                <ul className="ui-list profile__add-results" aria-label={`People matching ${q}`}>
                  {found.people.map((person) => (
                    <PersonRow key={person.student_id} name={person.display_name} label={person.display_name} meta={`@${person.username}`}>
                      {friendIds.has(person.student_id) ? <span className="ui-badge ui-badge--tone ui-tone--green">Friends</span>
                        : pendingIds.has(person.student_id) ? <span className="ui-badge ui-badge--tone ui-tone--amber">Pending</span>
                          : (
                            <button type="button" className={`ui-button ui-button--sm profile__btn-blue${busy === person.student_id ? ' is-busy' : ''}`} disabled={Boolean(busy)} onClick={() => void send(person.friend_code, person.student_id)} aria-label={`Add ${person.display_name}`}>
                              <PlusMark />Add
                            </button>
                          )}
                    </PersonRow>
                  ))}
                </ul>
              )}
            </div>
          ) : tab === 'code' ? (
            <form className="profile__add-panel" id="add-panel-code" role="tabpanel" aria-labelledby="add-tab-code" onSubmit={(event) => void submitCode(event)}>
              <label className="ui-field">
                <span>Enter their friend ID</span>
                <input
                  className="ui-input profile__code-input profile__add-input profile__add-code"
                  value={code}
                  onChange={(event) => { setCode(event.target.value); setCodeError('') }}
                  placeholder="8 characters, like 4F2A9C01"
                  maxLength={16}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  aria-invalid={Boolean(codeError)}
                  aria-describedby="add-code-help"
                  autoFocus
                />
              </label>
              {codeError ? <p className="profile__add-error" id="add-code-help" role="alert">{codeError}</p>
                : <p className="profile__add-help" id="add-code-help">It’s on their Friends page, next to their name. Spaces and lowercase are fine.</p>}
              <button type="submit" className={`ui-button profile__btn-blue profile__add-submit${busy === 'code' ? ' is-busy' : ''}`} disabled={Boolean(busy) || !code.trim()}>Send friend request</button>
            </form>
          ) : (
            <div className="profile__add-panel profile__share-id" id="add-panel-share" role="tabpanel" aria-labelledby="add-tab-share">
              <p className="profile__share-label">Your friend ID</p>
              <p className="profile__share-code">{ownCode}</p>
              <p className="profile__add-help">Send this to a friend. They type it into Add a friend.</p>
              <div className="profile__share-actions">
                <button type="button" className="ui-button" onClick={() => void copyId()}><CopyMark />Copy ID</button>
                <button type="button" className="ui-button profile__btn-blue" onClick={() => void shareId()}><ShareMark />{nativeShare ? 'Share' : 'Copy invite message'}</button>
              </div>
            </div>
          )}

          {status ? (
            <p className={`profile__add-status${status.error ? ' is-error' : ''}`} role={status.error ? 'alert' : 'status'}>
              {status.error ? null : Icons.check}
              {status.text}
            </p>
          ) : null}
        </div>
        <footer className="ui-dialog__footer">
          <button type="button" className="ui-button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}

/* Each group keeps its own stable color; when two groups would share one, the later one takes the next free hue. */
function groupToneMap(groups: StudyGroup[]) {
  const tones = new Map<string, Tone>()
  const used = new Set<Tone>()
  for (const group of groups) {
    const first = TONES.indexOf(toneForName(group.name))
    const free = TONES.map((_, step) => TONES[(first + step) % TONES.length]).find((tone) => !used.has(tone)) ?? TONES[first]
    tones.set(group.id, free)
    used.add(free)
  }
  return tones
}

/* Up to five member initials in their own colors, then "+N". */
function AvatarStack({ names }: { names: string[] }) {
  const shown = names.slice(0, 5)
  return (
    <span className="profile__avatar-stack" aria-hidden="true">
      {shown.map((name, index) => (
        <span key={`${name}-${index}`} className={`ui-avatar ${toneClass(toneForName(name))}`}>{initials(name)}</span>
      ))}
      {names.length > shown.length ? <span className="ui-avatar profile__avatar-more">+{names.length - shown.length}</span> : null}
    </span>
  )
}

/* Confirms an owner action: transfer to a member, delete (type the name), or leave as the last member. */
function GroupOwnerDialog({ kind, group, me, busy, error, onCancel, onConfirm }: {
  kind: GroupDialogKind
  group: StudyGroup
  me: string
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: (newOwnerId: string) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const others = group.members.filter((member) => member.student_id !== me)
  const [newOwner, setNewOwner] = useState(others[0]?.student_id ?? '')
  const [typed, setTyped] = useState('')
  useDrawer({ open: true, onClose: onCancel, panel })
  const titleId = `group-dialog-${kind}`
  const nameMatches = typed.trim().toLowerCase() === group.name.trim().toLowerCase()
  const ready = kind === 'transfer' ? Boolean(newOwner) : kind === 'delete' ? nameMatches : true
  const chosen = others.find((member) => member.student_id === newOwner)
  const memberCount = `${group.members.length} ${group.members.length === 1 ? 'member' : 'members'}`

  return (
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div ref={panel} className="ui-dialog profile__dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-copy`}>
        <form onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onConfirm(newOwner) }}>
          <header className="ui-dialog__header">
            <h2 className="ui-dialog__title" id={titleId}>
              {kind === 'transfer' ? `Transfer ${group.name}` : kind === 'delete' ? `Delete ${group.name}?` : `Leave and delete ${group.name}?`}
            </h2>
          </header>
          <div className="profile__dialog-body">
            {kind === 'transfer' ? (
              <>
                <p id={`${titleId}-copy`}>The new owner manages the group’s tasks and is the only one who can delete it. You stay in the group as a member.</p>
                <label className="ui-field">
                  <span>New owner</span>
                  <select className="ui-select" value={newOwner} disabled={busy} onChange={(event) => setNewOwner(event.target.value)}>
                    {others.map((member) => <option key={member.student_id} value={member.student_id}>{member.display_name} (@{member.username})</option>)}
                  </select>
                </label>
              </>
            ) : kind === 'delete' ? (
              <>
                <p id={`${titleId}-copy`}>
                  This deletes {group.name} for all {memberCount}, along with its invite code and weekly goal. It can’t be undone.
                  Tasks in the group aren’t lost: each one becomes a personal task of the person who created it.
                </p>
                <label className="ui-field">
                  <span>Type <strong>{group.name}</strong> to confirm</span>
                  <input className="ui-input" value={typed} disabled={busy} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" onChange={(event) => setTyped(event.target.value)} />
                </label>
              </>
            ) : (
              <p id={`${titleId}-copy`}>You’re the only member, so leaving deletes {group.name}. Its tasks become your personal tasks.</p>
            )}
            {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}
          </div>
          <footer className="ui-dialog__footer">
            <button type="button" className="ui-button ui-button--ghost" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="submit" className={`ui-button ${kind === 'transfer' ? 'ui-button--primary' : 'ui-button--danger'}${busy ? ' is-busy' : ''}`} disabled={!ready || busy}>
              {kind === 'transfer' ? `Make ${chosen?.display_name ?? 'them'} owner` : kind === 'delete' ? 'Delete group' : 'Leave and delete'}
            </button>
          </footer>
        </form>
      </div>
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

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' })
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })

/* The last 14 days as two rows of dots, you over your friend; a day both studied is joined by a thread. */
function FriendStreakDetail({ id, friend, nudged, busy, onNudge }: {
  id: string
  friend: Friend
  nudged: boolean
  busy: boolean
  onNudge: () => void
}) {
  const name = firstName(friend.display_name)
  const tone = toneClass(toneForName(friend.display_name))
  const days = friend.streak_days.map((item) => ({ ...item, date: new Date(`${item.day}T00:00:00Z`) }))
  return (
    <div className="profile__streak-detail ui-tone--orange" id={id}>
      <p className="profile__streak-summary">
        <span className="profile__streak-number">{Icons.flame}{streakDays(friend.friend_streak)}</span>
        <span>{friend.best_friend_streak > friend.friend_streak ? `Best: ${streakDays(friend.best_friend_streak)}` : friend.friend_streak ? 'Your best yet' : 'No streak yet'}</span>
      </p>
      <table className="profile__streak-grid">
        <caption className="sr-only">Who studied on each of the last 14 days</caption>
        <thead>
          <tr>
            <td />
            {days.map((item, index) => (
              <th key={item.day} scope="col" className={index === days.length - 1 ? 'is-today' : undefined}>
                <abbr title={index === days.length - 1 ? `Today, ${longDay.format(item.date)}` : longDay.format(item.date)}>{weekday.format(item.date)}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">You</th>
            {days.map((item) => (
              <td key={item.day} className={item.me && item.friend ? 'is-shared' : undefined}>
                <span className={`profile__streak-dot${item.me ? ' is-on' : ''}`} />
                <span className="sr-only">{item.me ? 'studied' : 'no study'}</span>
              </td>
            ))}
          </tr>
          <tr className={tone}>
            <th scope="row">{name}</th>
            {days.map((item) => (
              <td key={item.day} className={item.me && item.friend ? 'is-shared' : undefined}>
                <span className={`profile__streak-dot is-friend${item.friend ? ' is-on' : ''}`} />
                <span className="sr-only">{item.friend ? 'studied' : 'no study'}</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="profile__streak-foot">
        <span className="profile__streak-status">{streakStatusLine(friend)}</span>
        {canNudge(friend) && friend.accepts_nudges !== false ? (
          <button className="ui-button ui-button--sm profile__nudge" type="button" disabled={busy || nudged} onClick={onNudge}>
            {nudged ? 'Reminder sent' : `Remind ${name} to study`}
          </button>
        ) : null}
      </div>
    </div>
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

function PlusMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
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
