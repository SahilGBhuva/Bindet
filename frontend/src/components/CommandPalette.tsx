import { useEffect, useRef, useState } from 'react'
import type { Screen } from '../lib/SiteSidebar'
import './CommandPalette.css'

const COMMANDS: Array<{ id: Screen; label: string; detail: string; keywords: string }> = [
  { id: 'home', label: 'Home', detail: 'Your study overview', keywords: 'dashboard overview' },
  { id: 'tools', label: 'Upload notes', detail: 'Add notes, build flashcards, or start a quiz', keywords: 'tools upload quiz flashcards' },
  { id: 'progress', label: 'Progress', detail: 'XP, streaks, and mastery', keywords: 'stats xp streak mastery' },
  { id: 'goals', label: 'Goals', detail: 'Daily and weekly targets', keywords: 'quests daily weekly' },
  { id: 'chat', label: 'Study chat', detail: 'Message your groups', keywords: 'groups friends messages' },
  { id: 'profile', label: 'Friends & profile', detail: 'People, groups, and your identity', keywords: 'social account groups' },
  { id: 'settings', label: 'Settings', detail: 'Account and preferences', keywords: 'account preferences' },
  { id: 'games', label: 'Games', detail: 'Practice modes', keywords: 'play arcade' },
]

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const normalized = query.trim().toLowerCase()
  const results = normalized
    ? COMMANDS.filter((command) => `${command.label} ${command.detail} ${command.keywords}`.toLowerCase().includes(normalized))
    : COMMANDS

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20)
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', closeOnEscape) }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="command-menu" role="dialog" aria-modal="true" aria-label="Quick navigation">
        <div className="command-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages and actions…" />
          <kbd>esc</kbd>
        </div>
        <div className="command-results">
          <span className="command-label">Navigate</span>
          {results.map((command) => (
            <a key={command.id} href={`#${command.id}`} onClick={onClose}>
              <span>{command.label.slice(0, 1)}</span>
              <div><strong>{command.label}</strong><small>{command.detail}</small></div>
              <kbd>↵</kbd>
            </a>
          ))}
          {!results.length ? <div className="command-empty">No matching pages</div> : null}
        </div>
        <footer><span>Tip: press <kbd>⌘ K</kbd> from anywhere</span><span>bindit command bar</span></footer>
      </section>
    </div>
  )
}
