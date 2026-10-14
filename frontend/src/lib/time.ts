/*
 * Times of day read the same everywhere: "10:43 am", "Oct 13, 10:43 pm".
 * The locale still decides the order and 12- or 24-hour clock; only an AM/PM marker
 * is lowercased and given an ordinary space.
 */

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function lowerMeridiem(text: string) {
  return text.replace(/\s?\b([AP])\.?M\.?(?![A-Za-z])/gi, (_, letter: string) => ` ${letter.toLowerCase()}m`)
}

/* "10:43 am" */
export function formatClockTime(value: Date | number) {
  return lowerMeridiem(clockFormat.format(value))
}

/*
 * Calendar days as "YYYY-MM-DD" on this device's clock (not the UTC day that
 * toISOString gives), which is how the server keeps due dates and "today".
 */
export function isoDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/* "2026-10-14" as local midnight of that day. */
export function parseDay(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/* The day `days` after (or before, when negative) a "YYYY-MM-DD" day. */
export function addDays(value: string, days: number) {
  const date = parseDay(value)
  date.setDate(date.getDate() + days)
  return isoDay(date)
}
