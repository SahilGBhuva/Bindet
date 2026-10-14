import { describe, expect, it, vi } from 'vitest'

// helpBot imports api.ts, which listens on window when it loads. Node has no window,
// so give it a bare event target before the import runs (vi.hoisted runs first).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

import { HELP_EMAIL, HELP_FAQ, HELP_LINKS, helpEntry, isSmallTalk, matchHelp, normalizeWords, parseAnswer, SUGGESTED_HELP } from './helpBot'

describe('normalizeWords', () => {
  it('lowercases, drops punctuation and folds word endings', () => {
    expect(normalizeWords('Uploading PDFs?!')).toEqual(['upload', 'pdf'])
    expect(normalizeWords('uploaded uploads')).toEqual(['upload', 'upload'])
  })

  it('maps synonyms to one word', () => {
    expect(normalizeWords('picture pics image')).toEqual(['photo', 'photo', 'photo'])
    expect(normalizeWords('cards')).toEqual(['flashcard'])
    expect(normalizeWords('removing')).toEqual(['delete'])
  })

  it('removes apostrophes so contractions stay one word', () => {
    expect(normalizeWords('What’s')).toEqual(['what'])
    expect(normalizeWords("can't")).toEqual(['cant'])
  })

  it('does not mangle short words or double-s endings', () => {
    expect(normalizeWords('class pass bus')).toEqual(['course', 'pass', 'bus'])
    expect(normalizeWords('red')).toEqual(['red'])
  })
})

describe('matchHelp', () => {
  const match = (question: string) => matchHelp(question)?.entry.id ?? null

  it.each([
    ['How do I add notes from a photo?', 'photo-notes'],
    ['can i take a picture of my handwritten notes', 'photo-notes'],
    ['how do i upload a pdf', 'upload-notes'],
    ['How do I join a study group with an invite code?', 'join-group'],
    ['how do I delete my account', 'delete-account'],
    ['turn on dark mode', 'dark-mode'],
    ['How do XP and streaks work?', 'xp'],
    ['forgot password', 'password'],
  ])('answers %j locally with %s', (question, id) => {
    expect(match(question)).toBe(id)
  })

  it('answers every FAQ entry when asked its own question', () => {
    for (const entry of HELP_FAQ) expect(match(entry.question), entry.question).toBe(entry.id)
  })

  it('does not guess when the question is about something the FAQ does not cover', () => {
    expect(match('Can I print my flashcards?')).toBeNull()
    expect(match('what is the mitochondria')).toBeNull()
  })

  it('returns null for empty or stop-word-only questions', () => {
    expect(match('')).toBeNull()
    expect(match('   ')).toBeNull()
    expect(match('how do i')).toBeNull()
  })

  it('does not pick between two equally good answers', () => {
    // "group" alone points equally at joining, starting and leaving.
    expect(match('group')).toBeNull()
  })
})

describe('helpEntry and suggestions', () => {
  it('finds entries by id', () => {
    expect(helpEntry('review')?.question).toBe('What’s Review mode?')
    expect(helpEntry('missing')).toBeNull()
  })

  it('only suggests entries that exist', () => {
    for (const id of SUGGESTED_HELP) expect(helpEntry(id)).not.toBeNull()
  })

  it('has unique ids', () => {
    expect(new Set(HELP_FAQ.map((entry) => entry.id)).size).toBe(HELP_FAQ.length)
  })

  it('only links to pages on the allowlist in every answer', () => {
    for (const entry of HELP_FAQ) {
      for (const [, hash] of entry.answer.matchAll(/\((#[a-z]+(?:\?[a-z]+)?)\)/gi)) {
        expect(HELP_LINKS, `${entry.id} links to ${hash}`).toHaveProperty([hash])
      }
    }
  })
})

describe('isSmallTalk', () => {
  it('recognizes greetings and thanks', () => {
    for (const text of ['hi', 'Hiii', 'hello!', 'thanks', 'Thank you!!', 'ok', 'okay', 'good night', ' yo ']) {
      expect(isSmallTalk(text), text).toBe(true)
    }
  })

  it('does not swallow real questions that start with a greeting', () => {
    expect(isSmallTalk('hi how do I upload notes')).toBe(false)
    expect(isSmallTalk('thanks, but where is review mode?')).toBe(false)
  })
})

describe('parseAnswer', () => {
  it('turns bracketed page hashes into links and removes them from the text', () => {
    const { pieces, links } = parseAnswer('Open Study (#tools), then Home (#home).')
    expect(pieces).toEqual([{ text: 'Open Study, then Home.' }])
    expect(links).toEqual([{ href: '#tools', label: 'Study' }, { href: '#home', label: 'Home' }])
  })

  it('reads a bare allowed hash as the page name', () => {
    const { pieces, links } = parseAnswer('Go to #progress now.')
    expect(pieces).toEqual([{ text: 'Go to Progress now.' }])
    expect(links).toEqual([{ href: '#progress', label: 'Progress' }])
  })

  it('handles the help hash with a query', () => {
    expect(parseAnswer('See (#settings?help).').links).toEqual([{ href: '#settings?help', label: 'Help & feedback' }])
  })

  it('never links to pages outside the allowlist', () => {
    const { pieces, links } = parseAnswer('Try (#admin) or #javascript or (#evil?x).')
    expect(links).toEqual([])
    expect(pieces).toEqual([{ text: 'Try or javascript or.' }])
  })

  it('lists each page once even when mentioned twice, ignoring case', () => {
    expect(parseAnswer('(#tools) and (#TOOLS) and #tools').links).toEqual([{ href: '#tools', label: 'Study' }])
  })

  it('splits out the support email but no other address', () => {
    const { pieces } = parseAnswer(`Email ${HELP_EMAIL.toUpperCase()} or someone@example.com.`)
    expect(pieces).toEqual([{ text: 'Email ' }, { email: HELP_EMAIL }, { text: ' or someone@example.com.' }])
  })

  it('handles an answer that is only the email', () => {
    expect(parseAnswer(HELP_EMAIL).pieces).toEqual([{ email: HELP_EMAIL }])
  })
})
