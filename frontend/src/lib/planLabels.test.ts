import { describe, expect, it } from 'vitest'
import { planBadge, planLabel } from './planLabels'

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
})
