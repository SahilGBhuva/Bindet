import { useEffect, useState } from 'react'
import { OttoMarkdown } from './OttoMarkdown'
import { stablePrefix } from './streamText'
import { useSmoothText } from './useSmoothText'

export type ThinkingContext = 'plain' | 'notes' | 'photo'

const CONTEXT_LABEL: Record<ThinkingContext, string> = {
  plain: 'Thinking…',
  notes: 'Reading your notes…',
  photo: 'Looking at your photo…',
}

/*
 * Before the first word: a quiet shimmering label. It starts as "Thinking…" and, when the
 * question uses the student's notes or a photo, moves on to say so.
 */
export function OttoThinking({ context = 'plain' }: { context?: ThinkingContext }) {
  const [label, setLabel] = useState(CONTEXT_LABEL.plain)
  useEffect(() => {
    if (context === 'plain') return
    const timer = window.setTimeout(() => setLabel(CONTEXT_LABEL[context]), 900)
    return () => window.clearTimeout(timer)
  }, [context])
  return (
    <div className="otto-thinking">
      <span key={label} className="otto-thinking__label">{label}</span>
    </div>
  )
}

/*
 * One reply from Otto. While it streams, the text is revealed at a steady pace, only the part
 * that is safe to render is shown (no half-written math or bold), new words fade in, and a
 * small dot pulses at the end. Finished replies render at once.
 */
export function OttoReply({ content, streaming, partial = false, context }: { content: string; streaming: boolean; partial?: boolean; context?: ThinkingContext }) {
  const { shown, revealing } = useSmoothText(content, streaming)
  const moving = streaming || revealing
  // Words keep their fade spans a moment after the reveal ends, so the last ones finish fading.
  const [settling, setSettling] = useState(false)
  const [wasMoving, setWasMoving] = useState(moving)
  if (wasMoving !== moving) {
    setWasMoving(moving)
    if (!moving) setSettling(true)
  }
  useEffect(() => {
    if (!settling) return
    const timer = window.setTimeout(() => setSettling(false), 450)
    return () => window.clearTimeout(timer)
  }, [settling])

  // A stopped reply ends mid-sentence: its unfinished formatting stays hidden too.
  const visible = moving || partial ? stablePrefix(shown) : shown
  if (moving && !visible.trim()) return <OttoThinking context={context} />
  const live = moving || settling
  return (
    <div className={`otto-rich${live ? ' is-live' : ''}${moving ? ' is-writing' : ''}`}>
      <OttoMarkdown text={visible} live={live} />
    </div>
  )
}
