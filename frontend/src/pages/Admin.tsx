import { useEffect, useState, type FormEvent } from 'react'
import type { AuthSession } from '../lib/auth'
import { getAdminFeedback, type FeedbackEntry } from '../lib/practiceLab'
import { planBadge } from '../lib/planLabels'
import { getAdminAccess, grantPlan, listPlanGrants, revokePlan, type AdminAccess, type PlanGrant } from '../lib/plans'
import './Admin.css'

/*
 * #admin, for the bindet team only. Not linked from anywhere. The server decides who may
 * open it (/api/admin/access): accounts in OWNER_EMAILS or ADMIN_EMAILS manage Pro access,
 * and only ADMIN_EMAILS also read feedback. Everyone else gets a 404 and this page says
 * only that there is nothing here.
 */
export function Admin({ session }: { session: AuthSession | null }) {
  const token = session?.access_token
  const [access, setAccess] = useState<AdminAccess | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'hidden'>(token ? 'loading' : 'hidden')

  useEffect(() => {
    if (!token) return
    let live = true
    getAdminAccess(token)
      .then((data) => { if (live) { setAccess(data); setState('ready') } })
      .catch(() => { if (live) setState('hidden') })
    return () => { live = false }
  }, [token])

  if (state === 'loading') return <div className="ui-page" aria-busy="true" />
  if (state === 'hidden' || !access || !token) {
    return (
      <div className="ui-page">
        <div className="ui-empty">
          <h1 className="ui-empty__title">Nothing here</h1>
          <p className="ui-empty__copy">This page doesn’t exist.</p>
          <a className="ui-button" href="#home">Go home</a>
        </div>
      </div>
    )
  }

  return (
    <div className="ui-page admin">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Team only</span>
          <h1 className="ui-page-title">Admin</h1>
          <p className="ui-page-subtitle">{access.feedback ? 'Pro access and the latest feedback.' : 'Give and remove Pro access.'}</p>
        </div>
      </header>
      {access.plans ? <PlanAccess token={token} /> : null}
      {access.feedback ? <FeedbackList token={token} /> : null}
    </div>
  )
}

function PlanAccess({ token }: { token: string }) {
  const [grants, setGrants] = useState<PlanGrant[] | null>(null)
  const [email, setEmail] = useState('')
  const [plan, setPlan] = useState<PlanGrant['plan']>('pro')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    let live = true
    listPlanGrants(token)
      .then((data) => { if (live) setGrants(data) })
      .catch(() => { if (live) { setGrants([]); setStatus('Couldn’t load the list. Refresh to try again.') } })
    return () => { live = false }
  }, [token])

  async function give(event: FormEvent) {
    event.preventDefault()
    if (busy || !email.trim()) return
    setBusy(true)
    setStatus('')
    try {
      const saved = await grantPlan({ email: email.trim(), plan, note: note.trim() || undefined }, token)
      setGrants((list) => [saved, ...(list ?? []).filter((grant) => grant.email !== saved.email)])
      setStatus(`${saved.email} now has ${planBadge(saved.plan)}.`)
      setEmail('')
      setNote('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Couldn’t save that.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(grant: PlanGrant) {
    setStatus('')
    try {
      await revokePlan(grant.email, token)
      setGrants((list) => (list ?? []).filter((item) => item.email !== grant.email))
      setStatus(`Removed ${planBadge(grant.plan)} from ${grant.email}.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Couldn’t remove that.')
    }
  }

  return (
    <section className="admin__section" aria-labelledby="admin-plans">
      <h2 id="admin-plans" className="admin__heading">Pro access</h2>
      <p className="admin__lead">
        Pro triples the AI limits. Unlimited removes per-student limits for people you trust, like teammates and testers; the daily
        limit across bindet still applies. Neither gives admin access. It starts once the person signs in with this email and confirms it.
      </p>
      <form className="ui-panel admin__form" onSubmit={give}>
        <label className="admin__field">
          <span>Email</span>
          <input className="ui-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} autoComplete="off" placeholder="name@example.com" />
        </label>
        <label className="admin__field admin__field--plan">
          <span>Plan</span>
          <select className="ui-select" value={plan} onChange={(event) => setPlan(event.target.value as PlanGrant['plan'])}>
            <option value="pro">Pro</option>
            <option value="unlimited">Unlimited</option>
          </select>
        </label>
        <label className="admin__field">
          <span>Note (optional)</span>
          <input className="ui-input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Beta tester" />
        </label>
        <button className={`ui-button ui-button--primary${busy ? ' is-busy' : ''}`} type="submit" disabled={busy}>Give {plan === 'pro' ? 'Pro' : 'Unlimited'}</button>
      </form>
      <p className="admin__status" role="status">{status}</p>
      {grants === null ? (
        <p className="admin__empty">Loading…</p>
      ) : grants.length ? (
        <ul className="ui-panel ui-list admin__list">
          {grants.map((grant) => (
            <li key={grant.email} className="admin__grant">
              <div className="admin__grant-text">
                <span className="admin__grant-email">{grant.email}</span>
                <span className="admin__meta">
                  <span className={`ui-badge ui-badge--tone ${grant.plan === 'pro' ? 'ui-tone--violet' : 'ui-tone--teal'}`}>{planBadge(grant.plan)}</span>
                  {grant.note ? <span>{grant.note}</span> : null}
                  <time dateTime={grant.granted_at}>{new Date(grant.granted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
                </span>
              </div>
              <button className="ui-button ui-button--ghost ui-button--sm" type="button" onClick={() => void remove(grant)} aria-label={`Remove ${planBadge(grant.plan)} from ${grant.email}`}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin__empty">Nobody has Pro yet.</p>
      )}
    </section>
  )
}

function FeedbackList({ token }: { token: string }) {
  const [entries, setEntries] = useState<FeedbackEntry[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    getAdminFeedback(token)
      .then((data) => { if (live) setEntries(data) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [token])

  return (
    <section className="admin__section" aria-labelledby="admin-feedback">
      <h2 id="admin-feedback" className="admin__heading">Feedback</h2>
      {failed ? (
        <p className="admin__empty">Couldn’t load feedback. Refresh to try again.</p>
      ) : entries === null ? (
        <p className="admin__empty">Loading…</p>
      ) : entries.length ? (
        <>
          <p className="admin__lead">The latest {entries.length} {entries.length === 1 ? 'message' : 'messages'}, newest first.</p>
          <ul className="ui-panel ui-list admin__list">
            {entries.map((entry) => (
              <li key={entry.id} className="admin__item">
                <div className="admin__meta">
                  <span className={`ui-badge ${entry.category === 'bug' ? 'ui-badge--danger' : entry.category === 'idea' ? 'ui-badge--accent' : ''}`}>{entry.category}</span>
                  <span>{entry.display_name || 'Deleted account'}{entry.username ? ` · @${entry.username}` : ''}</span>
                  <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time>
                </div>
                <p className="admin__message">{entry.message}</p>
                {entry.device || entry.page ? (
                  <p className="admin__device">
                    {[entry.page ? `Page: ${entry.page}` : '', entry.device?.browser, entry.device?.os, entry.device?.screen ? `Screen ${entry.device.screen}` : '', entry.device?.viewport ? `Window ${entry.device.viewport}` : '']
                      .filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="admin__empty">No feedback yet.</p>
      )}
    </section>
  )
}
