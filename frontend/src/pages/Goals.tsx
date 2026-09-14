const GOAL_TYPES = ['Daily', 'Weekly', 'Rewards']

export function Goals() {
  return (
    <div className="ui-page goals">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Goals</h1>
          <p className="ui-page-subtitle">Daily and weekly study goals will show up here.</p>
        </div>
      </header>

      <div className="ui-panel">
        <ul className="ui-list">
          {GOAL_TYPES.map((type) => (
            <li key={type} className="ui-row">
              <div className="ui-row__main">
                <span className="ui-row__title">{type}</span>
              </div>
              <span className="ui-badge">Coming soon</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
