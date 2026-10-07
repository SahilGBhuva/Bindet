import { useEffect, useRef, useState } from 'react'
import type { Screen } from '../lib/screens'
import { NavIcon } from '../lib/SiteSidebar'
import './CommandPalette.css'

type Command = { id: string; screen: Screen; href: string; label: string; detail: string; keywords: string; group: 'Go to' | 'Do' }

const COMMANDS: Command[] = [
  { id: 'new-assignment', screen: 'goals', href: '#goals?new', label: 'New assignment', detail: 'Add something with a due date', keywords: 'task todo homework create add', group: 'Do' },
  { id: 'ask-tutor', screen: 'tutor', href: '#tutor', label: 'Ask the tutor', detail: 'Get an explanation grounded in your notes', keywords: 'ai help explain question chat', group: 'Do' },
  { id: 'upload', screen: 'tools', href: '#tools', label: 'Add notes', detail: 'Upload a PDF, photo, or document to a unit', keywords: 'upload notes pdf photo image file', group: 'Do' },
  { id: 'home', screen: 'home', href: '#home', label: 'Home', detail: 'Your next step and what is due', keywords: 'dashboard overview today', group: 'Go to' },
  { id: 'tools', screen: 'tools', href: '#tools', label: 'Study', detail: 'Courses, units, notes, flashcards, and quizzes', keywords: 'courses units flashcards quiz practice tools', group: 'Go to' },
  { id: 'tutor', screen: 'tutor', href: '#tutor', label: 'Tutor', detail: 'Conversations with your AI tutor', keywords: 'ai chat', group: 'Go to' },
  { id: 'goals', screen: 'goals', href: '#goals', label: 'Assignments', detail: 'Everything due, by status', keywords: 'tasks board todo due', group: 'Go to' },
  { id: 'progress', screen: 'progress', href: '#progress', label: 'Progress', detail: 'Mastery, XP, and streaks', keywords: 'stats xp streak mastery', group: 'Go to' },
  { id: 'chat', screen: 'chat', href: '#chat', label: 'Messages', detail: 'Study group conversations', keywords: 'groups friends messages chat', group: 'Go to' },
  { id: 'profile', screen: 'profile', href: '#profile', label: 'Friends & groups', detail: 'People, groups, and your profile', keywords: 'social account groups friends', group: 'Go to' },
  { id: 'games', screen: 'games', href: '#games', label: 'Practice lab', detail: 'Study games (coming soon)', keywords: 'play arcade games', group: 'Go to' },
  { id: 'settings', screen: 'settings', href: '#settings', label: 'Settings', detail: 'Account, theme, and preferences', keywords: 'account preferences theme dark light', group: 'Go to' },
  { id: 'more', screen: 'more', href: '#more', label: 'Help', detail: 'Guides and feedback', keywords: 'help about feedback', group: 'Go to' },
]

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <Palette onClose={onClose} />
}

function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const normalized = query.trim().toLowerCase()
  const results = normalized
    ? COMMANDS.filter((command) => `${command.label} ${command.detail} ${command.keywords}`.toLowerCase().includes(normalized))
    : COMMANDS
  const active = Math.min(cursor, Math.max(0, results.length - 1))

  useEffect(() => {
    inputRef.current?.focus()
    // Captured on window before anything else sees it, and consumed: Esc closes only the
    // palette, not also the task panel or drawer underneath (they ignore handled keys).
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])

  const go = (command: Command | undefined) => {
    if (!command) return
    window.location.hash = command.href.slice(1)
    onClose()
  }

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="command-menu" role="dialog" aria-modal="true" aria-label="Search bindit">
        <div className="command-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => Math.min(value + 1, results.length - 1)) }
              if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => Math.max(value - 1, 0)) }
              if (event.key === 'Enter') { event.preventDefault(); go(results[active]) }
            }}
            placeholder="Search pages and actions"
            aria-label="Search pages and actions"
            type="search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-results" id="command-results" role="listbox">
          {(['Do', 'Go to'] as const).map((group) => {
            const items = results.filter((command) => command.group === group)
            if (!items.length) return null
            return (
              <div key={group} role="group" aria-label={group}>
                <span className="command-label">{group}</span>
                {items.map((command) => {
                  const index = results.indexOf(command)
                  return (
                    <a
                      key={command.id}
                      id={`command-${command.id}`}
                      role="option"
                      aria-selected={index === active}
                      className={index === active ? 'is-active' : ''}
                      href={command.href}
                      onMouseMove={() => setCursor(index)}
                      onClick={(event) => { event.preventDefault(); go(command) }}
                    >
                      <span><NavIcon kind={command.screen} /></span>
                      <div><strong>{command.label}</strong><small>{command.detail}</small></div>
                    </a>
                  )
                })}
              </div>
            )
          })}
          {!results.length ? <div className="command-empty">Nothing matches “{query}”.</div> : null}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open</span><span><kbd>⌘</kbd><kbd>K</kbd> anywhere</span></footer>
      </section>
    </div>
  )
}
