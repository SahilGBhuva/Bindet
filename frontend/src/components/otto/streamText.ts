/*
 * Helpers for showing a reply while it streams.
 *
 * stablePrefix: the part of a partial reply that is safe to render. Markdown and LaTeX that
 * have been opened but not closed yet (an inline `$…`, `**bold…`, a `$$` block, a table whose
 * header has no separator row yet) are held back until they close, so the reader never sees
 * raw symbols flash and then turn into formatting.
 *
 * nextReveal: how many characters a smooth reveal should show next, at a steady pace that
 * speeds up when it falls behind and never lags the server by much more than a second.
 */

/* Cuts `text` at the earliest construct that is still open. Only used while streaming. */
export function stablePrefix(text: string): string {
  let cut = text.length

  // Fenced code: an open fence renders progressively (it is plain text), so it is kept.
  // Everything below ignores the inside of code fences.
  const fences = [...text.matchAll(/^\s*```.*$/gm)]
  const insideOpenFence = fences.length % 2 === 1
  if (insideOpenFence) return text

  // Display math: an odd number of `$$`, or a `\[` with no `\]` after it.
  const displayDollars: number[] = []
  for (let index = text.indexOf('$$'); index >= 0; index = text.indexOf('$$', index + 2)) {
    if (text[index - 1] !== '\\') displayDollars.push(index)
  }
  if (displayDollars.length % 2 === 1) cut = Math.min(cut, displayDollars[displayDollars.length - 1])
  const openBracket = text.lastIndexOf('\\[')
  if (openBracket >= 0 && text.indexOf('\\]', openBracket) < 0) cut = Math.min(cut, openBracket)

  // Tables: an unfinished row waits for its newline, and a header row waits for its separator.
  const isRow = (line: string) => /^\s*\|/.test(line)
  let head = text.slice(0, cut)
  const lastBreak = head.lastIndexOf('\n')
  if (isRow(head.slice(lastBreak + 1))) { cut = lastBreak + 1; head = text.slice(0, cut) }
  const lines = head.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length && isRow(lines[lines.length - 1]) && !isRow(lines[lines.length - 2] ?? '')) {
    cut = Math.max(0, head.lastIndexOf(lines[lines.length - 1]))
  }

  // Inline constructs only live on one line, so only the line being written can be open.
  head = text.slice(0, cut)
  const lineStart = head.lastIndexOf('\n') + 1
  const line = head.slice(lineStart)
  const open = openInline(line)
  if (open >= 0) cut = Math.min(cut, lineStart + open)

  return text.slice(0, Math.max(0, cut))
}

/* Index of the first still-open inline construct on a line, or -1. */
function openInline(line: string): number {
  let codeOpen = -1
  let mathOpen = -1
  let parenOpen = -1
  let boldOpen = -1
  let italicOpen = -1
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (codeOpen >= 0) { if (char === '`') codeOpen = -1; continue }
    if (char === '\\') {
      if (line[index + 1] === '(') { if (parenOpen < 0) parenOpen = index; index += 1; continue }
      if (line[index + 1] === ')') { parenOpen = -1; index += 1; continue }
      index += 1 // an escaped character, such as \$
      continue
    }
    if (parenOpen >= 0) continue
    if (char === '$') {
      if (line[index + 1] === '$') { index += 1; continue } // display math is handled above
      if (mathOpen >= 0) { mathOpen = -1; continue }
      // Opens math only when followed by a non-space ("$5 and $6" stays text once it closes or the line ends).
      if (line[index + 1] !== undefined && !/\s/.test(line[index + 1])) mathOpen = index
      continue
    }
    if (mathOpen >= 0) continue
    if (char === '`') { codeOpen = index; continue }
    if (char === '*') {
      if (line[index + 1] === '*') { boldOpen = boldOpen >= 0 ? -1 : index; index += 1; continue }
      // A single * opens italics only before a non-space (a "* " list marker is not italics).
      if (italicOpen >= 0) italicOpen = -1
      else if (line[index + 1] !== undefined && !/\s/.test(line[index + 1])) italicOpen = index
      continue
    }
  }
  // A trailing lone "$", "*" or "`" may be the start of something: hold it for a moment.
  const tail = /[$*`\\]+$/.exec(line)
  const candidates = [codeOpen, mathOpen, parenOpen, boldOpen, italicOpen, tail ? tail.index : -1].filter((value) => value >= 0)
  return candidates.length ? Math.min(...candidates) : -1
}

/*
 * The next reveal position. `shown` is a fractional character count, `target` the full length,
 * `dt` the frame time in seconds. The pace is proportional to the backlog (it drains in about
 * a third of a second) with a floor, so bursts flow out smoothly and the reveal never sits
 * more than about a second behind what has arrived.
 */
export function nextReveal(shown: number, target: number, dt: number, finished: boolean): number {
  const backlog = target - shown
  if (backlog <= 0) return target
  const drain = finished ? 0.18 : 0.35
  const speed = Math.max(finished ? 160 : 55, backlog / drain)
  const next = shown + speed * Math.min(dt, 0.1)
  // Hard ceiling on lag: more than a second's worth at the floor pace is shown at once.
  if (target - next > 900) return target - 900
  return Math.min(target, next)
}

/* Extends a cut to the end of the word it falls in (up to a few characters), so words appear whole. */
export function toWordEnd(text: string, position: number): number {
  if (position >= text.length) return text.length
  const limit = Math.min(text.length, position + 14)
  for (let index = position; index < limit; index += 1) {
    if (/\s/.test(text[index])) return index
  }
  return position
}
