import { ComingSoonCards, Icons } from '../components/ComingSoonCards'

export function Games() {
  return (
    <div className="ui-page games">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Games</h1>
          <p className="ui-page-subtitle">Study games will land here. Pick a unit in Tools, then come back to play.</p>
        </div>
      </header>
      <ComingSoonCards
        label="Planned games"
        items={[
          { title: 'Arcade', copy: 'Quick rounds built from a unit in Tools.', icon: Icons.bolt, tone: 'orange' },
          { title: 'Matches', copy: 'Practice against friends.', icon: Icons.swords, tone: 'teal' },
          { title: 'High score', copy: 'Your best runs, kept in one place.', icon: Icons.trophy, tone: 'violet' },
        ]}
      />
    </div>
  )
}
