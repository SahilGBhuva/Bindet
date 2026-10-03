import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { prefersReducedMotion } from './motion'
import { COURSE_TONE } from './story'
import { buildLayout, CONSTELLATION_COURSES, seeded, type LayoutNode } from './constellationLayout'
import type { ConstellationHandle, ConstellationPalette } from './constellationScene'

/*
 * Hero visual: the knowledge constellation, in one of three forms:
 * - WebGL (three.js) on larger screens with WebGL, fetched only after the page
 *   is idle so it never delays the headline, the buttons, or sign-in;
 * - the same composition as SVG with a CSS "scatter, then bind" animation on
 *   phones and without WebGL, so phones never download or run three.js;
 * - that SVG, still, under prefers-reduced-motion.
 */

type Mode = 'pending' | 'webgl' | 'svg' | 'static'
type IdleWindow = Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void }
type DeviceNavigator = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }

function supportsWebGL() {
  try {
    const probe = document.createElement('canvas')
    return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'))
  } catch {
    return false
  }
}

function lowPowerDevice() {
  const nav = navigator as DeviceNavigator
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4 || Boolean(nav.connection?.saveData)
}

function isPhone() {
  return window.matchMedia('(max-width: 760px)').matches
}

/* Development only: ?scene=static|svg previews the fallbacks. */
function devScene() {
  return import.meta.env.DEV ? new URLSearchParams(window.location.search).get('scene') : null
}

function chooseMode(): Mode {
  if (typeof window === 'undefined' || prefersReducedMotion() || devScene() === 'static') return 'static'
  if (isPhone() || devScene() === 'svg') return 'svg'
  return 'pending'
}

function readPalette(): ConstellationPalette {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    ink: token('--color-text', '#18181b'),
    paper: token('--color-surface', '#ffffff'),
    rule: token('--color-border', '#e5e2da'),
    ruleStrong: token('--color-border-strong', '#d1cdc3'),
    brand: token('--color-brand', '#5b4dd8'),
    courses: CONSTELLATION_COURSES.map((course) => COURSE_TONE[course] ?? '#5b4dd8'),
  }
}

/* The static composition, drawn from the same layout as the WebGL scene. */
function StaticMap({ compact, animated }: { compact: boolean; animated: boolean }) {
  const layout = useMemo(() => buildLayout(compact), [compact])
  const at = new Map(layout.nodes.map((node) => [node.id, node]))
  // Where each piece starts when it animates in, and when: courses, then units, then material, then concepts.
  const motion = useMemo(() => {
    const random = seeded(20261002)
    const rank = { course: 0, unit: 1, note: 2, card: 2, question: 2, assignment: 2, concept: 3 } as const
    return new Map(layout.nodes.map((node, index) => [node.id, {
      '--dx': `${Math.round((random() - 0.5) * 220)}px`,
      '--dy': `${Math.round((random() - 0.5) * 160)}px`,
      '--r': `${Math.round((random() - 0.5) * 70)}deg`,
      '--d': `${(0.1 + rank[node.kind] * 0.45 + Math.max(0, node.course) * 0.12 + (index % 5) * 0.03).toFixed(2)}s`,
    } as CSSProperties]))
  }, [layout])
  const delayOf = (id: string) => parseFloat(String((motion.get(id) as Record<string, string>)['--d']))
  const lineStyle = (from: string, to: string, extra = 0.55) => ({ '--d': `${(Math.max(delayOf(from), delayOf(to)) + extra).toFixed(2)}s` } as CSSProperties)
  const piece = (node: LayoutNode, children: ReactNode) => <g key={node.id} className="lp-cn" style={motion.get(node.id)}>{children}</g>
  // Frame the drawing to the layout: room for labels left of the rings (or above them when compact).
  const xs = layout.nodes.map((node) => node.x)
  const left = Math.min(...xs) - (compact ? 0.75 : 2.05)
  const right = Math.max(...xs) + 0.6
  const top = layout.spine[0] + (compact ? 0.35 : 0.15)
  const bottom = layout.spine[1] - 0.15
  const sx = (x: number) => (x - left) * 50
  const sy = (y: number) => (top - y) * 50
  const viewBox = `0 0 ${Math.round((right - left) * 50)} ${Math.round((top - bottom) * 50)}`
  const tone = (node: LayoutNode) => COURSE_TONE[CONSTELLATION_COURSES[node.course]] ?? 'var(--color-brand)'
  return (
    <svg className={`lp-constellation__static${animated ? ' is-animated' : ''}`} viewBox={viewBox} aria-hidden="true">
      <line className="lp-constellation__spine" pathLength={1} style={{ '--d': '0.15s' } as CSSProperties} x1={sx(layout.nodes[0].x)} y1={sy(layout.spine[0])} x2={sx(layout.nodes[0].x)} y2={sy(layout.spine[1])} />
      {layout.threads.map(([from, to]) => <line key={`${from}-${to}`} pathLength={1} style={lineStyle(from, to)} className="lp-constellation__thread" x2={sx(at.get(from)!.x)} y2={sy(at.get(from)!.y)} x1={sx(at.get(to)!.x)} y1={sy(at.get(to)!.y)} />)}
      {layout.links.map(([from, to]) => <line key={`${from}-${to}`} pathLength={1} style={lineStyle(from, to, 0.8)} className="lp-constellation__link" x1={sx(at.get(from)!.x)} y1={sy(at.get(from)!.y)} x2={sx(at.get(to)!.x)} y2={sy(at.get(to)!.y)} />)}
      {layout.nodes.map((node) => {
        const x = sx(node.x)
        const y = sy(node.y)
        switch (node.kind) {
          case 'course': return piece(node, <><circle cx={x} cy={y} r={17} fill="none" stroke={tone(node)} strokeWidth={4.5} />{compact ? <text x={x} y={y - 26} textAnchor="middle" className="lp-constellation__label-svg is-compact">{node.label}</text> : <text x={x - 28} y={y + 4} textAnchor="end" className="lp-constellation__label-svg">{node.label}</text>}</>)
          case 'unit': return piece(node, <circle cx={x} cy={y} r={5} fill={tone(node)} />)
          case 'note': return piece(node, <rect x={x - 11} y={y - 14} width={22} height={28} rx={1.5} className="lp-constellation__paper" />)
          case 'card': return piece(node, <><rect x={x - 15} y={y - 10} width={30} height={20} rx={1.5} className="lp-constellation__paper" /><rect x={x - 15} y={y - 10} width={30} height={4} fill={tone(node)} /></>)
          case 'question': return piece(node, <circle cx={x} cy={y} r={7.5} fill="var(--color-surface)" stroke={tone(node)} strokeWidth={3} />)
          case 'assignment': return piece(node, <rect x={x - 7.5} y={y - 7.5} width={15} height={15} className="lp-constellation__task" />)
          default: return piece(node, <circle cx={x} cy={y} r={4} className="lp-constellation__concept" />)
        }
      })}
    </svg>
  )
}

export function Constellation() {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const labels = useRef<(HTMLSpanElement | null)[]>([])
  const [initialMode] = useState<Mode>(chooseMode)
  const [mode, setMode] = useState<Mode>(initialMode)
  const [ready, setReady] = useState(false)
  const [compact] = useState(() => typeof window !== 'undefined' && (lowPowerDevice() || isPhone()))

  useEffect(() => {
    if (initialMode !== 'pending') return
    if (!supportsWebGL()) { queueMicrotask(() => setMode('svg')); return }
    let cancelled = false
    let handle: ConstellationHandle | null = null
    let themeObserver: MutationObserver | null = null
    const node = frame.current
    const idle = window as IdleWindow

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !node || !handle) return
      const rect = node.getBoundingClientRect()
      handle.setPointer((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1)
    }
    const onScroll = () => { if (handle && node) handle.setScroll(window.scrollY / Math.max(1, node.offsetHeight * 1.4)) }

    const load = () => {
      void import('./constellationScene').then(({ mountConstellation }) => {
        if (cancelled || !canvas.current) return
        try {
          handle = mountConstellation(canvas.current, {
            quality: compact ? 'low' : 'high',
            palette: readPalette(),
            onLabels: (positions) => positions.forEach((position, index) => {
              const label = labels.current[index]
              if (!label) return
              label.style.transform = compact
                ? `translate(${position.x}px, ${position.y - 22}px) translate(-50%, -100%)`
                : `translate(${position.x - 30}px, ${position.y}px) translate(-100%, -50%)`
              label.style.opacity = String(position.opacity)
            }),
          })
        } catch {
          setMode('svg')
          return
        }
        setMode('webgl')
        requestAnimationFrame(() => { if (!cancelled) setReady(true) })
        themeObserver = new MutationObserver(() => handle?.setPalette(readPalette()))
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        window.addEventListener('pointermove', onPointer, { passive: true })
        window.addEventListener('scroll', onScroll, { passive: true })
        canvas.current.addEventListener('webglcontextlost', () => { handle?.dispose(); handle = null; setMode('svg') }, { once: true })
      }).catch(() => { if (!cancelled) setMode('svg') })
    }

    // After the headline and buttons are on screen and the main thread is quiet.
    const usesIdle = typeof idle.requestIdleCallback === 'function'
    const idleHandle = usesIdle ? idle.requestIdleCallback!(load, { timeout: 1600 }) : window.setTimeout(load, 600)

    return () => {
      cancelled = true
      if (usesIdle) idle.cancelIdleCallback?.(idleHandle)
      else window.clearTimeout(idleHandle)
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('scroll', onScroll)
      themeObserver?.disconnect()
      handle?.dispose()
    }
  }, [initialMode, compact])

  return (
    <div className={`lp-constellation is-${mode}${ready ? ' is-ready' : ''}`} ref={frame} aria-hidden="true">
      {mode === 'static' || mode === 'svg' ? <StaticMap compact={compact} animated={mode === 'svg'} /> : (
        <>
          <canvas ref={canvas} className="lp-constellation__canvas" />
          {CONSTELLATION_COURSES.map((course, index) => (
            <span key={course} ref={(element) => { labels.current[index] = element }} className="lp-constellation__label">{course}</span>
          ))}
        </>
      )}
    </div>
  )
}
