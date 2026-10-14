import { Component, type ReactNode } from 'react'
import { isChunkLoadError, reloadOnce } from '../lib/recover'

type Props = { children: ReactNode; label?: string }
type State = { error: unknown }

/*
 * Catches a page that crashed or failed to download, so the student sees a way out instead of
 * a blank screen. A missing page piece (a new version was deployed) reloads once on its own.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) reloadOnce()
  }

  render() {
    if (!this.state.error) return this.props.children
    const stale = isChunkLoadError(this.state.error)
    return (
      <div className="ui-empty" role="alert">
        <h2 className="ui-empty__title">{stale ? 'bindet was updated' : 'Something went wrong'}</h2>
        <p className="ui-empty__copy">
          {stale ? 'Reload to get the newest version. Your work is saved.' : `${this.props.label ?? 'This page'} couldn’t load. Reload to try again; your work is saved.`}
        </p>
        <button type="button" className="ui-button ui-button--primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
}
