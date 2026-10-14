import { describe, expect, it } from 'vitest'
import { accountDisplayName, suggestedUsername } from './accountName'
import type { AuthUser } from './auth'

const user = (metadata: Record<string, unknown>, email?: string): AuthUser => ({ id: 'u1', email, user_metadata: metadata })

describe('accountDisplayName', () => {
  it('prefers the chosen username, then the Google full name, then name', () => {
    expect(accountDisplayName(user({ username: 'maya_c', full_name: 'Maya Chen' }))).toBe('maya_c')
    expect(accountDisplayName(user({ full_name: ' Maya Chen ', name: 'M' }))).toBe('Maya Chen')
    expect(accountDisplayName(user({ name: 'Maya' }))).toBe('Maya')
  })

  it('ignores non-text metadata and missing users', () => {
    expect(accountDisplayName(user({ username: 42, full_name: null }))).toBe('')
    expect(accountDisplayName(null)).toBe('')
    expect(accountDisplayName(undefined)).toBe('')
  })

  it('caps the name at 40 characters', () => {
    expect(accountDisplayName(user({ full_name: 'x'.repeat(60) }))).toHaveLength(40)
  })
})

describe('suggestedUsername', () => {
  it('keeps a username that already fits the rule', () => {
    expect(suggestedUsername(user({ username: 'maya_c' }))).toBe('maya_c')
  })

  it('makes one from the Google name, dropping accents and symbols', () => {
    expect(suggestedUsername(user({ full_name: 'José María O’Neil' }))).toBe('jose_maria_o_neil')
  })

  it('cleans up a chosen username that does not fit the rule', () => {
    expect(suggestedUsername(user({ username: 'Maya-Chen!' }))).toBe('maya_chen')
  })

  it('falls back to the email’s local part', () => {
    expect(suggestedUsername(user({}, 'Kid.Smith+1@school.org'))).toBe('kid_smith_1')
  })

  it('stays within 24 characters and never ends with an underscore', () => {
    expect(suggestedUsername(user({ full_name: 'Alexandria Catherine Montgomery' }))).toBe('alexandria_catherine_mon')
    expect(suggestedUsername(user({ full_name: 'abcdefghijklmnopqrstuvw x' }))).toBe('abcdefghijklmnopqrstuvw')
  })

  it('pads names that are too short', () => {
    expect(suggestedUsername(user({ full_name: 'Al' }))).toBe('al_studies')
  })

  it('suggests nothing when no usable letters are left', () => {
    expect(suggestedUsername(user({ full_name: '!!!' }))).toBe('')
    expect(suggestedUsername(null)).toBe('')
  })
})
