import { useRef, type CSSProperties } from 'react'
import { useInView } from './motion'
import { storyUnit } from './story'

/*
 * The tutor, shown honestly: an example exchange about the demo student's
 * genetics notes, labelled as an example. It is drawn with the same message
 * rhythm as the real tutor screen, and reveals line by line like a stream.
 */
export function TutorStory() {
  const genetics = storyUnit('AP Biology', 'Genetics')
  const root = useRef<HTMLDivElement>(null)
  const seen = useInView(root, 0.4)
  const reply = [
    'Each parent passes on one allele, so an Aa × Aa cross has four equally likely boxes: AA, Aa, aA and aa.',
    'Three of the four boxes carry at least one dominant A, so three show the dominant trait. Only aa shows the recessive one.',
    `That is the 3 : 1 your notes call out in ${genetics.file}.`,
    'Check yourself: what ratio would Aa × aa give?',
  ]
  return (
    <section className="lp-tutor" id="tutor-story" aria-labelledby="lp-tutor-title">
      <div className="lp-tutor__copy">
        <p className="lp-eyebrow" data-reveal>Tutor</p>
        <h2 className="lp-serif lp-tutor__title" id="lp-tutor-title" data-reveal>A tutor that has read <em>your notes.</em></h2>
        <p className="lp-tutor__lead" data-reveal>
          Ask anything. Answers start streaming in a moment, use your own notes first and say which file they came from.
          Drop in a photo of a problem when words are not enough.
        </p>
        <ul className="lp-tutor__facts" data-reveal>
          <li>Grounded in the course and unit you choose</li>
          <li>Guides you through homework instead of handing over answers</li>
          <li>Photos are sent only when you attach them and are never stored</li>
        </ul>
      </div>
      <div className={`lp-tutor__window${seen ? ' is-playing' : ''}`} ref={root} aria-label="Example tutor conversation using the demo student’s AP Biology notes">
        <div className="lp-tutor__bar"><span>Why is it 3 : 1?</span><small>AP Biology · Genetics · example</small></div>
        <div className="lp-tutor__thread">
          <p className="lp-tutor__user">Why does a cross of two heterozygotes give 3 : 1?</p>
          <div className="lp-tutor__reply">
            <span className="lp-tutor__mark" aria-hidden="true" />
            <div>
              {reply.map((line, index) => <p key={line} style={{ '--i': index } as CSSProperties}>{line}</p>)}
              <small>From your notes: {genetics.file}</small>
            </div>
          </div>
        </div>
        <div className="lp-tutor__composer" aria-hidden="true"><span>Ask about Genetics…</span><i /></div>
      </div>
    </section>
  )
}
