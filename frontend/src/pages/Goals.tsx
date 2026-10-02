import { useEffect, useMemo, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import type { Profile, Progress, StudyGroup } from '../lib/api'
import { useData } from '../lib/dataSource'
import { notesFor, withCourseTones } from '../lib/session'
import { Icons } from '../components/Icons'
import './Goals.css'

type GoalStep = { id: string; title: string; detail: string; action: string; href: string; icon: keyof Pick<typeof Icons, 'sparkle' | 'target' | 'check'> }
const dayKey = () => new Date().toISOString().slice(0, 10)

function savedChecks(identity: string) {
  try { return JSON.parse(localStorage.getItem(`bindit:plan:${identity}:${dayKey()}`) ?? '[]') as string[] }
  catch { return [] }
}

export function Goals({ session }: { session: AuthSession | null }) {
  const data = useData()
  const studentId = session?.user.id ?? data.getStudentId()
  const [profile, setProfile] = useState<Profile | null>(() => session?.access_token ? data.getCachedProfile(session.access_token) : null)
  const [progress, setProgress] = useState<Progress | null>(() => data.getCachedProgress(studentId))
  const [groups, setGroups] = useState<StudyGroup[]>(() => session?.access_token ? data.getCachedStudyGroups(session.access_token) ?? [] : [])
  const [complete, setComplete] = useState<string[]>(() => savedChecks(studentId))
  const notebook = useMemo(() => {
    const loaded = data.loadNotebook()
    return { ...loaded, courses: withCourseTones(loaded.courses) }
  }, [data])

  useEffect(() => {
    if (!session?.access_token) return
    const token = session.access_token
    void Promise.all([data.getAccountProfile(token), data.getProgress(studentId, token), data.getStudyGroups(token)])
      .then(([nextProfile, nextProgress, nextGroups]) => { setProfile(nextProfile); setProgress(nextProgress); setGroups(nextGroups) })
      .catch(() => undefined)
  }, [data, session?.access_token, studentId])

  const activeCourse = notebook.activeCourse || notebook.courses[0]?.name || ''
  const activeUnit = notebook.activeUnit || notebook.courses.find((course) => course.name === activeCourse)?.units[0] || ''
  const notes = notesFor(notebook.deposits, activeCourse, activeUnit)
  const weakTopic = progress?.weak_topics[0]?.replaceAll('_', ' ')
  const steps: GoalStep[] = [
    notes.length
      ? { id: 'review', title: `Review ${activeUnit || activeCourse}`, detail: `Use the flashcards generated from ${notes.length} ${notes.length === 1 ? 'source' : 'sources'}.`, action: 'Review cards', href: '#tools', icon: 'sparkle' }
      : { id: 'notes', title: 'Add a source to study', detail: activeUnit ? `Upload notes for ${activeUnit} so Bindit can build grounded practice.` : 'Create a unit and upload your first set of notes.', action: 'Add notes', href: '#tools', icon: 'sparkle' },
    { id: 'quiz', title: weakTopic ? `Strengthen ${weakTopic}` : `Quiz ${activeUnit || activeCourse || 'a course'}`, detail: weakTopic ? 'A short quiz will focus on the area that needs the most attention.' : 'Answer a focused question and keep your learning streak moving.', action: 'Start quiz', href: '#tools', icon: 'target' },
    { id: 'reflect', title: 'Check your progress', detail: 'Review your mastery map and choose the next unit worth your time.', action: 'View progress', href: '#progress', icon: 'check' },
  ]
  const completedCount = steps.filter((step) => complete.includes(step.id)).length
  const completion = Math.round(completedCount / steps.length * 100)
  const leadingGroup = groups.toSorted((a, b) => b.weekly_xp - a.weekly_xp)[0]

  function toggleStep(id: string) {
    setComplete((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      localStorage.setItem(`bindit:plan:${studentId}:${dayKey()}`, JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="ui-page goals-page">
      <header className="ui-page-header goals-page__header">
        <div><span className="goals-page__eyebrow">Daily study plan</span><h1 className="ui-page-title">Make today count.</h1><p className="ui-page-subtitle">A focused plan built from what you are studying—not another endless task list.</p></div>
        <div className="goals-page__completion" aria-label={`${completion}% of today's plan complete`}><strong>{completion}%</strong><span>complete</span></div>
      </header>
      <section className="goals-page__hero" aria-labelledby="today-plan-title">
        <div className="goals-page__hero-copy">
          <span className="goals-page__date">Today · {profile?.daily_goal ?? 20} XP target</span><h2 id="today-plan-title">Three small wins.</h2>
          <p>Finish this sequence in order or jump to the step that matters most. Your plan resets each day.</p>
          <div className="ui-meter goals-page__meter" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={completedCount}><span style={{ width: `${completion}%` }} /></div>
          <span className="goals-page__meter-label">{completedCount} of {steps.length} finished</span>
        </div>
        <img src="/bindit-mascot-cutout.webp" alt="Bindit's otter mascot holding a binder" />
      </section>
      <section className="goals-page__plan" aria-label="Today's study plan">
        {steps.map((step, index) => {
          const done = complete.includes(step.id)
          return <article key={step.id} className={`goals-page__step${done ? ' is-complete' : ''}`}>
            <button className="goals-page__check" type="button" aria-label={`${done ? 'Mark incomplete' : 'Mark complete'}: ${step.title}`} aria-pressed={done} onClick={() => toggleStep(step.id)}>{done ? Icons.check : <span>{index + 1}</span>}</button>
            <span className="goals-page__step-icon" aria-hidden="true">{Icons[step.icon]}</span>
            <div className="goals-page__step-copy"><h3>{step.title}</h3><p>{step.detail}</p></div><a className="ui-button" href={step.href}>{step.action}</a>
          </article>
        })}
      </section>
      <section className="goals-page__signals" aria-label="Goal signals">
        <article className="goals-page__signal"><span className="goals-page__signal-icon ui-tone--orange">{Icons.flame}</span><div><span>Learning streak</span><strong>{progress?.login_streak ?? 0} {progress?.login_streak === 1 ? 'day' : 'days'}</strong></div></article>
        <article className="goals-page__signal"><span className="goals-page__signal-icon ui-tone--violet">{Icons.sparkle}</span><div><span>Active focus</span><strong>{activeUnit || activeCourse || 'Add a course'}</strong></div></article>
        <article className="goals-page__signal"><span className="goals-page__signal-icon ui-tone--green">{Icons.users}</span><div><span>{leadingGroup ? leadingGroup.name : 'Study together'}</span><strong>{leadingGroup ? `${leadingGroup.weekly_xp} / ${leadingGroup.weekly_goal_xp} XP` : 'Create a group'}</strong></div></article>
      </section>
    </div>
  )
}
