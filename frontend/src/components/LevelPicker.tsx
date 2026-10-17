import { useId } from 'react'
import { LEVEL_INFO, LEVELS } from '../lib/levels'
import type { Level } from '../lib/levels'
import './LevelPicker.css'

/*
 * Easy · Medium · Hard as one group of native radio buttons (so arrow keys and screen
 * readers work as usual), each a small card with a colored icon chip and a one-line
 * description. Green, amber and red tell the levels apart. Used by the practice test
 * setup screen and the flashcards view; `className` lets each place allowlist or style it.
 */

type Props = {
  // null: none of the three (a deck made with the student's own instructions, or mixed).
  value: Level | null
  onChange: (level: Level) => void
  // Which one-line description to show under each label.
  kind: 'test' | 'cards'
  legend: string
  disabled?: boolean
  className?: string
  // Shown after the legend, e.g. the level the deck is at now.
  note?: string
}

/* Signal bars: one, two or three filled, so the level reads without color too. */
export function LevelIcon({ level }: { level: Level }) {
  const filled = LEVELS.indexOf(level) + 1
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="level-icon">
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={4 + index * 6}
          y={15 - index * 5}
          width="4"
          height={5 + index * 5}
          rx="1"
          className={index < filled ? 'is-on' : ''}
        />
      ))}
    </svg>
  )
}

/* A small colored chip naming a level (history rows, results, the deck). */
export function LevelChip({ level, className = '' }: { level: Level; className?: string }) {
  return (
    <span className={`level-chip level--${LEVEL_INFO[level].tone} ${className}`.trim()}>
      <LevelIcon level={level} />
      {LEVEL_INFO[level].label}
    </span>
  )
}

export function LevelPicker({ value, onChange, kind, legend, disabled, className = '', note }: Props) {
  const name = useId()
  return (
    <fieldset className={`level-picker ${className}`.trim()} disabled={disabled}>
      <legend className="level-picker__legend">
        {legend}
        {note ? <span className="level-picker__note">{note}</span> : null}
      </legend>
      <div className="level-picker__options">
        {LEVELS.map((level) => {
          const info = LEVEL_INFO[level]
          const id = `${name}-${level}`
          return (
            <label key={level} htmlFor={id} className={`level-picker__option level--${info.tone}${value === level ? ' is-on' : ''}`}>
              <input
                id={id}
                className="sr-only"
                type="radio"
                name={name}
                value={level}
                checked={value === level}
                onChange={() => onChange(level)}
                aria-describedby={`${id}-desc`}
              />
              <span className="level-picker__chip" aria-hidden="true"><LevelIcon level={level} /></span>
              <span className="level-picker__text">
                <span className="level-picker__label">{info.label}</span>
                <span className="level-picker__desc" id={`${id}-desc`}>{kind === 'test' ? info.test : info.cards}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
