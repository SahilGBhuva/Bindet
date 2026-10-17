import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { announce } from '../../lib/announce'
import {
  addToBursts, comboLabel, comboTier, isComboMilestone, isDuplicateXp, onRewards,
  type Anchor, type Burst, type RewardSignal, type SeenXp,
} from '../../lib/rewards'
import { noteUserGesture, playSound } from '../../lib/sounds'
import './RewardLayer.css'

/*
 * Reward feedback for the whole signed-in app, mounted once in the app shell:
 *  - "+10 XP" chips that float up from where the student just answered (phones: from the top
 *    of the screen, so they never sit over the answer buttons), batched when rewards arrive
 *    together;
 *  - "🔥 3 in a row!" combo chips (visual only, see lib/rewards.ts);
 *  - a full-screen level-up celebration with the otter, a "Keep going" button and auto-dismiss;
 *  - optional sounds (lib/sounds.ts, off by default) and screen-reader announcements.
 *
 * Listens to lib/rewards.ts (pages, after a successful action) and to window 'bindet:rewards'
 * (the server's own reward events). While a modal dialog is open (Instant Study) the layer
 * renders inside it, so it shows above the dialog and its button stays usable.
 * Motion is transform and opacity only; under prefers-reduced-motion the chips only fade and
 * the level-up is a plain card without confetti.
 */

const BURST_MS = 1700
const LEVEL_AUTO_CLOSE_MS = 6500
// An answer's anchor is used while the response is this fresh (AI grading can take a few seconds).
const ANCHOR_FRESH_MS = 20_000
const PHONE = '(max-width: 640px)'
const CONFETTI = 42
const HUES = ['blue', 'violet', 'green', 'orange', 'pink', 'teal', 'amber']

function topModal(): HTMLElement | null {
  try {
    const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((node) => node.matches(':modal'))
    return open[open.length - 1] ?? null
  } catch {
    return null
  }
}

function matches(query: string) {
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

/* Where a burst sits: above its anchor (clamped to the screen), or the top-right corner. */
function placement(anchor: Anchor | null): CSSProperties {
  const width = window.innerWidth
  const height = window.innerHeight
  if (!anchor) return { left: `${Math.max(80, width - 120)}px`, top: '88px' }
  return {
    left: `${Math.min(Math.max(anchor.x, 80), width - 80)}px`,
    top: `${Math.min(Math.max(anchor.y - 12, 72), height - 24)}px`,
  }
}

export function RewardLayer() {
  const [bursts, setBursts] = useState<Burst[]>([])
  const [level, setLevel] = useState<number | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const lastAction = useRef<{ anchor: Anchor; at: number } | null>(null)
  const seen = useRef<SeenXp[]>([])
  const celebrated = useRef(0)
  const nextId = useRef(1)

  // Where the student last tapped or pressed a key: the chip rises from there.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      noteUserGesture()
      lastAction.current = { anchor: { x: event.clientX, y: event.clientY }, at: Date.now() }
    }
    const onKey = () => {
      noteUserGesture()
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active === document.body) return
      const rect = active.getBoundingClientRect()
      if (!rect.width && !rect.height) return
      lastAction.current = { anchor: { x: rect.left + rect.width / 2, y: rect.top }, at: Date.now() }
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  useEffect(() => onRewards((signal: RewardSignal) => {
    const now = Date.now()
    const anchorFor = (given?: Anchor | null) => {
      // Phones: always the top of the screen, never over the answer buttons.
      if (matches(PHONE)) return null
      if (given) return given
      const last = lastAction.current
      return last && now - last.at < ANCHOR_FRESH_MS ? last.anchor : null
    }
    const add = (change: { xp?: number; combo?: number; anchor: Anchor | null }) => {
      setHost(topModal())
      setBursts((current) => addToBursts(current, change, now, nextId.current++))
    }

    if (signal.kind === 'goal') {
      playSound('goal')
      announce('Daily goal done!')
      return
    }

    if (signal.kind === 'answer') {
      if (!signal.correct) return
      const tier = comboTier(signal.combo)
      playSound(tier && isComboMilestone(signal.combo) ? 'combo' : 'correct')
      if (tier) {
        add({ combo: signal.combo, anchor: anchorFor(signal.anchor) })
        if (isComboMilestone(signal.combo)) announce(comboLabel(signal.combo))
      }
      return
    }

    const { rewards, source } = signal
    const xp = Math.max(0, Math.round(rewards.xp ?? 0)) + Math.max(0, Math.round(rewards.chest?.xp ?? 0))
    seen.current = seen.current.filter((entry) => now - entry.at < 10_000)
    if (xp && !isDuplicateXp(seen.current, xp, source, now)) {
      seen.current.push({ xp, at: now, source })
      add({ xp, anchor: anchorFor(signal.anchor) })
      announce(`Plus ${xp} XP`)
    } else if (xp) {
      seen.current.push({ xp, at: now, source })
    }
    const to = rewards.level_up?.to ?? 0
    if (to > celebrated.current && (rewards.level_up?.from ?? 0) < to) {
      celebrated.current = to
      setHost(topModal())
      // Shown a beat after the XP chip, so the two don't land at once.
      window.setTimeout(() => setLevel(to), xp ? 650 : 0)
    }
  }), [])

  // Each burst floats away on its own.
  useEffect(() => {
    if (!bursts.length) return
    const newest = Math.max(...bursts.map((burst) => burst.at))
    const timer = window.setTimeout(() => {
      setBursts((current) => current.filter((burst) => Date.now() - burst.at < BURST_MS))
    }, Math.max(50, BURST_MS - (Date.now() - newest)) + 20)
    return () => window.clearTimeout(timer)
  }, [bursts])

  const phone = typeof window !== 'undefined' && matches(PHONE)
  const content = (
    <>
      {bursts.length ? (
        <div className={`reward-layer${phone ? ' is-phone' : ''}`} aria-hidden="true">
          {bursts.map((burst) => (
            <div key={`${burst.id}-${burst.xp}-${burst.combo}`} className={`reward-burst${burst.anchor ? '' : ' is-corner'}`} style={phone ? undefined : placement(burst.anchor)}>
              {burst.combo ? (
                <span className={`reward-combo is-tier-${comboTier(burst.combo)}`}>
                  <span className="reward-combo__flame">🔥</span> {comboLabel(burst.combo)}
                </span>
              ) : null}
              {burst.xp ? <span className="reward-xp">+{burst.xp} XP</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {level !== null ? <LevelUp level={level} onClose={() => setLevel(null)} /> : null}
    </>
  )
  if (typeof document === 'undefined') return null
  return createPortal(content, host && host.isConnected ? host : document.body)
}

function LevelUp({ level, onClose }: { level: number; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const [held, setHeld] = useState(false)
  const calm = matches('(prefers-reduced-motion: reduce)')

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    button.current?.focus({ preventScroll: true })
    playSound('level')
    announce(`Level ${level}! You reached level ${level}.`)
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [level])

  // Closes by itself unless the student is pointing at or tabbing around it.
  useEffect(() => {
    if (held) return
    const timer = window.setTimeout(onClose, LEVEL_AUTO_CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [held, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className={`reward-level${calm ? ' is-calm' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="reward-level-title"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      {calm ? null : (
        <div className="reward-confetti" aria-hidden="true">
          {Array.from({ length: CONFETTI }, (_, index) => (
            <span
              key={index}
              className={`reward-confetti__piece ui-tone--${HUES[index % HUES.length]}`}
              style={{
                ['--left' as string]: `${(index * 37) % 100}%`,
                ['--drift' as string]: `${((index * 53) % 120) - 60}px`,
                ['--spin' as string]: `${((index * 97) % 540) + 180}deg`,
                ['--delay' as string]: `${(index % 7) * 90}ms`,
                ['--fall' as string]: `${2300 + ((index * 131) % 1200)}ms`,
              } as CSSProperties}
            />
          ))}
        </div>
      )}
      <div className="reward-level__card" onPointerEnter={() => setHeld(true)} onFocus={(event) => { if (event.target !== (button.current as EventTarget | null)) setHeld(true) }}>
        <img className="reward-level__mascot" src="/bindit-mascot-cutout.webp" alt="" width="120" height="144" />
        <p className="reward-level__eyebrow">Level up</p>
        <p className="reward-level__number" aria-hidden="true">{level}</p>
        <h2 className="reward-level__title" id="reward-level-title">Level {level}!</h2>
        <p className="reward-level__copy">Every answer got you here. Nice work.</p>
        <button ref={button} type="button" className="reward-level__go" onClick={onClose}>Keep going</button>
      </div>
    </div>
  )
}
