const GAME_MODES = ['Arcade', 'Matches', 'High score']

export function Games() {
  return (
    <div className="ui-page games">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">Games</h1>
          <p className="ui-page-subtitle">Study games will land here. Pick a unit in Tools, then come back to play.</p>
        </div>
      </header>

      <div className="ui-panel">
        <ul className="ui-list">
          {GAME_MODES.map((mode) => (
            <li key={mode} className="ui-row">
              <div className="ui-row__main">
                <span className="ui-row__title">{mode}</span>
              </div>
              <span className="ui-badge">Coming soon</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
