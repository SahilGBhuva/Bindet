/*
 * Splits text into plain text and math segments. Supported delimiters:
 *   inline:  $…$  and  \(…\)
 *   display: $$…$$ and \[…\]
 * A lone currency amount is not math: an inline $ must be followed by a non-space,
 * the closing $ must be on the same line, not preceded by a space and not followed
 * by a digit ("$5 and $6" stays text). \$ is a literal dollar sign.
 */
export type MathSegment =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean; source: string }

const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?=\S)([^$\n]*?\S)\$(?!\d)/g

export function hasMath(text: string) {
  MATH.lastIndex = 0
  return MATH.test(text)
}

export function splitMath(text: string): MathSegment[] {
  const segments: MathSegment[] = []
  let last = 0
  MATH.lastIndex = 0
  for (let match = MATH.exec(text); match; match = MATH.exec(text)) {
    if (match.index > last) segments.push({ kind: 'text', text: text.slice(last, match.index) })
    const display = match[1] !== undefined || match[2] !== undefined
    const tex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
    segments.push(tex ? { kind: 'math', tex, display, source: match[0] } : { kind: 'text', text: match[0] })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments.map((segment) => (segment.kind === 'text' ? { kind: 'text', text: segment.text.replace(/\\\$/g, '$') } : segment))
}
