export const SCREENS = ['home', 'tools', 'tutor', 'goals', 'stats', 'progress', 'games', 'chat', 'profile', 'settings', 'more'] as const
export type Screen = (typeof SCREENS)[number]

/* Legacy hashes that still open the right screen. */
export const SCREEN_ALIASES: Record<string, Screen> = { quests: 'goals', tasks: 'goals', assignments: 'goals', study: 'tools', project: 'stats', statistics: 'stats' }

/* The last page opened before Help, which feedback can include when the student allows it. */
let lastPage = ''
export function rememberPage(screen: string) {
  if (screen && screen !== 'more') lastPage = screen
}
export function pageBeforeHelp() {
  return lastPage
}
