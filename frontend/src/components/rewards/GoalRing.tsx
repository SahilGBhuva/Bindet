import { useEffect, useState } from 'react'
import './GoalRing.css'

/*
 * Home's daily goal as a ring that fills smoothly (stroke-dashoffset), with an optional
 * one-time "Goal done! 🎉" burst (Home decides when: once a day, lib/rewards.claimGoalBurst).
 * Decorative: the card's text says the numbers, so the ring is hidden from screen readers.
 */

const SIZE = 48
const STROKE = 5
const RADIUS = (SIZE - STROKE) / 2
const LENGTH = 2 * Math.PI * RADIUS

export function GoalRing({ percent, burst = false }: { percent: number; burst?: boolean }) {
  // Starts empty and fills to the value after the first paint, so the fill is seen.
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShown(Math.min(100, Math.max(0, percent))))
    return () => window.cancelAnimationFrame(frame)
  }, [percent])
  const done = percent >= 100

  return (
    <span className={`goal-ring${done ? ' is-done' : ''}${burst ? ' is-bursting' : ''}`} aria-hidden="true">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
        <circle className="goal-ring__track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} />
        <circle
          className="goal-ring__fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          strokeDasharray={LENGTH}
          strokeDashoffset={LENGTH * (1 - shown / 100)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="goal-ring__label">{done ? '✓' : `${Math.round(percent)}%`}</span>
      {burst ? (
        <span className="goal-ring__burst">
          {Array.from({ length: 8 }, (_, index) => <span key={index} className="goal-ring__spark" style={{ ['--angle' as string]: `${index * 45}deg` }} />)}
          <span className="goal-ring__toast">Goal done! 🎉</span>
        </span>
      ) : null}
    </span>
  )
}
