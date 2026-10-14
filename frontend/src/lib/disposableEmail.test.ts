import { describe, expect, it } from 'vitest'
import { isDisposableEmail } from './disposableEmail'

describe('isDisposableEmail', () => {
  it('flags addresses at known throwaway inbox services', () => {
    expect(isDisposableEmail('kid@mailinator.com')).toBe(true)
    expect(isDisposableEmail('kid@10minutemail.com')).toBe(true)
    expect(isDisposableEmail('kid@guerrillamail.org')).toBe(true)
  })

  it('still flags plus aliases on a throwaway domain', () => {
    expect(isDisposableEmail('kid+test@yopmail.com')).toBe(true)
  })

  it('flags any subdomain of a throwaway service', () => {
    expect(isDisposableEmail('kid@inbox.mailinator.com')).toBe(true)
    expect(isDisposableEmail('kid@a.b.sharklasers.com')).toBe(true)
  })

  it('ignores case, surrounding spaces and a trailing dot', () => {
    expect(isDisposableEmail('Kid@MAILINATOR.COM')).toBe(true)
    expect(isDisposableEmail('kid@mailinator.com.')).toBe(true)
    expect(isDisposableEmail('kid@mailinator.com..')).toBe(true)
    expect(isDisposableEmail('kid@ mailinator.com ')).toBe(true)
  })

  it('lets ordinary providers and school domains through', () => {
    for (const email of ['kid@gmail.com', 'kid@outlook.com', 'kid@icloud.com', 'k.id@students.springfield.k12.us', 'kid@yahoo.com']) {
      expect(isDisposableEmail(email)).toBe(false)
    }
  })

  it('does not match a throwaway name that is only part of a real domain', () => {
    // "mailinator.com.evil.org" is a different domain; only suffixes count.
    expect(isDisposableEmail('kid@mailinator.com.example.org')).toBe(false)
    expect(isDisposableEmail('kid@notmailinator.com')).toBe(false)
  })

  it('never treats a bare top-level domain as a match', () => {
    expect(isDisposableEmail('kid@com')).toBe(false)
  })

  it('uses the last @, so a throwaway domain in the local part does not count', () => {
    expect(isDisposableEmail('"mailinator.com"@gmail.com')).toBe(false)
    expect(isDisposableEmail('a@b@yopmail.com')).toBe(true)
  })

  it('returns false for strings without an address', () => {
    expect(isDisposableEmail('')).toBe(false)
    expect(isDisposableEmail('mailinator.com')).toBe(false)
    expect(isDisposableEmail('kid@')).toBe(false)
  })
})
