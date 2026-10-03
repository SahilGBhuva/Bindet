import type { ReactNode } from 'react'
import { toneClass, type Tone } from '../lib/tones'

export { Icons } from './Icons'

export type ComingSoonItem = {
  title: string
  copy: string
  icon: ReactNode
  tone: Tone
}

/* Planned features, listed plainly in one ruled sheet. Styles live in pages/Placeholder.css. */
export function ComingSoonCards({ items, label }: { items: ComingSoonItem[]; label: string }) {
  return (
    <ul className="ui-panel ui-list coming-soon" aria-label={label}>
      {items.map((item) => (
        <li key={item.title} className={`coming-soon__item ${toneClass(item.tone)}`}>
          <span className="ui-icon" aria-hidden="true">{item.icon}</span>
          <span className="coming-soon__text">
            <span className="coming-soon__title">{item.title}</span>
            <span className="coming-soon__copy">{item.copy}</span>
          </span>
          <span className="ui-badge">Planned</span>
        </li>
      ))}
    </ul>
  )
}
