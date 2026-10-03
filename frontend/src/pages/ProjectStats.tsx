import type { AuthSession } from '../lib/auth'

export function ProjectStats({ session }: { session: AuthSession | null }) {
  return <div className="ui-page"><h1 className="ui-page-title">Project statistics</h1>{session ? null : null}</div>
}
