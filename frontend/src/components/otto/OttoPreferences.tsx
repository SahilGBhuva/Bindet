import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  getCachedOttoProfile, getOttoProfile, OTTO_ABOUT_MAX, OTTO_NAME_MAX, OTTO_PERSONALITIES, saveOttoProfile,
  type OttoPersonality, type OttoProfile,
} from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { DEFAULT_OTTO_PROFILE } from './ottoDefaults'
import './Otto.css'

/*
 * "How Otto talks to you": the name Otto uses, one of Otto's fixed personalities, and an
 * optional note about the student. Reusable: Settings shows the full form, the Otto page's
 * Personalize sheet and (later) onboarding embed the compact one. In the landing demo
 * (sandboxed data) it renders the defaults and never loads or saves anything.
 */

type Props = {
  token: string
  /* Suggested name (the profile's display name) shown until the student picks one. */
  defaultName?: string
  variant?: 'full' | 'compact'
  onSaved?: (profile: OttoProfile) => void
}

export function OttoPreferences({ token, defaultName = '', variant = 'full', onSaved }: Props) {
  const data = useData()
  const id = useId()
  const live = Boolean(token) && !data.sandboxed
  const [saved, setSaved] = useState<OttoProfile | null>(() => (live ? getCachedOttoProfile(token) : null))
  const [form, setForm] = useState<OttoProfile>(() => saved ?? DEFAULT_OTTO_PROFILE)
  const [loading, setLoading] = useState(live && !saved)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!live) return
    let active = true
    void getOttoProfile(token).then((profile) => {
      if (!active) return
      setSaved(profile)
      setForm(profile)
    }).catch(() => { if (active) setStatus({ kind: 'error', text: 'Could not load your Otto settings. Try again in a moment.' }) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [live, token])

  const changed = !saved || saved.preferred_name !== form.preferred_name || saved.personality !== form.personality || saved.about !== form.about
  const compact = variant === 'compact'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!live || busy) return
    setBusy(true)
    setStatus(null)
    try {
      // The memory switch lives in the memory panel; keep whatever is saved.
      const next = await saveOttoProfile(token, { ...form, memory_enabled: saved?.memory_enabled ?? true })
      setSaved(next)
      setForm(next)
      setStatus({ kind: 'ok', text: 'Saved. Otto will use this from your next message.' })
      onSaved?.(next)
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Could not save. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={`otto-prefs${compact ? ' otto-prefs--compact' : ''}`} onSubmit={(event) => void submit(event)} aria-busy={loading}>
      <label className="ui-field" htmlFor={`${id}-name`}>
        <span>What should Otto call you?</span>
        <input
          id={`${id}-name`}
          className="ui-input"
          value={form.preferred_name}
          placeholder={defaultName ? `${defaultName.split(/\s+/)[0]}` : 'Your first name or a nickname'}
          maxLength={OTTO_NAME_MAX}
          autoComplete="nickname"
          autoCapitalize="words"
          enterKeyHint="done"
          disabled={!live || loading}
          onChange={(event) => setForm({ ...form, preferred_name: event.target.value })}
        />
      </label>

      <fieldset className="otto-prefs__personalities" disabled={!live || loading}>
        <legend>Otto’s personality</legend>
        <div className="otto-prefs__choices">
          {OTTO_PERSONALITIES.map((item) => (
            <label key={item.id} className="otto-prefs__choice">
              <input
                type="radio"
                name={`${id}-personality`}
                value={item.id}
                checked={form.personality === item.id}
                onChange={() => setForm({ ...form, personality: item.id as OttoPersonality })}
              />
              <span><b>{item.label}</b>{compact ? null : <small>{item.hint}</small>}</span>
            </label>
          ))}
        </div>
        <p className="otto-prefs__hint">Personality changes Otto’s tone only. Otto’s study and safety rules stay the same.</p>
      </fieldset>

      <label className="ui-field" htmlFor={`${id}-about`}>
        <span>Anything else Otto should know about you? <em>(optional)</em></span>
        <textarea
          id={`${id}-about`}
          className="ui-textarea"
          rows={compact ? 2 : 3}
          value={form.about}
          maxLength={OTTO_ABOUT_MAX}
          placeholder="For example: I’m in 10th grade and like worked examples."
          disabled={!live || loading}
          aria-describedby={`${id}-about-hint`}
          onChange={(event) => setForm({ ...form, about: event.target.value })}
        />
        <small id={`${id}-about-hint`} className="otto-prefs__hint">
          {form.about.length}/{OTTO_ABOUT_MAX} · Leave out private details like your address, phone or passwords.
        </small>
      </label>

      <div className="otto-prefs__footer">
        {status ? <p className={`otto-prefs__status${status.kind === 'error' ? ' is-error' : ''}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p> : null}
        <button type="submit" className={`ui-button ui-button--primary${busy ? ' is-busy' : ''}`} disabled={!live || loading || busy || !changed}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

/* The compact form, for the Otto page's Personalize sheet and onboarding. */
export function OttoPreferencesCompact(props: Omit<Props, 'variant'>) {
  return <OttoPreferences {...props} variant="compact" />
}
