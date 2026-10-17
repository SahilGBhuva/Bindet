import { describe, expect, it } from 'vitest'
import { addMonths, daysBetween, dueCountdown, groupByDay, isWeekend, monthGrid, monthStart, moveDay, sameMonth, weekDays, weekStart } from './calendar'

describe('calendar date math', () => {
  it('finds the start of the month and week', () => {
    expect(monthStart('2026-10-16')).toBe('2026-10-01')
    expect(weekStart('2026-10-16')).toBe('2026-10-11') // Friday → Sunday
    expect(weekStart('2026-10-11')).toBe('2026-10-11')
    expect(weekStart('2026-11-01')).toBe('2026-11-01')
  })

  it('lists a week from Sunday to Saturday, across month and year ends', () => {
    expect(weekDays('2026-10-16')).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'])
    expect(weekDays('2026-12-31')).toEqual(['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  })

  it('builds whole weeks covering the month, without a trailing empty week', () => {
    const october = monthGrid('2026-10-16')
    expect(october).toHaveLength(5)
    expect(october[0][0]).toBe('2026-09-27')
    expect(october[4][6]).toBe('2026-10-31')
    expect(october.every((week) => week.length === 7)).toBe(true)

    // February 2026 starts on a Sunday and has exactly four weeks.
    const february = monthGrid('2026-02-10')
    expect(february).toHaveLength(4)
    expect(february[0][0]).toBe('2026-02-01')
    expect(february[3][6]).toBe('2026-02-28')

    // August 2026 starts on a Saturday and needs six rows.
    const august = monthGrid('2026-08-01')
    expect(august).toHaveLength(6)
    expect(august[5][1]).toBe('2026-08-31')
  })

  it('moves by months and clamps to shorter months', () => {
    expect(addMonths('2026-10-16', 1)).toBe('2026-11-16')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
  })

  it('compares months and spots weekends', () => {
    expect(sameMonth('2026-10-01', '2026-10-31')).toBe(true)
    expect(sameMonth('2026-10-31', '2026-11-01')).toBe(false)
    expect(isWeekend('2026-10-17')).toBe(true)
    expect(isWeekend('2026-10-18')).toBe(true)
    expect(isWeekend('2026-10-16')).toBe(false)
  })

  it('maps keys to the next focused day', () => {
    expect(moveDay('2026-10-16', 'ArrowRight')).toBe('2026-10-17')
    expect(moveDay('2026-10-01', 'ArrowLeft')).toBe('2026-09-30')
    expect(moveDay('2026-10-16', 'ArrowDown')).toBe('2026-10-23')
    expect(moveDay('2026-10-02', 'ArrowUp')).toBe('2026-09-25')
    expect(moveDay('2026-10-16', 'Home')).toBe('2026-10-11')
    expect(moveDay('2026-10-16', 'End')).toBe('2026-10-17')
    expect(moveDay('2026-10-31', 'PageDown')).toBe('2026-11-30')
    expect(moveDay('2026-10-16', 'Enter')).toBeNull()
  })

  it('groups dated items by day and skips undated ones', () => {
    const items = [
      { id: 'a', due_date: '2026-10-16' },
      { id: 'b', due_date: null },
      { id: 'c', due_date: '2026-10-16' },
      { id: 'd', due_date: '2026-10-20' },
    ]
    const byDay = groupByDay(items)
    expect(byDay.get('2026-10-16')?.map((item) => item.id)).toEqual(['a', 'c'])
    expect(byDay.get('2026-10-20')?.map((item) => item.id)).toEqual(['d'])
    expect(byDay.size).toBe(2)
  })

  it('counts days and words countdowns', () => {
    expect(daysBetween('2026-10-16', '2026-10-18')).toBe(2)
    expect(daysBetween('2026-10-16', '2026-10-09')).toBe(-7)
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2) // across the US spring-forward weekend
    expect(dueCountdown('2026-10-16', '2026-10-16')).toBe('today')
    expect(dueCountdown('2026-10-17', '2026-10-16')).toBe('tomorrow')
    expect(dueCountdown('2026-10-21', '2026-10-16')).toBe('in 5 days')
    expect(dueCountdown('2026-10-15', '2026-10-16')).toBe('yesterday')
    expect(dueCountdown('2026-10-13', '2026-10-16')).toBe('3 days ago')
  })
})
