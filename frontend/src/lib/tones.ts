export const TONES = ['blue', 'violet', 'green', 'orange', 'pink', 'teal', 'amber'] as const
export type Tone = (typeof TONES)[number]

export function toneClass(tone: Tone) {
  return `ui-tone--${tone}`
}

/* A stable color for a person or thing, so the same name always gets the same tone. */
export function toneForName(name: string): Tone {
  let n = 0
  for (let i = 0; i < name.length; i += 1) n = (n * 31 + name.charCodeAt(i)) >>> 0
  return TONES[n % TONES.length]
}

export function courseInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?'
}
