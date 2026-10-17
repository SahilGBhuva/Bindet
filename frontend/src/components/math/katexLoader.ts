/*
 * KaTeX, loaded on first use in its own chunk (with its CSS and fonts) so pages without
 * math never pay for it. Math.tsx renders with it; tests preload it.
 */
export type Katex = typeof import('katex')['default']

let katexLoad: Promise<Katex> | null = null
let katexReady: Katex | null = null

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

/* KaTeX when it has loaded already, else null. */
export function katexLoaded(): Katex | null {
  return katexReady
}
