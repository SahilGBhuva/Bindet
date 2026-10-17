import { describe, expect, it } from 'vitest'
import { notificationHref, notificationLabel, planBadge, planLabel, PLAN_SETTINGS_HASH } from './planLabels'

describe('plan labels', () => {
  it('shows a badge only for granted plans', () => {
    expect(planBadge('free')).toBe('')
    expect(planBadge(undefined)).toBe('')
    expect(planBadge('pro')).toBe('Pro')
    expect(planBadge('unlimited')).toBe('Unlimited')
  })

  it('names each plan for Settings', () => {
    expect(planLabel(undefined)).toBe('Free')
    expect(planLabel('pro')).toBe('bindet Pro')
    expect(planLabel('unlimited')).toBe('Unlimited (given by bindet)')
  })

  it('opens the plan section from a plan notification', () => {
    expect(notificationHref('plan_granted')).toBe(PLAN_SETTINGS_HASH)
    expect(PLAN_SETTINGS_HASH.split('?')[0]).toBe('#settings')
    expect(notificationHref('friend_request')).toBe('#profile')
    expect(notificationLabel('plan_granted')).toBe('Plan')
    expect(notificationLabel('streak_milestone')).toBe('New')
  })
})
