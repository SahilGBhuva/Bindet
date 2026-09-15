import type { ReactNode } from 'react'
import { toneClass, type Tone } from '../lib/tones'

export { Icons } from './Icons'

export type ComingSoonItem = {
  title: string
  copy: string
  icon: ReactNode
  tone: Tone
}

/* Feature cards for sections that are planned but not built yet. */
export function ComingSoonCards({ items, label }: { items: ComingSoonItem[]; label: string }) {
  return (
    <ul className="ui-cards coming-soon" aria-label={label}>
      {items.map((item) => (
        <li key={item.title} className={`ui-card ${toneClass(item.tone)}`}>
          <span className="ui-icon">{item.icon}</span>
          <h2 className="ui-card__title">{item.title}</h2>
          <p className="ui-card__copy">{item.copy}</p>
          <div className="ui-card__footer">
            <span className="ui-badge ui-badge--tone">Coming soon</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
