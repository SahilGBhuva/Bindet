import { Component, useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { DataProvider } from '../../lib/dataSource'
import { SiteSidebar } from '../../lib/SiteSidebar'
import { Home } from '../../pages/Home'
import { Profile } from '../../pages/Profile'
import { Progress } from '../../pages/Progress'
import { Tools } from '../../pages/Tools'
import { createDemoData, DEMO_SESSION } from './demoData'

export type DemoPage = 'home' | 'tools' | 'progress' | 'profile'
const DEMO_PAGES: DemoPage[] = ['home', 'tools', 'progress', 'profile']

/*
 * Controls that are safe to use in the demo: navigation and study interactions
 * that only change what is shown. Anything else that is clickable (create,
 * upload, rename, delete, share, settings) opens sign-up instead.
 */
const ALLOWED = [
  '.tools__course-button',
  '.tools__unit-tabs .ui-tab:not(.tools__add-unit)',
  '.ui-segmented__item',
  '.tools__card',
  '.tools__card-nav button',
  '.tools__choice',
  '.tools__answer input',
  '.tools__answer button',
  '.tools__quiz-controls button',
  '.tools__quiz-controls select',
  '.progress__courses .ui-tab',
  '.progress__legend-item',
  '.progress__node',
  '.progress__info',
  '.progress__info-panel button',
  '.profile__group-tabs .ui-tab',
].join(', ')

const INTERACTIVE = 'a, button, input, textarea, select, summary, label, [role="tab"], [draggable="true"]'

type Decision =
  | { kind: 'allow' }
  | { kind: 'ignore' }
  | { kind: 'navigate'; page: DemoPage }
  | { kind: 'locked'; action: string }

// Friendly names for locked controls whose visible text is not a clean action label.
const ACTION_NAMES: [string, string][] = [
  ['.tools__dropzone-button, .tools__upload *', 'Upload notes'],
  ['.tools__paste *', 'Add typed notes'],
  ['.tools__course-menu *', 'Course options'],
  ['.tools__source *', 'Remove notes'],
  ['.avatar', 'Change your avatar'],
  ['.profile__friend-forms *', 'Find friends'],
  ['.profile__menu *', 'Manage friends'],
  ['.profile__toggle, .profile__toggle *', 'Privacy settings'],
  ['.profile__invite, .profile__invite *', 'Invite code'],
]

function actionName(element: Element) {
  const named = ACTION_NAMES.find(([selector]) => element.matches(selector))
  if (named) return named[1]
  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || ''
  const clean = label.replace(/\s+/g, ' ').trim()
  if (!clean) return 'That'
  return clean.length > 32 ? `${clean.slice(0, clean.lastIndexOf(' ', 32) > 0 ? clean.lastIndexOf(' ', 32) : 32)}…` : clean
}

function decide(target: EventTarget | null, root: HTMLElement): Decision {
  if (!(target instanceof Element) || !root.contains(target)) return { kind: 'allow' }
  const element = target.closest(INTERACTIVE)
  if (!element || !root.contains(element)) return { kind: 'allow' }
  if (element.matches(ALLOWED)) return { kind: 'allow' }

  if (element instanceof HTMLAnchorElement) {
    const page = element.getAttribute('href')?.replace('#', '') as DemoPage | undefined
    const isNav = element.classList.contains('bindit-rail__item') || element.classList.contains('bindit-rail__brand') || element.classList.contains('ui-link')
    if (isNav) {
      if (element.classList.contains('bindit-rail__brand')) return { kind: 'navigate', page: 'home' }
      return page && DEMO_PAGES.includes(page) ? { kind: 'navigate', page } : { kind: 'ignore' }
    }
    if (actionName(element) === 'Review flashcards') return { kind: 'navigate', page: 'tools' }
    return { kind: 'locked', action: actionName(element) }
  }
  return { kind: 'locked', action: actionName(element) }
}

class DemoBoundary extends Component<{ onReset: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    // Recover to a fresh demo rather than leaving a broken frame on the landing page.
    ;(window as unknown as { __binditDemoResets?: number }).__binditDemoResets =
      ((window as unknown as { __binditDemoResets?: number }).__binditDemoResets ?? 0) + 1
    this.props.onReset()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/* Forwards locked actions to whatever handler the landing page currently provides. */
class LockedChannel {
  private handler: (action: string) => void
  constructor(handler: (action: string) => void) {
    this.handler = handler
  }
  set(handler: (action: string) => void) {
    this.handler = handler
  }
  notify = (action: string) => {
    this.handler(action)
  }
}

type LivePreviewProps = {
  interactive: boolean
  width: number
  height: number
  onLockedAction: (action: string) => void
}

export function LivePreview({ interactive, width, height, onLockedAction }: LivePreviewProps) {
  const root = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const [page, setPage] = useState<DemoPage>('home')
  const [generation, setGeneration] = useState(0)
  // A stable channel so the sandbox and click guard always reach the latest onLockedAction.
  const [locked] = useState(() => new LockedChannel(onLockedAction))

  useEffect(() => {
    locked.set(onLockedAction)
  }, [locked, onLockedAction])

  // One sandbox per preview (and a fresh one after any reset). It never touches storage or the network.
  const [data, setData] = useState(() => createDemoData((action) => locked.notify(action)))

  const go = useCallback((next: DemoPage) => {
    setPage(next)
    if (main.current) main.current.scrollTop = 0
  }, [])

  const guard = useCallback((event: SyntheticEvent) => {
    const node = root.current
    if (!node) return
    const decision = decide(event.target, node)
    if (decision.kind === 'allow') return
    event.preventDefault()
    event.stopPropagation()
    if (decision.kind === 'navigate') go(decision.page)
    if (decision.kind === 'locked') locked.notify(decision.action)
  }, [go, locked])

  const block = useCallback((event: SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const guardSubmit = useCallback((event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.matches('.tools__answer')) return
    event.preventDefault()
    event.stopPropagation()
    locked.notify('save that')
  }, [locked])

  const reset = useCallback(() => {
    setData(createDemoData((action) => locked.notify(action)))
    setGeneration((value) => value + 1)
    setPage('home')
  }, [locked])

  const handlers = interactive
    ? {
        onClickCapture: guard,
        onDoubleClickCapture: block,
        onSubmitCapture: guardSubmit,
        onDragStartCapture: block,
        onDragOverCapture: block,
        onDropCapture: block,
        onContextMenuCapture: undefined,
      }
    : {}

  return (
    <div
      ref={root}
      className={`app-shell lp-demo${interactive ? ' is-interactive' : ''}`}
      style={{ width, height }}
      inert={!interactive}
      aria-hidden={interactive ? undefined : true}
      {...handlers}
    >
      <DataProvider value={data}>
        <SiteSidebar active={page} />
        <main className={`sheet is-${page}`} ref={main}>
          <DemoBoundary key={generation} onReset={reset}>
            <div className="lp-demo__page" key={`${generation}-${page}`}>
              {page === 'home' ? <Home session={DEMO_SESSION} /> : null}
              {page === 'tools' ? <Tools accessToken={DEMO_SESSION.access_token} /> : null}
              {page === 'progress' ? <Progress session={DEMO_SESSION} /> : null}
              {page === 'profile' ? <Profile session={DEMO_SESSION} /> : null}
            </div>
          </DemoBoundary>
        </main>
      </DataProvider>
    </div>
  )
}
