import type { createDashboardCaller } from './server-caller'

type DashboardCaller = Awaited<ReturnType<typeof createDashboardCaller>>

/**
 * Billing appears in the portal only when both the environment kill switch and the tenant's
 * billing flag allow it. Any failure fails closed: the portal then says nothing about payment
 * rather than inventing a state.
 */
export async function resolvePaymentAvailable(caller: DashboardCaller): Promise<boolean> {
  if (process.env.STRIPE_BILLING_UI_ENABLED !== 'true') return false
  try {
    const billing = await caller.billing.overview()
    return billing.enabled
  } catch {
    return false
  }
}

/** Published Torchiko reports are capability-gated; an unavailable check fails closed. */
export async function resolveWeeklyReportsAvailable(caller: DashboardCaller): Promise<boolean> {
  try {
    const availability = await caller.analytics.getWeeklyReportAvailability()
    return availability.enabledVenueIds.length > 0
  } catch {
    return false
  }
}

/** Mirrors the Clerk organization roles that map to MANAGER or OWNER on the server. */
export function isManagerRole(orgRole: string | null | undefined, isPlatformAdmin: boolean) {
  return (
    isPlatformAdmin ||
    orgRole === 'org:admin' ||
    orgRole === 'org:manager' ||
    orgRole === 'org:owner'
  )
}

/** UI hint only; billing mutations remain OWNER-gated on the server. */
export function isOwnerRole(orgRole: string | null | undefined, isPlatformAdmin: boolean) {
  return isPlatformAdmin || orgRole === 'org:admin' || orgRole === 'org:owner'
}
