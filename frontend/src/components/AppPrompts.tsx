import { useData } from '../lib/dataSource'
import { applyUpdate, dismissInstall, dismissUpdate, promptInstall, useInstallDismissed, useInstallOffer, useOnline, useUpdateReady } from '../lib/pwa'
import './AppPrompts.css'

/* "A new version is ready": shown when a deploy has installed in the background. Reloads only when asked. */
export function UpdatePrompt() {
  const ready = useUpdateReady()
  if (!ready) return null
  return (
    <div className="app-update" role="status">
      <span>A new version of bindet is ready.</span>
      <button type="button" className="ui-button ui-button--primary ui-button--sm" onClick={applyUpdate}>Reload</button>
      <button type="button" className="app-update__close" aria-label="Later" title="Later" onClick={dismissUpdate}>×</button>
    </div>
  )
}

/* Offline: says what still works. The Study page shows its own, more specific notice. */
export function OfflineNotice() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="app-offline">
      <p className="ui-alert ui-alert--info" role="status">
        <span><strong>You’re offline.</strong> Saved flashcards still work in Study. Messages, Otto and anything new will be back when you reconnect.</span>
      </p>
    </div>
  )
}

/*
 * "Install bindet": Chromium's install prompt, or the Add to Home Screen hint on iOS Safari.
 * In the phone menu it can be dismissed for good (remembered on this device); Settings
 * always offers it while installing is possible. Never shown in the landing demo.
 */
export function InstallBindit({ place }: { place: 'menu' | 'settings' }) {
  const data = useData()
  const offer = useInstallOffer()
  const dismissed = useInstallDismissed()
  if (data.sandboxed || !offer || (place === 'menu' && dismissed)) return null
  if (place === 'settings') {
    return (
      <div className="settings__row">
        <div className="settings__row-text">
          <span className="settings__label">Install bindet</span>
          <span className="settings__hint">
            {offer === 'ios'
              ? 'In Safari, tap Share, then Add to Home Screen.'
              : 'Open bindet from your home screen or dock, like any other app. Saved flashcards work offline.'}
          </span>
        </div>
        {offer === 'prompt' ? <button type="button" className="ui-button ui-button--primary ui-button--sm" onClick={() => void promptInstall()}>Install</button> : null}
      </div>
    )
  }
  return (
    <div className="app-install">
      {offer === 'prompt'
        ? <button type="button" className="app-install__action" onClick={() => void promptInstall()}><InstallIcon />Install bindet</button>
        : <p className="app-install__hint"><InstallIcon />Install bindit: tap Share, then Add to Home Screen.</p>}
      <button type="button" className="app-install__close" aria-label="Don’t show again" title="Don’t show again" onClick={dismissInstall}>×</button>
    </div>
  )
}

function InstallIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="3" width="11" height="18" rx="2.5" />
      <path d="M12 7.5v7M9 11.5l3 3 3-3" />
    </svg>
  )
}
