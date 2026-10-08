export const SCREENS = ['home', 'tools', 'tutor', 'goals', 'stats', 'progress', 'games', 'chat', 'profile', 'settings', 'more'] as const
export type Screen = (typeof SCREENS)[number]

/* Legacy hashes that still open the right screen. */
export const SCREEN_ALIASES: Record<string, Screen> = { quests: 'goals', tasks: 'goals', assignments: 'goals', study: 'tools', project: 'stats', statistics: 'stats', more: 'settings', help: 'settings', feedback: 'settings' }

/* The last page opened before Settings (where Help & feedback lives), which feedback can include when the student allows it. */
let lastPage = ''
export function rememberPage(screen: string) {
  if (screen && screen !== 'more' && screen !== 'settings') lastPage = screen
}
export function pageBeforeHelp() {
  return lastPage
}
