import { describe, expect, it } from 'vitest'
import { photoNoteName } from './notePhoto'

const NOW = new Date(2026, 9, 7, 12).getTime()
const base = photoNoteName(NOW, []).replace(/, page 1$/, '')

describe('photoNoteName', () => {
  it('starts at page 1', () => {
    expect(photoNoteName(NOW, [])).toBe(`${base}, page 1`)
  })

  it('follows the highest page, so a deleted page is never reused', () => {
    const notes = [{ fileName: `${base}, page 1.jpg` }, { fileName: `${base}, page 3.jpg` }]
    expect(photoNoteName(NOW, notes)).toBe(`${base}, page 4`)
  })

  it('ignores other days and other notes', () => {
    const otherDay = photoNoteName(new Date(2026, 9, 17, 12).getTime(), [])
    const notes = [{ fileName: `${otherDay.replace(/, page 1$/, '')}, page 9.jpg` }, { fileName: 'Chapter 4.pdf' }]
    expect(photoNoteName(NOW, notes)).toBe(`${base}, page 1`)
  })
})
