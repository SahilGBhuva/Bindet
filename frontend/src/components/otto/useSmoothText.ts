import { useEffect, useRef, useState } from 'react'
import { nextReveal, toWordEnd } from './streamText'

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/*
 * Reveals a streaming reply at a steady pace instead of in network-sized chunks, like
 * ChatGPT and Claude. Text that was already complete when it mounted (history, cache) is
 * shown at once; so is everything under prefers-reduced-motion. Returns the revealed text
 * and whether the reveal is still catching up.
 */
export function useSmoothText(text: string, streaming: boolean): { shown: string; revealing: boolean } {
  // Only a reply that was streaming at some point animates; history never does.
  const [animating, setAnimating] = useState(() => streaming && !reducedMotion())
  if (streaming && !animating && !reducedMotion()) setAnimating(true)
  const [length, setLength] = useState(0)
  // The animation loop reads the latest text and stream state without restarting.
  const target = useRef(text)
  const finished = useRef(!streaming)
  useEffect(() => { target.current = text; finished.current = !streaming }, [text, streaming])

  useEffect(() => {
    if (!animating) return
    let frame = 0
    let last = performance.now()
    let position = 0
    const tick = (now: number) => {
      const full = target.current
      const dt = (now - last) / 1000
      last = now
      position = nextReveal(Math.min(position, full.length), full.length, dt, finished.current)
      const cut = toWordEnd(full, Math.floor(position))
      setLength(cut)
      if (position >= full.length && finished.current) { setAnimating(false); return }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    // A hidden tab gets no frames; the reveal resumes (and catches up quickly) when it returns.
    return () => cancelAnimationFrame(frame)
  }, [animating])

  if (!animating) return { shown: text, revealing: false }
  // The saved reply can differ from the streamed one (a server-side cleanup): never show a stale prefix.
  const shown = text.slice(0, Math.min(length, text.length))
  return { shown, revealing: shown.length < text.length }
}
