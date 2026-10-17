import type { Plan } from './api'

/* The badge text for a plan, or '' for Free. */
export function planBadge(plan: Plan | undefined): string {
  return plan === 'pro' ? 'Pro' : plan === 'unlimited' ? 'Unlimited' : ''
}

export function planLabel(plan: Plan | undefined): string {
  return plan === 'pro' ? 'bindet Pro' : plan === 'unlimited' ? 'Unlimited (given by bindet)' : 'Free'
}
