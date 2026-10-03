import type { AuthSession } from '../lib/auth'

export function Tutor({ session }: { session: AuthSession | null }) {
  return <div className="ui-page"><header className="ui-page-header"><h1 className="ui-page-title">Tutor</h1></header>{session ? null : null}</div>
}
