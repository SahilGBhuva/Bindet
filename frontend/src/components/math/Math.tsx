import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { splitMath, unsafeTex } from './mathText'
import './Math.css'

/*
 * Math rendering with KaTeX, loaded on first use in its own chunk (with its CSS and
 * fonts, all served from this origin) so pages without math never pay for it.
 *
 * Safety: model text never reaches innerHTML. Text outside math stays React text
 * nodes; the only HTML injected is what katex.renderToString returns for one
 * expression, with trust: false (no \href, \url, \includegraphics or \htmlClass),
 * strict: 'ignore', and caps on size and macro expansion. KaTeX escapes every
 * character of the source it emits.
 *
 * Layout safety: an expression that could draw outside its own box (negative kerns and
 * spaces, overlaps, raised boxes, macro definitions that could hide them) or that is very
 * long is not rendered; its source is shown as code instead. Math.css also clips each
 * expression to its box, so nothing can cover the text or buttons around it.
 */

type Katex = typeof import('katex')['default']

let katexLoad: Promise<Katex> | null = null
let katexReady: Katex | null = null
const rendered = new Map<string, string | null>()

function loadKatex(): Promise<Katex> {
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

const MAX_CACHE = 500

/* KaTeX's HTML for one expression, or null when it doesn't parse or isn't safe to lay out. Cached: streaming re-renders a lot. */
function toHtml(katex: Katex, tex: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}${tex}`
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  if (unsafeTex(tex)) return null
  let html: string | null
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      maxSize: 10,
      maxExpand: 200,
    })
    // With throwOnError off, a parse error comes back as a .katex-error span: show the source instead.
    if (html.includes('katex-error')) html = null
  } catch {
    html = null
  }
  if (rendered.size >= MAX_CACHE) rendered.clear()
  rendered.set(key, html)
  return html
}

export function MathExpression({ tex, display, source }: { tex: string; display: boolean; source: string }) {
  const [katex, setKatex] = useState<Katex | null>(katexReady)
  useEffect(() => {
    if (katex) return
    let live = true
    loadKatex().then((loaded) => { if (live) setKatex(() => loaded) }, () => undefined)
    return () => { live = false }
  }, [katex])
  if (!katex) {
    // Until KaTeX arrives (a moment, once), the source shows as plain text.
    return <span className={display ? 'math math--display math--pending' : 'math math--pending'}>{source}</span>
  }
  const html = toHtml(katex, tex, display)
  if (html === null) return <code className="math math--source">{source}</code>
  // Always a span (display math is styled as a block): math may sit inside buttons and paragraphs.
  return <span className={display ? 'math math--display' : 'math'} dangerouslySetInnerHTML={{ __html: html }} />
}

/* Text with inline and display math. Non-math text goes through renderText (default: as is). */
export function MathText({ text, renderText }: { text: string; renderText?: (text: string, key: string) => ReactNode }) {
  const segments = splitMath(text)
  return (
    <>
      {segments.map((segment, index) => segment.kind === 'math'
        ? <MathExpression key={index} tex={segment.tex} display={segment.display} source={segment.source} />
        : <Fragment key={index}>{renderText ? renderText(segment.text, `t${index}`) : segment.text}</Fragment>)}
    </>
  )
}
