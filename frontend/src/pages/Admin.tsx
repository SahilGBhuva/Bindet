import { useEffect, useState } from 'react'
import type { AuthSession } from '../lib/auth'
import { getAdminFeedback, type FeedbackEntry } from '../lib/practice'
import './Admin.css'

/*
 * #admin: the latest feedback, for the bindit team only. Not linked from anywhere. The
 * server decides who may read it (ADMIN_EMAILS); for everyone else it answers 404 and
 * this page says only that there is nothing here.
 */
export function Admin({ session }: { session: AuthSession | null }) {
  const token = session?.access_token
  const [entries, setEntries] = useState<FeedbackEntry[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'hidden'>(token ? 'loading' : 'hidden')

  useEffect(() => {
    if (!token) return
    let live = true
    getAdminFeedback(token)
      .then((data) => { if (live) { setEntries(data); setState('ready') } })
      .catch(() => { if (live) setState('hidden') })
    return () => { live = false }
  }, [token])

  if (state === 'loading') return <div className="ui-page" aria-busy="true" />
  if (state === 'hidden' || !entries) {
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
          <h1 className="ui-page-title">Feedback</h1>
          <p className="ui-page-subtitle">The latest {entries.length} {entries.length === 1 ? 'message' : 'messages'}, newest first.</p>
        </div>
      </header>
      {entries.length ? (
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
      ) : (
        <p className="admin__empty">No feedback yet.</p>
      )}
    </div>
  )
}
