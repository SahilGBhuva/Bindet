import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import {
  addOttoMemoryItem, clearOttoMemory, deleteOttoMemoryItem, editOttoMemoryItem, getCachedOttoProfile, getOttoMemory, getOttoProfile,
  OTTO_MEMORY_CHANGED_EVENT, saveOttoProfile, type OttoMemory, type OttoMemoryItem,
} from '../../lib/api'
import { useData } from '../../lib/dataSource'
import { DEFAULT_OTTO_PROFILE } from './ottoDefaults'
import './Otto.css'

/*
 * "What Otto remembers": the switch that lets Otto keep notes about the student, the
 * notes themselves (delete one, edit, add, clear all). With the switch off Otto neither
 * reads nor saves anything; what is already saved stays visible here until deleted.
 */
export function OttoMemoryPanel({ token }: { token: string }) {
  const data = useData()
  const id = useId()
  const live = Boolean(token) && !data.sandboxed
  const [memory, setMemory] = useState<OttoMemory | null>(() => live ? null : { enabled: true, items: [], limits: { max_items: 20, max_chars: 1500, item_max_chars: 120 } })
  const [enabled, setEnabled] = useState(() => (live ? getCachedOttoProfile(token)?.memory_enabled : undefined) ?? true)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(() => {
    if (!live) return
    void getOttoMemory(token).then((value) => { setMemory(value); setEnabled(value.enabled); setFailed(false) }).catch(() => setFailed(true))
  }, [live, token])

  useEffect(() => {
    load()
    window.addEventListener(OTTO_MEMORY_CHANGED_EVENT, load)
    return () => window.removeEventListener(OTTO_MEMORY_CHANGED_EVENT, load)
  }, [load])

  async function run(action: () => Promise<void>, done?: string) {
    if (!live || busy) return
    setBusy(true)
    setStatus(null)
    try {
      await action()
      if (done) setStatus({ kind: 'ok', text: done })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'That didn’t work. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const toggle = () => run(async () => {
    const next = !enabled
    setEnabled(next)
    try {
      const profile = getCachedOttoProfile(token) ?? await getOttoProfile(token).catch(() => DEFAULT_OTTO_PROFILE)
      await saveOttoProfile(token, { ...profile, memory_enabled: next })
      setMemory((current) => current ? { ...current, enabled: next } : current)
    } catch (error) {
      setEnabled(!next)
      throw error
    }
  }, enabled ? 'Otto won’t read or save notes about you.' : 'Otto can remember helpful things about you again.')

  const add = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    void run(async () => {
      const item = await addOttoMemoryItem(token, text)
      setMemory((current) => current ? { ...current, items: [...current.items, item] } : current)
      setDraft('')
    }, 'Added.')
  }

  const saveEdit = (event: FormEvent) => {
    event.preventDefault()
    if (!editing) return
    const text = editing.text.trim()
    void run(async () => {
      const item = await editOttoMemoryItem(token, editing.id, text)
      setMemory((current) => current ? { ...current, items: current.items.map((entry) => entry.id === item.id ? item : entry) } : current)
      setEditing(null)
    }, 'Updated.')
  }

  const remove = (item: OttoMemoryItem) => run(async () => {
    const previous = memory
    setMemory((current) => current ? { ...current, items: current.items.filter((entry) => entry.id !== item.id) } : current)
    try {
      await deleteOttoMemoryItem(token, item.id)
    } catch (error) {
      setMemory(previous)
      throw error
    }
  }, 'Deleted.')

  const clear = () => {
    if (!memory?.items.length || !data.confirm('Delete everything Otto remembers about you?')) return
    void run(async () => {
      await clearOttoMemory(token)
      setMemory((current) => current ? { ...current, items: [] } : current)
    }, 'Otto’s memory is cleared.')
  }

  const items = memory?.items ?? []
  const limits = memory?.limits

  return (
    <div className="otto-memory">
      <label className="otto-memory__switch">
        <span className="otto-memory__switch-text">
          <b>Let Otto remember things about me</b>
          <small>Otto keeps a few short study notes, like your courses or an upcoming test, to make help more useful. They’re sent to the AI with your tutor messages.</small>
        </span>
        <input className="ui-checkbox" type="checkbox" role="switch" checked={enabled} disabled={!live || busy || !memory} onChange={() => void toggle()} />
      </label>

      {failed ? (
        <div className="ui-alert" role="alert"><span>Otto’s memory couldn’t be loaded.</span><button type="button" className="ui-button ui-button--sm" onClick={() => { setFailed(false); load() }}>Try again</button></div>
      ) : memory === null ? (
        <div className="otto-memory__skeleton" aria-label="Loading">{[0, 1, 2].map((key) => <span key={key} className="ui-skeleton" />)}</div>
      ) : (
        <>
          <div className="otto-memory__head">
            <h3 id={`${id}-list`}>What Otto remembers</h3>
            {limits ? <span className="otto-memory__count">{items.length} of {limits.max_items}</span> : null}
          </div>
          {items.length ? (
            <ul className="otto-memory__list" aria-labelledby={`${id}-list`}>
              {items.map((item) => (
                <li key={item.id} className="otto-memory__item">
                  {editing?.id === item.id ? (
                    <form className="otto-memory__edit" onSubmit={saveEdit}>
                      <input className="ui-input" aria-label="Edit this note" value={editing.text} maxLength={limits?.item_max_chars ?? 120}
                        autoFocus onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setEditing(null) } }} />
                      <button type="submit" className="ui-button ui-button--sm ui-button--primary" disabled={busy || !editing.text.trim()}>Save</button>
                      <button type="button" className="ui-button ui-button--sm ui-button--ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <span className="otto-memory__text">{item.text}<small>{item.source === 'otto' ? 'Otto saved' : 'You added'}</small></span>
                      <span className="otto-memory__actions">
                        <button type="button" className="ui-button ui-button--sm ui-button--ghost" disabled={!live || !enabled || busy} onClick={() => setEditing({ id: item.id, text: item.text })} aria-label={`Edit “${item.text}”`}>Edit</button>
                        <button type="button" className="ui-button ui-button--sm ui-button--ghost" disabled={!live || busy} onClick={() => void remove(item)} aria-label={`Delete “${item.text}”`}>Delete</button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="otto-memory__empty">{enabled ? 'Nothing yet. As you chat, Otto may save things like your grade, your courses or a test date. You can also add one below.' : 'Nothing saved. Memory is off.'}</p>
          )}
          {enabled ? (
            <form className="otto-memory__add" onSubmit={add}>
              <input className="ui-input" aria-label="Add something for Otto to remember" placeholder="Add a note, like “taking AP Biology”" value={draft}
                maxLength={limits?.item_max_chars ?? 120} disabled={!live || busy} onChange={(event) => setDraft(event.target.value)} enterKeyHint="done" />
              <button type="submit" className="ui-button" disabled={!live || busy || !draft.trim()}>Add</button>
            </form>
          ) : null}
          <div className="otto-memory__footer">
            {status ? <p className={`otto-prefs__status${status.kind === 'error' ? ' is-error' : ''}`} role={status.kind === 'error' ? 'alert' : 'status'}>{status.text}</p> : <span />}
            <button type="button" className="ui-button ui-button--sm ui-button--ghost otto-memory__clear" disabled={!live || busy || !items.length} onClick={clear}>Clear all</button>
          </div>
          <p className="otto-prefs__hint">Otto never keeps contact details, where you live, health, religion, politics, relationships or anything about other people.</p>
        </>
      )}
    </div>
  )
}
