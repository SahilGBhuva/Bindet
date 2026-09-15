import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { DEMO_SUMMARY } from './demo/demoData'
import { LivePreview } from './demo/LivePreview'
import { toneClass, type Tone } from '../lib/tones'
import './Landing.css'

type LandingProps = {
  onSignUp: (reason?: string) => void
  onLogIn: () => void
  onGuest: () => void
}

const FEATURES: { tone: Tone; title: string; copy: string; icon: ReactNode }[] = [
  { tone: 'blue', title: 'Notes in any format', copy: 'Upload PDFs, Word docs, text files, or a photo of handwritten notes, and file them by course and unit.', icon: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" /> },
  { tone: 'violet', title: 'Flashcards from your notes', copy: 'Each unit turns its own notes into a deck, so you review what your class actually covered.', icon: <><rect x="3" y="6" width="14" height="14" rx="2" /><path d="M7 3h12a2 2 0 0 1 2 2v12" /></> },
  { tone: 'pink', title: 'Quizzes that explain', copy: 'Answer in your own words and get graded with an explanation and a hint when you miss.', icon: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.8 2.8L16.5 9.5" /></> },
  { tone: 'green', title: 'See mastery grow', copy: 'A mastery graph and unit roadmap per course show what is sharp, what is slipping, and what to study next.', icon: <path d="M4 19h16M6 15l4-4 3 3 5-6" /> },
  { tone: 'orange', title: 'Streaks and friend quests', copy: 'Keep a daily streak, climb a weekly league, and team up on 100 XP quests with friends.', icon: <path d="M12 3c.5 3 3 4.5 4.5 7a6 6 0 1 1-10.6 1.5c.8 1.2 1.9 1.7 2.8 1.6C8 10 10 6.5 12 3z" /> },
  { tone: 'teal', title: 'Study groups', copy: 'Invite classmates with a code, share a weekly XP goal, and watch the group’s momentum.', icon: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" /></> },
]

const STEPS: { tone: Tone; title: string; copy: string }[] = [
  { tone: 'blue', title: 'Add your notes', copy: 'Create a course, add units, and upload or paste the notes from class.' },
  { tone: 'violet', title: 'Practice from them', copy: 'bindit builds flashcards and quiz questions from the notes in each unit.' },
  { tone: 'pink', title: 'Watch it stick', copy: 'Track mastery per unit, keep your streak, and study alongside friends.' },
]

const STATS = [
  { label: 'Courses', value: DEMO_SUMMARY.courses },
  { label: 'Notes uploaded', value: DEMO_SUMMARY.notes },
  { label: 'Day streak', value: DEMO_SUMMARY.streak },
  { label: 'XP earned', value: DEMO_SUMMARY.xp },
]

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/* Soft drifting color blobs. Transform-only animation, no filters, so it stays cheap to composite. */
export function ColorBackdrop({ className = '' }: { className?: string }) {
  return (
    <div className={`lp-backdrop ${className}`} aria-hidden="true">
      <span className="lp-blob lp-blob--blue" />
      <span className="lp-blob lp-blob--violet" />
      <span className="lp-blob lp-blob--pink" />
      <span className="lp-blob lp-blob--teal" />
      <span className="lp-blob lp-blob--amber" />
    </div>
  )
}

/* Adds .is-visible to [data-reveal] elements as they scroll into view. */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const nodes = root.current?.querySelectorAll<HTMLElement>('[data-reveal]')
    if (!nodes?.length) return
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-visible'))
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 })
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [root])
}

function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [animate] = useState(() => !prefersReducedMotion() && 'IntersectionObserver' in window)
  const [shown, setShown] = useState(() => (animate ? 0 : value))
  useEffect(() => {
    const node = ref.current
    if (!node || !animate) return
    let frame = 0
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      observer.disconnect()
      const start = performance.now()
      const tick = (time: number) => {
        const t = Math.min(1, (time - start) / 1400)
        setShown(Math.round(value * (1 - (1 - t) ** 3)))
        if (t < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }, { threshold: 0.4 })
    observer.observe(node)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [value, animate])
  return <span ref={ref}>{(animate ? shown : value).toLocaleString()}</span>
}

/*
 * Virtual screen the demo is rendered at before scaling. The app's responsive
 * rules follow the real viewport, so phones get the phone layout at phone width.
 */
const DESKTOP_PREVIEW = { width: 1440, height: 880 }
const PHONE_PREVIEW = { width: 420, height: 980 }
const APP_MOBILE_BREAKPOINT = 860

/*
 * The live demo: the real app pages running on sandboxed demo data, scaled to fit
 * a browser frame. Interactive on larger screens; a static render on phones, where
 * taps while scrolling would misfire and the real app is one tap away as a guest.
 */
function ProductPreview({ onLocked, onGuest }: { onLocked: (action: string) => void; onGuest: () => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth <= APP_MOBILE_BREAKPOINT)
  const size = phone ? PHONE_PREVIEW : DESKTOP_PREVIEW

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
    const node = frame.current
    // No tilt on phones: the projected frame would poke past the screen edges.
    if (!node || prefersReducedMotion() || phone) {
      node?.style.removeProperty('--tilt')
      node?.style.removeProperty('--lift')
      return
    }
    let pending = 0
    const apply = () => {
      pending = 0
      const box = node.getBoundingClientRect()
      // Flat by the time the frame's top reaches the upper third of the screen.
      const progress = Math.min(1, Math.max(0, (window.innerHeight - box.top) / (window.innerHeight * 0.7)))
      node.style.setProperty('--tilt', `${(1 - progress) * 14}deg`)
      node.style.setProperty('--lift', `${(1 - progress) * 40}px`)
    }
    const onScroll = () => {
      if (!pending) pending = requestAnimationFrame(apply)
    }
    apply()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(pending)
    }
  }, [phone])

  return (
    <>
      <div className="lp-demo-hint">
        {phone ? (
          <>
            <span className="lp-demo-hint__dot" aria-hidden="true" />
            <span>A live render of the app. <button className="lp-demo-hint__link" type="button" onClick={onGuest}>Try the real thing as a guest</button></span>
          </>
        ) : (
          <>
            <span className="lp-demo-hint__dot" aria-hidden="true" />
            <span><strong>Try it.</strong> This demo is live — switch pages, flip flashcards, answer a quiz.</span>
          </>
        )}
      </div>
      <div className="lp-preview" ref={frame}>
        <figure className={`lp-preview__window${phone ? '' : ' is-live'}`} aria-label={phone ? 'The bindit dashboard with a demo student’s data' : 'Interactive bindit demo with a demo student’s data. Nothing you do here is saved.'}>
          <div className="lp-preview__bar" aria-hidden="true">
            <span /><span /><span />
            <em>bindit · demo</em>
          </div>
          <div className="lp-preview__stage" ref={stage} style={{ height: size.height * scale }}>
            <div className="lp-preview__scaler" style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}>
              <LivePreview key={phone ? 'phone' : 'desktop'} interactive={!phone} width={size.width} height={size.height} onLockedAction={onLocked} />
            </div>
          </div>
        </figure>
      </div>
    </>
  )
}

function FeatureIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>
}

export function Landing({ onSignUp, onLogIn, onGuest }: LandingProps) {
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })

  return (
    <div className="lp" ref={root}>
      <header className="lp-nav">
        <a className="lp-nav__brand" href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>
          <img src="/bindit-mascot-cutout.webp" alt="" width="32" height="38" />
          bindit
        </a>
        <nav className="lp-nav__links" aria-label="Page sections">
          <button type="button" onClick={() => scrollTo('product')}>Product</button>
          <button type="button" onClick={() => scrollTo('features')}>Features</button>
          <button type="button" onClick={() => scrollTo('how')}>How it works</button>
        </nav>
        <div className="lp-nav__actions">
          <button className="lp-link" type="button" onClick={onLogIn}>Log in</button>
          <button className="lp-pill lp-pill--gradient lp-pill--sm" type="button" onClick={() => onSignUp()}>Get started</button>
        </div>
      </header>

      <main>
        <section className="lp-hero" id="top">
          <ColorBackdrop />
          <div className="lp-hero__inner">
            <div className="lp-hero__copy">
              <p className="lp-eyebrow lp-enter" style={{ '--i': 0 } as CSSProperties}>Notes, flashcards, quizzes, and friends in one place</p>
              <h1 className="lp-hero__title lp-enter lp-enter--solid" style={{ '--i': 1 } as CSSProperties}>
                <span className="lp-spectrum lp-spectrum--lines">Keep your learning together.</span>
              </h1>
              <p className="lp-hero__lead lp-enter lp-enter--solid" style={{ '--i': 2 } as CSSProperties}>
                Upload your class notes and bindit turns them into flashcards, quizzes, and a mastery map for every course. Then study with friends and keep the streak going.
              </p>
              <div className="lp-hero__cta lp-enter" style={{ '--i': 3 } as CSSProperties}>
                <button className="lp-pill lp-pill--gradient lp-pill--lg" type="button" onClick={() => onSignUp()}>Get started</button>
                <button className="lp-pill lp-pill--outline lp-pill--lg" type="button" onClick={onGuest}>Try it as a guest</button>
              </div>
            </div>
            <div className="lp-hero__art lp-enter lp-enter--solid" style={{ '--i': 2 } as CSSProperties}>
              <div className="lp-hero__halo" aria-hidden="true" />
              <img className="lp-hero__mascot" src="/bindit-mascot-cutout.webp" alt="The bindit otter mascot holding a purple binder" width="240" height="288" fetchPriority="high" />
            </div>
          </div>
          <button className="lp-scroll-cue" type="button" onClick={() => scrollTo('product')} aria-label="Scroll to the product preview">
            <span />
          </button>
        </section>

        <section className="lp-section lp-product" id="product">
          <div className="lp-section__head" data-reveal>
            <p className="lp-eyebrow">The real app</p>
            <h2 className="lp-section__title">This is the app, not a mockup.</h2>
            <p className="lp-section__lead">The same screens students use, running on a demo student’s courses, notes, flashcards, and friends.</p>
          </div>
          <div data-reveal>
            <ProductPreview onLocked={(action) => onSignUp(action)} onGuest={onGuest} />
          </div>
        </section>

        <section className="lp-section" id="features">
          <div className="lp-section__head" data-reveal>
            <p className="lp-eyebrow">Features</p>
            <h2 className="lp-section__title">Everything you need to actually study.</h2>
          </div>
          <ul className="lp-features">
            {FEATURES.map((feature, index) => (
              <li key={feature.title} className={`lp-feature ${toneClass(feature.tone)}`} data-reveal style={{ '--i': index } as CSSProperties}>
                <span className="lp-feature__icon"><FeatureIcon>{feature.icon}</FeatureIcon></span>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-stats" aria-labelledby="lp-stats-title">
          <div className="lp-stats__inner" data-reveal>
            <p className="lp-stats__caption" id="lp-stats-title">The demo student in the preview, by the numbers</p>
            <dl className="lp-stats__grid">
              {STATS.map((stat) => (
                <div key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd><span className="lp-spectrum lp-stats__number"><CountUp value={stat.value} /></span></dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="lp-section" id="how">
          <div className="lp-section__head" data-reveal>
            <p className="lp-eyebrow">How it works</p>
            <h2 className="lp-section__title">From class notes to real practice in three steps.</h2>
          </div>
          <ol className="lp-steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className={`lp-step ${toneClass(step.tone)}`} data-reveal style={{ '--i': index } as CSSProperties}>
                <span className="lp-step__badge">{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-final" aria-labelledby="lp-final-title">
          <div className="lp-final__inner" data-reveal>
            <div className="lp-final__mascot" aria-hidden="true">
              <img src="/bindit-mascot-cutout.webp" alt="" width="240" height="288" loading="lazy" />
            </div>
            <div className="lp-final__copy">
              <h2 id="lp-final-title">Your notes are already a study plan.</h2>
              <p>Bring them to bindit and start practicing today.</p>
              <div className="lp-final__actions">
                <button className="lp-pill lp-pill--white lp-pill--lg" type="button" onClick={() => onSignUp()}>Get started</button>
                <button className="lp-link lp-link--light" type="button" onClick={onGuest}>or try it as a guest</button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span>bindit</span>
        <span>Built for the Congressional App Challenge</span>
      </footer>
    </div>
  )
}
