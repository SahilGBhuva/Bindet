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
