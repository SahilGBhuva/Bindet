import { describe, expect, it } from 'vitest'
import { addDays, isoDay, lowerMeridiem, parseDay } from './time'

describe('lowerMeridiem', () => {
  it('lowercases AM/PM with an ordinary space', () => {
    expect(lowerMeridiem('10:43 AM')).toBe('10:43 am')
    expect(lowerMeridiem('Oct 13, 10:43 PM')).toBe('Oct 13, 10:43 pm')
  })

  it('replaces the narrow no-break space some locales put before the marker', () => {
    expect(lowerMeridiem('10:43 PM')).toBe('10:43 pm')
  })

  it('lowercases the markers Intl produces for real locales', () => {
    // en-US/fil use "PM", en-GB/en-IN already "pm", es-US "p.m.".
    expect(lowerMeridiem('10:43 PM')).toBe('10:43 pm')
    expect(lowerMeridiem('10:43 pm')).toBe('10:43 pm')
    expect(lowerMeridiem('10:43 p.m.')).toBe('10:43 pm')
  })

  it('handles dotted markers', () => {
    expect(lowerMeridiem('9:05 a.m.')).toBe('9:05 am')
    expect(lowerMeridiem('9:05 P.M.')).toBe('9:05 pm')
  })

  it('leaves 24-hour times alone', () => {
    expect(lowerMeridiem('22:43')).toBe('22:43')
  })

  it('does not touch words that merely start with am/pm', () => {
    expect(lowerMeridiem('AMPLE time')).toBe('AMPLE time')
    expect(lowerMeridiem('PMS')).toBe('PMS')
  })
})

describe('isoDay', () => {
  it('formats the local calendar day with zero padding', () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isoDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })

  it('uses the local day, not the UTC day', () => {
    // Just before local midnight is still the same local day in every time zone.
    expect(isoDay(new Date(2026, 9, 14, 23, 59, 59))).toBe('2026-10-14')
    expect(isoDay(new Date(2026, 9, 14, 0, 0, 1))).toBe('2026-10-14')
  })
})

describe('parseDay', () => {
  it('reads a YYYY-MM-DD day as local midnight', () => {
    const date = parseDay('2026-03-09')
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).toEqual([2026, 2, 9, 0, 0])
  })

  it('round-trips with isoDay', () => {
    for (const day of ['2024-02-29', '2026-01-01', '2026-12-31', '2027-07-04']) {
      expect(isoDay(parseDay(day))).toBe(day)
    }
  })
})

describe('addDays', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('knows leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
  })

  it('counts calendar days across daylight-saving changes', () => {
    // US clocks change on 2026-03-08 and 2026-11-01; a calendar day is still one day.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02')
  })

  it('returns the same day for zero', () => {
    expect(addDays('2026-10-14', 0)).toBe('2026-10-14')
  })
})
