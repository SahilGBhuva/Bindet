import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MathText } from './Math'
import { loadKatex as preloadMath } from './katexLoader'
import { splitMath } from './mathText'

// A practice test choice as PracticeTest.tsx renders it: the whole row is the <label>.
function choice(text: string) {
  return renderToStaticMarkup(createElement('label', { className: 'practice__choice', htmlFor: 'c' },
    createElement('input', { id: 'c', type: 'radio', name: 'q', value: text }),
    createElement('span', { className: 'practice__choice-text' }, createElement(MathText, { text })),
  ))
}

describe('math in practice test choices', () => {
  it('finds the inline LaTeX in a choice', () => {
    expect(splitMath('$\\frac{\\pi}{4}$ radians').map((segment) => segment.kind)).toEqual(['math', 'text'])
  })

  it('renders $\\frac{\\pi}{4}$ with KaTeX inside the clickable choice row, in the surrounding ink', async () => {
    await preloadMath()
    const html = choice('$\\frac{\\pi}{4}$ radians')
    expect(html).toMatch(/^<label class="practice__choice"/)
    expect(html).toContain('class="math"')
    expect(html).toContain('class="katex"')
    expect(html).toContain('mfrac')
    expect(html).toContain('π')
    expect(html).toContain(' radians')
    expect(html).not.toContain('katex-error')
    expect(html.slice(html.indexOf('practice__choice-text'))).not.toContain('$')
    // No hard-coded ink: KaTeX output carries no color, so it inherits currentColor in both themes.
    expect(html).not.toMatch(/color:\s*(?:black|#000)/i)
  })

  it('shows plain text choices as text', async () => {
    await preloadMath()
    expect(choice('In the chloroplasts')).toContain('<span class="practice__choice-text">In the chloroplasts</span>')
  })
})
