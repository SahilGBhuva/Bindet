import type { ReactNode } from 'react'
import { Icons } from '../Icons'

/* Line icons for quests and badges, single color (they take the tone's text color). */
const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>

const OWN: Record<string, ReactNode> = {
  note: svg(<><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 12h7M9 16h5" /></>),
  cards: svg(<><rect x="3" y="7" width="13" height="13" rx="2" /><path d="M8 4h11a2 2 0 0 1 2 2v11" /></>),
  stack: svg(<><path d="m12 3 9 4.5-9 4.5-9-4.5z" /><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" /></>),
  chat: svg(<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />),
  heart: svg(<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />),
  people: Icons.users,
  moon: svg(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />),
  chest: svg(<><path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v9H4z" /><path d="M4 12h16M11 11h2v3h-2z" /></>),
  chestOpen: svg(<><path d="M4 12h16v7H4z" /><path d="M5 12 7 5h10l2 7M11 12h2v3h-2z" /><path d="M12 2v1.5M8.5 3l.8 1.2M15.5 3l-.8 1.2" /></>),
  freeze: svg(<><path d="M12 2v20M4.5 6.5l15 11M19.5 6.5l-15 11" /><path d="m9.5 3.5 2.5 2 2.5-2M9.5 20.5l2.5-2 2.5 2" /></>),
  x: svg(<path d="M6 6l12 12M18 6 6 18" />),
}

export function rewardIcon(name: string): ReactNode {
  return OWN[name] ?? (Icons as Record<string, ReactNode>)[name] ?? Icons.sparkle
}
