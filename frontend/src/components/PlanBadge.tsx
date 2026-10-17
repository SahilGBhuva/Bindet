import type { Plan } from '../lib/api'
import { planBadge } from '../lib/planLabels'

/* "Pro" (violet) or "Unlimited" (teal) next to a student's name; nothing for Free. */
export function PlanBadge({ plan, className = '' }: { plan: Plan | undefined; className?: string }) {
  const label = planBadge(plan)
  if (!label) return null
  return (
    <span className={`ui-badge ui-badge--tone ${plan === 'pro' ? 'ui-tone--violet' : 'ui-tone--teal'} plan-badge ${className}`.trim()} title={plan === 'pro' ? 'bindet Pro' : 'Unlimited, given by bindet'}>
      {label}
    </span>
  )
}
