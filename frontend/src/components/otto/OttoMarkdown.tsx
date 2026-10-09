import { Fragment, memo, type ReactNode } from 'react'
import { MathExpression, MathText } from '../math/Math'

/*
 * A small, safe renderer for Otto's replies: paragraphs, headings, lists, block quotes,
 * tables, code, bold, italics and math. No HTML from the reply is ever injected.
 *
 * While a reply streams (`live`), each word is its own span keyed by its position, so only
 * newly revealed words mount, and CSS fades them in. Words already on screen never re-render.
 */

const LIST = /^\s*([-*•]|\d+[.)])\s+/
const HEADING = /^#{1,6}\s/
const QUOTE = /^\s*>\s?/
const ROW = /^\s*\|/
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/

function words(text: string, key: string, live: boolean): ReactNode {
  if (!live) return text
  return text.split(/(\s+)/).map((part, index) => (/^\s*$/.test(part) ? part : <span key={`${key}w${index}`} className="otto-word">{part}</span>))
}

function emphasis(text: string, keyPrefix: string, live: boolean): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={key} className={live ? 'otto-word' : undefined}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={key} className={live ? 'otto-word' : undefined}>{part.slice(1, -1)}</em>
    return <Fragment key={key}>{words(part, key, live)}</Fragment>
  })
}

/* Code spans first (math is never read inside them), then math, then bold and italics. */
function inline(text: string, keyPrefix: string, live: boolean): ReactNode[] {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={key}>{part.slice(1, -1)}</code>
    return <MathText key={key} text={part} renderText={(plain, textKey) => emphasis(plain, `${key}-${textKey}`, live)} />
  })
}

/* A display equation on lines of its own: $$ … $$ or \[ … \]. Returns its end line, or -1. */
function displayMathEnd(lines: string[], start: number): number {
  const open = lines[start].trim()
  const close = open.startsWith('$$') ? '$$' : open.startsWith('\\[') ? '\\]' : ''
  if (!close) return -1
  const rest = open.slice(2)
  if (rest.includes(close)) return rest.trim().endsWith(close) ? start : -1
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().endsWith(close)) return index
  }
  return -1
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]
  return LIST.test(line) || line.trim().startsWith('```') || HEADING.test(line) || QUOTE.test(line) || RULE.test(line)
    || (ROW.test(line) && SEPARATOR.test(lines[index + 1] ?? ''))
}

/* Memoised: while a reply streams, only the message that is growing is parsed again. */
export const OttoMarkdown = memo(function OttoMarkdown({ text, live = false }: { text: string; live?: boolean }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const key = `b${blocks.length}`
    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) { code.push(lines[index]); index += 1 }
      index += 1
      blocks.push(<pre key={key} data-language={language || undefined}><code>{code.join('\n')}</code></pre>)
      continue
    }
    const mathEnd = displayMathEnd(lines, index)
    if (mathEnd >= 0) {
      const source = lines.slice(index, mathEnd + 1).join('\n').trim()
      const tex = source.slice(2, -2).trim()
      blocks.push(tex ? <MathExpression key={key} tex={tex} display source={source} /> : <p key={key}>{source}</p>)
      index = mathEnd + 1
      continue
    }
    if (ROW.test(line) && SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = cells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && ROW.test(lines[index])) { rows.push(cells(lines[index])); index += 1 }
      blocks.push(
        <div key={key} className="otto-table" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex} scope="col">{inline(cell, `${key}h${cellIndex}`, live)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? '', `${key}r${rowIndex}c${cellIndex}`, live)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const first = ordered ? Number.parseInt(line.trim(), 10) : 1
      const items: string[] = []
      while (index < lines.length && LIST.test(lines[index]) && /^\s*\d+[.)]/.test(lines[index]) === ordered) { items.push(lines[index].replace(LIST, '')); index += 1 }
      const List = ordered ? 'ol' : 'ul'
      blocks.push(<List key={key} start={ordered && first !== 1 ? first : undefined}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `${key}l${itemIndex}`, live)}</li>)}</List>)
      continue
    }
    if (HEADING.test(line)) {
      const level = /^#+/.exec(line)?.[0].length ?? 3
      const Heading = level <= 2 ? 'h3' : 'h4'
      blocks.push(<Heading key={key}>{inline(line.replace(/^#+\s/, ''), key, live)}</Heading>)
      index += 1
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) { quoted.push(lines[index].replace(QUOTE, '')); index += 1 }
      blocks.push(<blockquote key={key}><p>{quoted.map((part, partIndex) => <Fragment key={partIndex}>{partIndex ? <br /> : null}{inline(part, `${key}q${partIndex}`, live)}</Fragment>)}</p></blockquote>)
      continue
    }
    if (RULE.test(line)) { blocks.push(<hr key={key} />); index += 1; continue }
    if (!line.trim()) { index += 1; continue }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && (!paragraph.length || (!startsBlock(lines, index) && displayMathEnd(lines, index) < 0))) { paragraph.push(lines[index]); index += 1 }
    blocks.push(<p key={key}>{paragraph.map((part, partIndex) => <Fragment key={partIndex}>{partIndex ? <br /> : null}{inline(part, `${key}p${partIndex}`, live)}</Fragment>)}</p>)
  }
  return <>{blocks}</>
})
