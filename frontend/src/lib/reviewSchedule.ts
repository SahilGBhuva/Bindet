import type { ReviewGrade } from './api'

/*
 * The spaced-repetition scheduler from backend/review.py (next_values / preview), ported
 * exactly so Review mode can show each grade's next interval from the card's own state,
 * and so the landing demo schedules cards the way the server does.
 *
 * "Exactly" covers the two Python details that differ from JavaScript: round() rounds
 * halves to even, and the fuzz is seeded from SHA-256 of "card_id:reps".
 * Keep this file in step with backend/review.py.
 */

export type SchedulerState = { interval_days: number; ease: number; reps: number; lapses: number }

export const DEFAULT_EASE = 2.5
const MIN_EASE = 1.3
const MAX_INTERVAL_DAYS = 365
const RELEARN_DAYS = 10 / 1440
const HARD_FIRST_DAYS = 0.5
const FUZZ_MIN_DAYS = 3
const FUZZ = 0.05

/* Python's round(x): halves go to the even neighbour. */
function roundHalfEven(value: number) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/* Python's round(x, 4), close enough for ease values (two decimals at most). */
function round4(value: number) {
  return roundHalfEven(value * 10_000) / 10_000
}

// --- SHA-256 (synchronous; crypto.subtle is async-only) -----------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/* The first four bytes of SHA-256(text) as a big-endian unsigned integer. */
function sha256Head(text: string) {
  const bytes = new TextEncoder().encode(text)
  const length = Math.ceil((bytes.length + 9) / 64) * 64
  const message = new Uint8Array(length)
  message.set(bytes)
  message[bytes.length] = 0x80
  const view = new DataView(message.buffer)
  view.setUint32(length - 8, Math.floor((bytes.length * 8) / 0x1_0000_0000))
  view.setUint32(length - 4, (bytes.length * 8) >>> 0)
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d
    hash[4] += e; hash[5] += f; hash[6] += g; hash[7] += h
  }
  return hash[0]
}

function fuzz(cardId: string, reps: number) {
  const unit = sha256Head(`${cardId}:${reps}`) / 0xffffffff
  return 1 + (unit * 2 - 1) * FUZZ
}

/* The new {interval_days, ease, reps, lapses} after grading a card in `state` (null: new). */
export function nextValues(state: SchedulerState | null, grade: ReviewGrade, cardId: string): SchedulerState {
  const interval = state ? Number(state.interval_days) : 0
  const ease = state ? Number(state.ease) : DEFAULT_EASE
  const reps = state ? Math.trunc(state.reps) : 0
  const lapses = state ? Math.trunc(state.lapses) : 0

  if (grade === 'again') {
    return { interval_days: RELEARN_DAYS, ease: Math.max(MIN_EASE, round4(ease - 0.2)), reps: 0, lapses: lapses + (interval >= 1 ? 1 : 0) }
  }

  let hard = HARD_FIRST_DAYS
  let good = 1
  let easy = 4
  if (reps !== 0) {
    hard = Math.max(interval * 1.2, interval + 1)
    good = Math.max(reps === 1 ? 3 : interval * ease, hard + 1)
    easy = Math.max(interval * ease * 1.3, good + 1)
  }
  let chosen = { hard, good, easy }[grade]
  if (chosen >= 1) {
    if (chosen >= FUZZ_MIN_DAYS) chosen *= fuzz(cardId, reps)
    chosen = Math.min(MAX_INTERVAL_DAYS, Math.max(1, roundHalfEven(chosen)))
  }
  const nextEase = { hard: ease - 0.15, good: ease, easy: ease + 0.15 }[grade]
  // Hard on a first sight keeps the card learning; any other pass counts a successful rep.
  const nextReps = grade === 'hard' && reps === 0 ? reps : reps + 1
  return { interval_days: chosen, ease: Math.max(MIN_EASE, round4(nextEase)), reps: nextReps, lapses }
}

/* Interval in days each grade would give, for the grade buttons. */
export function previewFor(state: SchedulerState | null, cardId: string): Record<ReviewGrade, number> {
  return {
    again: nextValues(state, 'again', cardId).interval_days,
    hard: nextValues(state, 'hard', cardId).interval_days,
    good: nextValues(state, 'good', cardId).interval_days,
    easy: nextValues(state, 'easy', cardId).interval_days,
  }
}
