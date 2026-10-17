import type { Plan } from './api'

/* The badge text for a plan, or '' for Free. */
export function planBadge(plan: Plan | undefined): string {
  return plan === 'pro' ? 'Pro' : plan === 'unlimited' ? 'Unlimited' : ''
}

export function planLabel(plan: Plan | undefined): string {
  return plan === 'pro' ? 'bindet Pro' : plan === 'unlimited' ? 'Unlimited (given by bindet)' : 'Free'
}

/* Settings, scrolled to the bindet Pro section. */
export const PLAN_SETTINGS_HASH = '#settings?section=plan'

/* Where a notification opens and the short label beside it. */
export function notificationHref(kind: string): string {
  return kind === 'plan_granted' ? PLAN_SETTINGS_HASH : '#profile'
}

export function notificationLabel(kind: string): string {
  return kind === 'plan_granted' ? 'Plan' : 'New'
}
