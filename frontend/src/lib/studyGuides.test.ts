import { describe, expect, it, vi } from 'vitest'
import { guideFileName, guideFromAttachment, guideHash, guideKind, guideMarkdown, guidePlainText, type GuideSection } from './studyGuides'

// studyGuides imports api.ts, which listens on window when it loads (vi.hoisted runs before imports).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

const section = (overrides: Partial<GuideSection>): GuideSection => ({ heading: 'Key ideas', bullets: [], terms: [], items: [], ...overrides })

describe('guideKind', () => {
  it('finds a kind and falls back to the study guide', () => {
    expect(guideKind('vocabulary').label).toBe('Vocabulary list')
    expect(guideKind('nonsense').id).toBe('study_guide')
  })
})

describe('guideFromAttachment', () => {
  const id = '0b7c2f5e-1a2b-4c3d-8e9f-001122334455'

  it('reads a guide attachment on one of Otto’s messages', () => {
    expect(guideFromAttachment(`guide:${id}:cheat_sheet`)).toEqual({ id, kind: 'cheat_sheet' })
  })

  it('maps an unknown kind to the study guide', () => {
    expect(guideFromAttachment(`guide:${id}:poem`)).toEqual({ id, kind: 'study_guide' })
  })

  it('rejects anything that is not exactly a guide id', () => {
    expect(guideFromAttachment('guide:../../etc:summary')).toBeNull()
    expect(guideFromAttachment(`image:${id}:summary`)).toBeNull()
    expect(guideFromAttachment(`guide:${id}:summary extra`)).toBeNull()
    expect(guideFromAttachment(`guide:${id.toUpperCase()}:summary`)).toBeNull()
  })
})

describe('guideHash and guideFileName', () => {
  it('encodes the guide id in the Study link', () => {
    expect(guideHash('a b&c')).toBe('#tools?guide=a%20b%26c')
  })

  it('makes a safe, readable file name', () => {
    expect(guideFileName('Cell Biology: Unit 2!', 'md')).toBe('cell-biology-unit-2.md')
    expect(guideFileName('Évolution & Darwin', 'txt')).toBe('evolution-darwin.txt')
  })

  it('falls back when nothing usable is left, and caps the length', () => {
    expect(guideFileName('???', 'md')).toBe('study-guide.md')
    expect(guideFileName('a'.repeat(100), 'txt')).toBe(`${'a'.repeat(60)}.txt`)
  })
})

describe('guideMarkdown and guidePlainText', () => {
  const guide = {
    title: 'Cells',
    course: 'Biology',
    unit: 'Unit 2',
    kind: 'study_guide' as const,
    sections: [
      section({ bullets: ['Cells are the unit of life'], terms: [{ term: 'Organelle', definition: 'A part of a cell' }] }),
      section({ heading: 'Practice', items: [{ question: 'What makes ATP?\nName it.', answer: 'Mitochondria\nThe powerhouse' }] }),
    ],
  }

  it('writes Markdown with headings, bullets, bold terms and numbered questions', () => {
    expect(guideMarkdown(guide)).toBe([
      '# Cells',
      '',
      '_Study guide · Unit 2 · Biology · made by Otto from your notes in bindet_',
      '',
      '## Key ideas',
      '',
      '- Cells are the unit of life',
      '- **Organelle**: A part of a cell',
      '',
      '## Practice',
      '',
      '1. What makes ATP? Name it.',
      '',
      '   **Answer:** Mitochondria',
      '   The powerhouse',
      '',
    ].join('\n'))
  })

  it('labels a whole-course guide', () => {
    expect(guideMarkdown({ ...guide, unit: null })).toContain('· Whole course ·')
  })

  it('writes plain text for copying', () => {
    expect(guidePlainText(guide)).toBe([
      'Cells',
      '',
      'KEY IDEAS',
      '• Cells are the unit of life',
      '• Organelle: A part of a cell',
      '',
      'PRACTICE',
      '1. What makes ATP?\nName it.',
      '   Answer: Mitochondria',
      '   The powerhouse',
      '',
    ].join('\n'))
  })
})
