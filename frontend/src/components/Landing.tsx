import { useEffect, useRef, useState } from 'react'
import { LivePreview } from './demo/LivePreview'
import { Binding } from './landing/Binding'
import { Capture } from './landing/Capture'
import { Mastery, Together } from './landing/Mastery'
import { Mosaic } from './landing/Mosaic'
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

/* The quiet paper ground behind the auth screens. */
export function ColorBackdrop({ className = '' }: { className?: string }) {
  return <div className={`lp-backdrop ${className}`} aria-hidden="true" />
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

export function Landing({ onSignUp, onLogIn }: LandingProps) {
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })

  return (
    <div className="lp" ref={root}>
      <header className="lp-nav">
        <a className="lp-nav__brand" href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }) }}>
          <img src="/bindit-mascot-cutout.webp" alt="" width="28" height="34" />
          bindit
        </a>
        <nav className="lp-nav__links" aria-label="Page sections">
          <button type="button" onClick={() => scrollTo('capture')}>How it works</button>
          <button type="button" onClick={() => scrollTo('practice')}>Practice</button>
          <button type="button" onClick={() => scrollTo('mastery')}>Progress</button>
        </nav>
        <div className="lp-nav__actions">
          <button className="lp-textlink lp-textlink--plain" type="button" onClick={onLogIn}>Log in</button>
          <button className="lp-btn lp-btn--ink lp-btn--sm" type="button" onClick={() => onSignUp()}>Get started</button>
        </div>
      </header>

      <main>
        <section className="lp-hero" id="top" aria-labelledby="lp-hero-title">
          <div className="lp-hero__copy">
            <h1 className="lp-display lp-hero__title" id="lp-hero-title">
              <span>All your notes,</span>
              <em>bound together.</em>
            </h1>
            <p className="lp-hero__lead">
              Upload your class notes. bindit turns them into flashcards, quizzes, and a mastery map for every course.
            </p>
            <div className="lp-hero__cta">
              <button className="lp-btn lp-btn--primary lp-btn--lg" type="button" onClick={() => onSignUp()}>Get started</button>
              <button className="lp-btn lp-btn--quiet lp-btn--lg" type="button" onClick={onLogIn}>Log in</button>
            </div>
          </div>
          <HeroProduct onLocked={(action) => onSignUp(action)} />
        </section>

        <section className="lp-scattered" aria-labelledby="lp-scattered-title">
          <p className="lp-kicker" data-reveal>Scattered</p>
          <h2 className="lp-serif lp-scattered__title" id="lp-scattered-title" data-reveal>
            A semester lives in<br /><em>too many places.</em>
          </h2>
          <Mosaic />
          <p className="lp-scattered__after" data-reveal>Everything you’re learning can live together.</p>
        </section>

        <Capture />
        <Binding />
        <FlashcardStage />
        <QuizStage />
        <Mastery />
        <Together />

        <section className="lp-final" aria-labelledby="lp-final-title">
          <h2 className="lp-serif lp-final__title" id="lp-final-title" data-reveal>
            Your notes are already<br /><em>a study plan.</em>
          </h2>
          <div className="lp-final__actions" data-reveal>
            <button className="lp-btn lp-btn--primary lp-btn--lg" type="button" onClick={() => onSignUp()}>Get started</button>
            <button className="lp-textlink" type="button" onClick={onLogIn}>Already have an account? Log in →</button>
          </div>
          <img className="lp-final__otter" data-reveal src="/bindit-mascot-cutout.webp" alt="The bindit otter carrying a purple binder" width="240" height="288" loading="lazy" decoding="async" />
        </section>
      </main>

      <footer className="lp-footer">
        <span className="lp-footer__brand">bindit</span>
        <span>Built for the Congressional App Challenge</span>
      </footer>
    </div>
  )
}
