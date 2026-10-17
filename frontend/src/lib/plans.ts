import { request, type Plan } from './api'

/* The #admin page: what this account may see there. 404 (a thrown error) for everyone else. */
export type AdminAccess = { feedback: boolean; plans: boolean }
export type PlanGrant = { email: string; plan: Exclude<Plan, 'free'>; note: string; granted_at: string }

export function getAdminAccess(accessToken?: string) {
  return request<AdminAccess>('/api/admin/access', undefined, accessToken)
}

export function listPlanGrants(accessToken?: string) {
  return request<{ grants: PlanGrant[] }>('/api/admin/plans', undefined, accessToken).then((data) => data.grants)
}

export function grantPlan(entry: { email: string; plan: PlanGrant['plan']; note?: string }, accessToken?: string) {
  return request<PlanGrant>('/api/admin/plans', { method: 'POST', body: JSON.stringify(entry) }, accessToken)
}

export function revokePlan(email: string, accessToken?: string) {
  return request<{ removed: boolean }>('/api/admin/plans/revoke', { method: 'POST', body: JSON.stringify({ email }) }, accessToken)
}
