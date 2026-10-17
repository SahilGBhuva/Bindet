import { describe, expect, it } from 'vitest'
import {
  answerLineCount,
  choiceLetter,
  chunk,
  correctChoice,
  cutoutSheets,
  fitScale,
  isAppleMobile,
  mirrorRows,
  printFileTitle,
  printHint,
  scopeLine,
} from './printDoc'

describe('chunk', () => {
  it('splits into runs, the last one shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 8)).toEqual([])
  })

  it('rejects a size that is not a positive whole number', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError)
    expect(() => chunk([1], 1.5)).toThrow(RangeError)
  })
})

describe('mirrorRows', () => {
  it('reverses each row of a two-column sheet and keeps the rows in order', () => {
    expect(mirrorRows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toEqual(['b', 'a', 'd', 'c', 'f', 'e', 'h', 'g'])
  })

  it('pads a short last row so a card stays in its own row', () => {
    expect(mirrorRows(['a', 'b', 'c'])).toEqual(['b', 'a', null, 'c'])
  })

  it('works for other column counts', () => {
    expect(mirrorRows([1, 2, 3, 4, 5, 6], 3)).toEqual([3, 2, 1, 6, 5, 4])
    expect(mirrorRows([1, 2], 1)).toEqual([1, 2])
  })

  it('mirroring twice gives the sheet back', () => {
    const sheet = ['a', 'b', 'c', 'd', null, null, null, null]
    expect(mirrorRows(mirrorRows(sheet))).toEqual(sheet)
  })
})

describe('cutoutSheets', () => {
  const cards = Array.from({ length: 11 }, (_, index) => `card ${index + 1}`)

  it('puts 8 cards on a sheet and pads the last sheet with empty slots', () => {
    const sheets = cutoutSheets(cards)
    expect(sheets).toHaveLength(2)
    expect(sheets[0].fronts).toEqual(cards.slice(0, 8))
    expect(sheets[1].fronts).toEqual([...cards.slice(8), null, null, null, null, null])
  })

  it('places each back behind its own front when the sheet is flipped on the long edge', () => {
    for (const sheet of cutoutSheets(cards)) {
      sheet.fronts.forEach((card, slot) => {
        const row = Math.floor(slot / 2)
        const column = slot % 2
        expect(sheet.backs[row * 2 + (1 - column)]).toBe(card)
      })
    }
  })

  it('makes no sheets for an empty deck', () => {
    expect(cutoutSheets([])).toEqual([])
  })

  it('rejects a page size that does not fill whole rows', () => {
    expect(() => cutoutSheets(cards, 7, 2)).toThrow(RangeError)
  })
})

describe('printFileTitle', () => {
  it('names the PDF after the document and what it is', () => {
    expect(printFileTitle('Photosynthesis', 'Study guide')).toBe('Photosynthesis – Study guide')
  })

  it('drops characters a file name can’t hold', () => {
    expect(printFileTitle('Unit 3: Cells / Energy?', 'Flashcards')).toBe('Unit 3 Cells Energy – Flashcards')
  })

  it('does not repeat the kind, and falls back when the title is empty', () => {
    expect(printFileTitle('Flashcards', 'flashcards')).toBe('Flashcards')
    expect(printFileTitle('   ', 'Answer key')).toBe('Answer key')
    expect(printFileTitle('', '')).toBe('bindet')
  })
})

describe('scopeLine', () => {
  it('joins course and unit, or says whole course', () => {
    expect(scopeLine('Biology', 'Cells')).toBe('Biology · Cells')
    expect(scopeLine('Biology', null)).toBe('Biology · Whole course')
  })
})

describe('choices', () => {
  it('letters options and finds the correct one', () => {
    expect(choiceLetter(0)).toBe('A')
    expect(choiceLetter(3)).toBe('D')
    expect(correctChoice(['2', '4', '8'], '4')).toBe('B')
    expect(correctChoice(['Mitosis', 'Meiosis'], ' meiosis ')).toBe('B')
    expect(correctChoice(['a', 'b'], 'c')).toBe('')
    expect(correctChoice(['a'], undefined)).toBe('')
  })
})

describe('fitScale', () => {
  it('leaves content that fits at full size', () => {
    expect(fitScale(600, 400)).toBe(1)
    expect(fitScale(600, 600)).toBe(1)
  })

  it('shrinks wide content to fit, but not below the minimum', () => {
    expect(fitScale(600, 800)).toBe(0.75)
    expect(fitScale(100, 1000)).toBe(0.5)
    expect(fitScale(100, 1000, 0.3)).toBe(0.3)
  })

  it('ignores sizes it can’t measure', () => {
    expect(fitScale(0, 500)).toBe(1)
    expect(fitScale(500, Number.NaN)).toBe(1)
  })
})

describe('isAppleMobile and printHint', () => {
  it('tells iPhones and iPads apart from desktops', () => {
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(true)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 15)' })).toBe(false)
  })

  it('gives the right first-use hint', () => {
    expect(printHint(true)).toBe('Tap Share, then Save to Files.')
    expect(printHint(false)).toBe('Choose “Save as PDF” in the print window.')
  })
})

describe('answerLineCount', () => {
  it('leaves more room under long prompts', () => {
    expect(answerLineCount('What is 2 + 2?')).toBe(2)
    expect(answerLineCount('x'.repeat(200))).toBe(3)
  })
})
