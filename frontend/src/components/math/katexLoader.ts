/*
 * Loads KaTeX on first use, in its own chunk (with its CSS and fonts, all served from this
 * origin), so pages without math never pay for it. Shared by Math.tsx (which renders with it),
 * by "Download PDF" (which loads it before laying out a document so every expression is
 * typeset before printing) and by tests (which preload it).
 */
export type Katex = typeof import('katex')['default']

let katexLoad: Promise<Katex> | null = null
let katexReady: Katex | null = null

/* KaTeX if it has already loaded, else null. */
export function loadedKatex(): Katex | null {
  return katexReady
}

export function loadKatex(): Promise<Katex> {
  if (!katexLoad) {
    katexLoad = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => {
      katexReady = module.default
      return module.default
    })
    // Forget a failed load (offline) so a later render can try again.
    katexLoad.catch(() => { katexLoad = null })
  }
  return katexLoad
}
