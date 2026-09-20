import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

/*
 * Motion helpers for the landing page. Everything here only ever drives
 * transform, opacity, clip-path and stroke-dashoffset, and everything is off
 * under prefers-reduced-motion.
 */

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/* Adds .is-visible to [data-reveal] elements as they scroll into view. */
export function useReveal(root: RefObject<HTMLElement | null>) {
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

/* True once the element has scrolled into view. */
export function useInView(ref: RefObject<HTMLElement | null>, threshold = 0.35) {
  const [seen, setSeen] = useState(() => typeof window !== 'undefined' && !('IntersectionObserver' in window))
  useEffect(() => {
    const node = ref.current
    if (!node || seen) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setSeen(true)
    }, { threshold })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, seen, threshold])
  return seen
}

/*
 * Scroll progress. Registered elements get --p: 0 when their top edge enters the
 * bottom of the screen, 1 when their bottom edge leaves the top. One passive
 * scroll listener and one animation frame serve every element. Without it (phones,
 * reduced motion, no JS) the stylesheet's --p: 1 shows the finished composition.
 */
const SCRUB_QUERY = '(min-width: 861px)'
const scrubbed = new Set<HTMLElement>()
let frame = 0

function measure() {
  frame = 0
  const vh = window.innerHeight
  for (const node of scrubbed) {
    const box = node.getBoundingClientRect()
    if (box.bottom < -vh * 0.5 || box.top > vh * 1.5) continue
    const p = Math.min(1, Math.max(0, (vh - box.top) / (vh + box.height)))
    node.style.setProperty('--p', p.toFixed(4))
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(measure)
}

export function useScrollProgress(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || prefersReducedMotion() || !window.matchMedia) return
    const wide = window.matchMedia(SCRUB_QUERY)
    const sync = () => {
      if (wide.matches) {
        if (scrubbed.size === 0) {
          window.addEventListener('scroll', schedule, { passive: true })
          window.addEventListener('resize', schedule)
        }
        scrubbed.add(node)
        measure()
      } else {
        release(node)
      }
    }
    sync()
    wide.addEventListener('change', sync)
    return () => {
      wide.removeEventListener('change', sync)
      release(node)
    }
  }, [ref])
}

function release(node: HTMLElement) {
  scrubbed.delete(node)
  node.style.removeProperty('--p')
  if (scrubbed.size === 0) {
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    cancelAnimationFrame(frame)
    frame = 0
  }
}
