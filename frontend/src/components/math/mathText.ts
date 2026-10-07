/*
 * Splits text into plain text and math segments. Supported delimiters:
 *   inline:  $…$  and  \(…\)
 *   display: $$…$$ and \[…\]
 * A lone currency amount is not math: an inline $ must be followed by a non-space,
 * the closing $ must be on the same line, not preceded by a space and not followed
 * by a digit ("$5 and $6" stays text). \$ is a literal dollar sign.
 *
 * A hand-written scan, not a regular expression: it runs in linear time on any input
 * (no backtracking), and it needs no lookbehind, which Safari before 16.4 can't parse.
 * Each closing delimiter's next position is remembered, so an unclosed "$$" or "\[" is
 * searched for once, not once per opening.
 */
export type MathSegment =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean; source: string }

/* Longer text (a whole pasted document) is shown as plain text, without looking for math. */
export const MAX_SPLIT_LENGTH = 50_000

const SPACE = /\s/
const isSpace = (char: string) => SPACE.test(char)
const isDigit = (char: string) => char >= '0' && char <= '9'

type Match = { start: number; end: number; tex: string; display: boolean }

/* indexOf with memory: searches only move forward, so each delimiter costs one pass over the text. */
function closer(text: string, delimiter: string) {
  let found = -2 // -2: not searched yet; -1: none left in the text
  return (from: number) => {
    if (found === -1) return -1
    if (found < from) found = text.indexOf(delimiter, from)
    return found
  }
}

function scan(text: string): Match[] {
  const matches: Match[] = []
  const closeDisplayDollar = closer(text, '$$')
  const closeBracket = closer(text, '\\]')
  const closeParen = closer(text, '\\)')
  let index = 0
  while (index < text.length) {
    const char = text[index]
    let match: Match | null = null
    if (char === '$' && text[index + 1] === '$') {
      // $$…$$ with at least one character between.
      const end = closeDisplayDollar(index + 3)
      if (end !== -1) match = { start: index, end: end + 2, tex: text.slice(index + 2, end), display: true }
    } else if (char === '\\' && (text[index + 1] === '[' || text[index + 1] === '(')) {
      const display = text[index + 1] === '['
      const end = (display ? closeBracket : closeParen)(index + 3)
      if (end !== -1) match = { start: index, end: end + 2, tex: text.slice(index + 2, end), display }
    }
    if (!match && char === '$') match = inlineDollar(text, index)
    if (match) {
      matches.push(match)
      index = match.end
    } else {
      index += 1
    }
  }
  return matches
}

/*
 * $…$ starting at index, or null. The content runs to the first $ or line break; its last
 * character must not be a space, and may itself be that first $ when another $ follows
 * ("$$$" is the expression "$"). The closing $ is not followed by a digit.
 */
function inlineDollar(text: string, index: number): Match | null {
  const before = index > 0 ? text[index - 1] : ''
  if (before === '\\' || before === '$') return null
  const first = text[index + 1]
  if (first === undefined || isSpace(first)) return null
  let stop = index + 1
  while (stop < text.length && text[stop] !== '$' && text[stop] !== '\n') stop += 1
  if (stop >= text.length || text[stop] !== '$') return null
  const closesAt = (close: number) => {
    const after = text[close + 1]
    return text[close] === '$' && !(after !== undefined && isDigit(after))
  }
  let close = -1
  if (stop >= index + 2 && !isSpace(text[stop - 1]) && closesAt(stop)) close = stop
  else if (closesAt(stop + 1)) close = stop + 1
  if (close === -1) return null
  return { start: index, end: close + 1, tex: text.slice(index + 1, close), display: false }
}

export const MAX_TEX_LENGTH = 2000

// No nested quantifiers: each test is linear in the length of the expression.
const NEGATIVE_SPACE = /\\(?:kern|mkern|mskip|hskip|hspace\*?|mspace)[\s{+]*-/
const OVERLAP = /\\(?:llap|rlap|clap|mathllap|mathrlap|mathclap|raisebox|smash)(?![a-zA-Z])/
const MACRO_DEFINITION = /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand)(?![a-zA-Z])/

/*
 * Expressions that are not rendered (their source is shown as code): very long ones, and
 * ones that could draw outside their own box, over the text and controls around them.
 */
export function unsafeTex(tex: string) {
  return tex.length > MAX_TEX_LENGTH || NEGATIVE_SPACE.test(tex) || OVERLAP.test(tex) || MACRO_DEFINITION.test(tex)
}

export function hasMath(text: string) {
  return text.length <= MAX_SPLIT_LENGTH && scan(text).length > 0
}

export function splitMath(text: string): MathSegment[] {
  const plain = (value: string): MathSegment => ({ kind: 'text', text: value.replace(/\\\$/g, '$') })
  if (text.length > MAX_SPLIT_LENGTH) return [plain(text)]
  const segments: MathSegment[] = []
  let last = 0
  for (const match of scan(text)) {
    if (match.start > last) segments.push(plain(text.slice(last, match.start)))
    const source = text.slice(match.start, match.end)
    const tex = match.tex.trim()
    segments.push(tex ? { kind: 'math', tex, display: match.display, source } : plain(source))
    last = match.end
  }
  if (last < text.length) segments.push(plain(text.slice(last)))
  return segments
}
