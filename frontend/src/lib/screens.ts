export const SCREENS = ['home', 'tools', 'tutor', 'goals', 'progress', 'games', 'chat', 'profile', 'settings', 'more'] as const
export type Screen = (typeof SCREENS)[number]

/* Legacy hashes that still open the right screen. */
export const SCREEN_ALIASES: Record<string, Screen> = { quests: 'goals', tasks: 'goals', assignments: 'goals', study: 'tools' }
