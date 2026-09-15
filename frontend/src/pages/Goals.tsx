import { ComingSoonCards, Icons } from '../components/ComingSoonCards'

export function Goals() {
  return (
    <div className="ui-page goals">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Goals</h1>
          <p className="ui-page-subtitle">Daily and weekly study goals will show up here.</p>
        </div>
      </header>
      <ComingSoonCards
        label="Planned goals"
        items={[
          { title: 'Daily', copy: 'A daily XP target, set from your daily goal in Settings.', icon: Icons.sun, tone: 'blue' },
          { title: 'Weekly', copy: 'A bigger target that spans the whole week.', icon: Icons.calendar, tone: 'violet' },
          { title: 'Rewards', copy: 'Something to unlock when you hit your goals.', icon: Icons.gift, tone: 'pink' },
        ]}
      />
    </div>
  )
}
