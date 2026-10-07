import { useEffect, useRef, useState } from 'react'
import { LivePreview } from './demo/LivePreview'
import { Binding } from './landing/Binding'
import { Capture } from './landing/Capture'
import { Mastery, Together } from './landing/Mastery'
import { Constellation } from './landing/Constellation'
import { TutorStory } from './landing/TutorStory'
import { BrandMark } from '../lib/SiteSidebar'
import { prefersReducedMotion, useReveal, useScrollProgress } from './landing/motion'
import { FlashcardStage, QuizStage } from './landing/Practice'
import './Landing.css'
import './landing/sections.css'

/*
 * The logged-out landing page. It tells one visual story as you scroll:
 * scattered -> captured -> connected -> practiced -> mastered. The product is
 * the artwork: the hero is the real app, and every section demonstrates a real
 * feature with the demo student's material instead of describing it.
 */

type LandingProps = {
  onSignUp: (reason?: string) => void
  onLogIn: () => void
}

/*
 * Virtual screen the demo is rendered at before scaling. The app's responsive
 * rules follow the real viewport, so phones get the phone layout at phone width.
 */
const DESKTOP_PREVIEW = { width: 1440, height: 880 }
const PHONE_PREVIEW = { width: 420, height: 980 }
const APP_MOBILE_BREAKPOINT = 860

/*
 * The hero artwork: the real app pages running on sandboxed demo data, scaled to
 * fit one large surface that rises from under the fold. Interactive on larger
 * screens; a static render on phones, where taps while scrolling would misfire
 * and account creation stays one tap away.
 */
function HeroProduct({ onLocked }: { onLocked: (action: string) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth <= APP_MOBILE_BREAKPOINT)
  // The app mounts after the headline has painted, into space that is already reserved.
  const [ready, setReady] = useState(false)
  const size = phone ? PHONE_PREVIEW : DESKTOP_PREVIEW
  useScrollProgress(root)

  useEffect(() => {
    const node = stage.current
    if (!node) return
    const update = () => {
      const nextPhone = window.innerWidth <= APP_MOBILE_BREAKPOINT
      setPhone(nextPhone)
      setScale(node.clientWidth / (nextPhone ? PHONE_PREVIEW : DESKTOP_PREVIEW).width)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  useEffect(() => {
    const idle = window.requestIdleCallback?.(() => setReady(true), { timeout: 700 })
    const timer = idle === undefined ? window.setTimeout(() => setReady(true), 200) : undefined
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  return (
    <div className="lp-product lp-scrub" id="product" ref={root}>
      <img className="lp-product__otter" src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" />
      <figure
        className={`lp-product__surface${phone ? '' : ' is-live'}`}
        aria-label={phone ? 'The bindit dashboard with a demo student’s data' : 'Interactive bindit demo with a demo student’s data. Nothing you do here is saved.'}
      >
        <figcaption className="lp-product__strip">
          <span className="lp-product__live"><i aria-hidden="true" />{phone ? 'A live render of the app' : 'Live demo'}</span>
          {phone ? (
            <button className="lp-textlink" type="button" onClick={() => onLocked('Open the full app')}>Sign up to continue →</button>
          ) : (
            <span className="lp-product__hint">This is the real app. Switch pages, flip a flashcard, answer a quiz. Nothing is saved.</span>
          )}
        </figcaption>
        <div className="lp-product__stage" ref={stage} style={{ height: size.height * scale }}>
          <div className="lp-product__scaler" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>
            {ready ? <LivePreview key={phone ? 'phone' : 'desktop'} interactive={!phone} width={size.width} height={size.height} onLockedAction={onLocked} /> : null}
          </div>
        </div>
      </figure>
    </div>
  )
}

const STEPS = [
  { id: 'capture', number: '01', title: 'Add notes and materials', copy: 'PDFs, photos of your notebook, typed notes. Scanned pages are read for you.' },
  { id: 'connected', number: '02', title: 'Bind them into courses and units', copy: 'Every note lives in a unit, every unit in a course. Nothing floats loose.' },
  { id: 'practice', number: '03', title: 'Generate grounded study material', copy: 'Flashcards and questions are written from your own notes, not the open web.' },
  { id: 'mastery', number: '04', title: 'Practice and track mastery', copy: 'Adaptive quizzes, instant feedback, and a clear view of what has stuck.' },
]

export function Landing({ onSignUp, onLogIn }: LandingProps) {
  const root = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useReveal(root)
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="lp" ref={root}>
      <a className="skip-link" href="#lp-main">Skip to content</a>
      <header className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
        <a className="lp-nav__brand" href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }) }}>
          <BrandMark size={24} />
          bindit
        </a>
        <nav className="lp-nav__links" aria-label="Page sections">
          <button type="button" onClick={() => scrollTo('workflow')}>How it works</button>
          <button type="button" onClick={() => scrollTo('product')}>The app</button>
          <button type="button" onClick={() => scrollTo('tutor-story')}>Tutor</button>
          <button type="button" onClick={() => scrollTo('together')}>Study groups</button>
        </nav>
        <div className="lp-nav__actions">
          <button className="lp-textlink lp-textlink--plain" type="button" onClick={onLogIn}>Log in</button>
          <button className="lp-btn lp-btn--ink lp-btn--sm" type="button" onClick={() => onSignUp()}>Create an account</button>
        </div>
      </header>

      <main id="lp-main">
        <section className="lp-hero" id="top" aria-labelledby="lp-hero-title">
          <div className="lp-hero__copy">
            <p className="lp-eyebrow">A study workspace for high school</p>
            <h1 className="lp-hero__title" id="lp-hero-title">
              Everything you’re learning, <em>bound together.</em>
            </h1>
            <p className="lp-hero__lead">
              Upload your notes and bindit organizes them into courses and units, writes flashcards and quizzes from your own material, keeps your assignments in order, and shows what you have actually mastered.
            </p>
            <div className="lp-hero__cta">
              <button className="lp-btn lp-btn--primary lp-btn--lg" type="button" onClick={() => onSignUp()}>Create an account</button>
              <button className="lp-btn lp-btn--quiet lp-btn--lg" type="button" onClick={onLogIn}>Log in</button>
            </div>
            <p className="lp-hero__note">Your notes stay private to your account.</p>
          </div>
          <div className="lp-hero__visual">
            <Constellation />
            <ul className="lp-legend" aria-label="What the map shows">
              <li><i className="is-course" />Courses</li>
              <li><i className="is-note" />Notes</li>
              <li><i className="is-card" />Flashcards</li>
              <li><i className="is-question" />Questions</li>
              <li><i className="is-task" />Assignments</li>
              <li><i className="is-concept" />Concepts</li>
            </ul>
          </div>
        </section>

        <section className="lp-workflow" id="workflow" aria-labelledby="lp-workflow-title">
          <div className="lp-workflow__head">
            <p className="lp-eyebrow">How it works</p>
            <h2 className="lp-serif lp-workflow__title" id="lp-workflow-title">From scattered to <em>mastered</em>, in four steps.</h2>
          </div>
          <ol className="lp-workflow__steps">
            {STEPS.map((step) => (
              <li key={step.id}>
                <button type="button" onClick={() => scrollTo(step.id)}>
                  <span className="lp-workflow__number">{step.number}</span>
                  <strong>{step.title}</strong>
                  <span>{step.copy}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-preview" aria-labelledby="lp-preview-title">
          <div className="lp-preview__head">
            <p className="lp-eyebrow">The app</p>
            <h2 className="lp-serif lp-preview__title" id="lp-preview-title">Not a mockup. <em>The real thing.</em></h2>
            <p className="lp-fineprint">The workspace below is bindit itself, running on a demo student’s courses. Every number is computed by the product. Nothing you do here is saved.</p>
          </div>
          <HeroProduct onLocked={(action) => onSignUp(action)} />
        </section>

        <Capture />
        <Binding />
        <FlashcardStage />
        <QuizStage />
        <Mastery />
        <TutorStory />
        <div id="together"><Together /></div>

        <section className="lp-final" aria-labelledby="lp-final-title">
          <img className="lp-final__otter" data-reveal src="/bindit-mascot-cutout.webp" alt="The bindit otter carrying a purple binder" width="240" height="288" loading="lazy" decoding="async" />
          <h2 className="lp-serif lp-final__title" id="lp-final-title" data-reveal>
            Your notes are already<br /><em>a study plan.</em>
          </h2>
          <div className="lp-final__actions" data-reveal>
            <button className="lp-btn lp-btn--primary lp-btn--lg" type="button" onClick={() => onSignUp()}>Create an account</button>
            <button className="lp-textlink" type="button" onClick={onLogIn}>Already have an account? Log in →</button>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer__brand"><BrandMark size={20} /> bindit</div>
        <nav aria-label="Footer">
          <button type="button" onClick={() => scrollTo('workflow')}>How it works</button>
          <button type="button" onClick={() => scrollTo('product')}>The app</button>
          <button type="button" onClick={() => scrollTo('tutor-story')}>Tutor</button>
          <button type="button" onClick={onLogIn}>Log in</button>
          <button type="button" onClick={() => onSignUp()}>Create an account</button>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>
        <p>Built for the Congressional App Challenge.</p>
      </footer>
    </div>
  )
}
