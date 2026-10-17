import { loadSoundOn } from './rewards'

/*
 * Short reward sounds made with the Web Audio API (oscillators and envelopes): no audio
 * files, no libraries. Off unless the student turns on Sound effects in Settings, never
 * for a wrong answer, never before the student has interacted with the page, and never
 * while the tab is hidden. Every sound is quiet and under a second.
 */

export type SoundName = 'correct' | 'combo' | 'level' | 'goal'

type Note = { freq: number; at: number; length: number; type?: OscillatorType; gain?: number }

// C major and friends: bright, never alarming.
const SOUNDS: Record<SoundName, Note[]> = {
  correct: [
    { freq: 659.25, at: 0, length: 0.12 },
    { freq: 987.77, at: 0.07, length: 0.18 },
  ],
  combo: [
    { freq: 783.99, at: 0, length: 0.1 },
    { freq: 987.77, at: 0.07, length: 0.1 },
    { freq: 1318.51, at: 0.14, length: 0.22 },
  ],
  level: [
    { freq: 523.25, at: 0, length: 0.16, type: 'triangle' },
    { freq: 659.25, at: 0.12, length: 0.16, type: 'triangle' },
    { freq: 783.99, at: 0.24, length: 0.16, type: 'triangle' },
    { freq: 1046.5, at: 0.36, length: 0.5, type: 'triangle', gain: 0.9 },
    { freq: 1318.51, at: 0.36, length: 0.5, gain: 0.35 },
  ],
  goal: [
    { freq: 698.46, at: 0, length: 0.3, type: 'triangle', gain: 0.7 },
    { freq: 880, at: 0, length: 0.3, gain: 0.4 },
    { freq: 1046.5, at: 0.16, length: 0.45, type: 'triangle', gain: 0.8 },
    { freq: 1318.51, at: 0.16, length: 0.45, gain: 0.35 },
  ],
}

const VOLUME = 0.07

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext }
let context: AudioContext | null = null
let interacted = false

/* The layer calls this on the first tap or key press; audio never starts before one. */
export function noteUserGesture() {
  interacted = true
}

function hasGesture() {
  if (interacted) return true
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  return Boolean(activation?.hasBeenActive)
}

function audio() {
  if (context) return context
  const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    context = null
  }
  return context
}

export function playSound(name: SoundName) {
  if (typeof window === 'undefined' || !loadSoundOn() || !hasGesture() || document.hidden) return
  const ctx = audio()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  try {
    const start = ctx.currentTime + 0.01
    const master = ctx.createGain()
    master.gain.value = VOLUME
    master.connect(ctx.destination)
    for (const note of SOUNDS[name]) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = note.type ?? 'sine'
      osc.frequency.value = note.freq
      const t0 = start + note.at
      const peak = note.gain ?? 1
      // A soft attack and an exponential fade: a chime, not a beep.
      env.gain.setValueAtTime(0.0001, t0)
      env.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length)
      osc.connect(env)
      env.connect(master)
      osc.start(t0)
      osc.stop(t0 + note.length + 0.02)
    }
  } catch {
    // Audio is a bonus; nothing depends on it.
  }
}
