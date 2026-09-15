import type { ReactNode } from 'react'

export type ComingSoonItem = {
  title: string
  copy: string
  icon: ReactNode
}

/* Feature cards for sections that are planned but not built yet. */
export function ComingSoonCards({ items, label }: { items: ComingSoonItem[]; label: string }) {
  return (
    <ul className="ui-cards coming-soon" aria-label={label}>
      {items.map((item) => (
        <li key={item.title} className="ui-card">
          <span className="ui-icon">{item.icon}</span>
          <h2 className="ui-card__title">{item.title}</h2>
          <p className="ui-card__copy">{item.copy}</p>
          <div className="ui-card__footer">
            <span className="ui-badge">Coming soon</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

const svg = (children: ReactNode) => <svg viewBox="0 0 24 24" aria-hidden="true">{children}</svg>

export const Icons = {
  sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  calendar: svg(<><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>),
  gift: svg(<><rect x="3.5" y="8" width="17" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3-5-1s3 1 5 1c2 0 5 1 5-1s-3.5-2-5 1" /></>),
  bolt: svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />),
  swords: svg(<><path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2" /><path d="M9.5 17.5 21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2" /></>),
  trophy: svg(<><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>),
  help: svg(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" /></>),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>),
  message: svg(<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />),
}
