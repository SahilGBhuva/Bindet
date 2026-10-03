import { ComingSoonCards, Icons } from '../components/ComingSoonCards'
import { toneClass } from '../lib/tones'
import './Placeholder.css'

const AVAILABLE = [
  { href: '#tools', title: 'Flashcards', copy: 'Open a unit in Study and flip through cards made from your notes.', icon: Icons.sparkle, tone: 'violet' as const },
  { href: '#tools', title: 'Quiz', copy: 'Test yourself on a unit at three levels of difficulty.', icon: Icons.target, tone: 'blue' as const },
  { href: '#tutor', title: 'Ask the tutor to quiz you', copy: 'Pick a course and unit, then ask for practice questions grounded in your notes.', icon: Icons.message, tone: 'teal' as const },
]

export function Games() {
  return (
    <div className="ui-page placeholder games">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Coming soon</span>
          <h1 className="ui-page-title">Practice lab</h1>
          <p className="ui-page-subtitle">Game-style practice built from your own units is on the way. It is not ready yet, so here is what already works today.</p>
        </div>
      </header>

      <section className="ui-section" aria-labelledby="practice-now">
        <div className="ui-section-head"><h2 className="ui-section-title" id="practice-now">Practice now</h2></div>
        <ul className="ui-panel placeholder__links">
          {AVAILABLE.map((item) => (
            <li key={item.title}>
              <a className="placeholder__link" href={item.href}>
                <span className={`ui-icon ${toneClass(item.tone)}`} aria-hidden="true">{item.icon}</span>
                <span className="placeholder__text">
                  <span className="placeholder__title">{item.title}</span>
                  <span className="placeholder__copy">{item.copy}</span>
                </span>
                <span className="placeholder__go" aria-hidden="true">{Icons.arrow}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="ui-section" aria-labelledby="practice-planned">
        <div className="ui-section-head"><h2 className="ui-section-title" id="practice-planned">What is coming</h2></div>
        <p className="placeholder__lede">Plans can change before release. Nothing here is available yet.</p>
        <ComingSoonCards
          label="Planned practice modes"
          items={[
            { title: 'Quick rounds', copy: 'Short timed rounds built from one unit, for a few spare minutes.', icon: Icons.bolt, tone: 'orange' },
            { title: 'Matches with friends', copy: 'Practice the same unit against friends or your study group.', icon: Icons.swords, tone: 'pink' },
            { title: 'Personal bests', copy: 'Your best runs per unit, kept in one place.', icon: Icons.trophy, tone: 'amber' },
          ]}
        />
      </section>
    </div>
  )
}
