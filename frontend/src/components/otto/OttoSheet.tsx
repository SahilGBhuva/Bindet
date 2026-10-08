import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDrawer } from '../../lib/useDrawer'
import type { OttoProfile } from '../../lib/api'
import { OttoMemoryPanel } from './OttoMemoryPanel'
import { OttoPreferencesCompact } from './OttoPreferences'
import './Otto.css'

export type OttoSheetTab = 'talk' | 'memory'

/* The Otto page's "Personalize Otto" sheet: how Otto talks to you, and what Otto remembers. */
export function OttoSheet({ token, tab: initialTab = 'talk', defaultName, onClose, onSaved }: {
  token: string
  tab?: OttoSheetTab
  defaultName?: string
  onClose: () => void
  onSaved?: (profile: OttoProfile) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<OttoSheetTab>(initialTab)
  useDrawer({ open: true, onClose, panel })
  // A portal, so no stacking context of the page it opens from can cover it.
  return createPortal(
    <div className="ui-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={panel} className="ui-dialog otto-sheet" role="dialog" aria-modal="true" aria-labelledby="otto-sheet-title">
        <header className="ui-dialog__header">
          <h2 className="ui-dialog__title" id="otto-sheet-title">Personalize Otto</h2>
          <button type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="ui-tabs otto-sheet__tabs" role="tablist" aria-label="Otto settings">
          <button type="button" role="tab" id="otto-tab-talk" className="ui-tab" aria-selected={tab === 'talk'} aria-controls="otto-panel" onClick={() => setTab('talk')}>How Otto talks</button>
          <button type="button" role="tab" id="otto-tab-memory" className="ui-tab" aria-selected={tab === 'memory'} aria-controls="otto-panel" onClick={() => setTab('memory')}>What Otto remembers</button>
        </div>
        <div className="otto-sheet__body" id="otto-panel" role="tabpanel" aria-labelledby={tab === 'talk' ? 'otto-tab-talk' : 'otto-tab-memory'}>
          {tab === 'talk' ? <OttoPreferencesCompact token={token} defaultName={defaultName} onSaved={onSaved} /> : <OttoMemoryPanel token={token} />}
        </div>
      </div>
    </div>,
    document.body,
  )
}
