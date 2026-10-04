import type { DashboardTRPCClient } from './trpc'

/** The server-derived billing state returned by `billing.clientState`. */
export type ClientBillingStateData = Awaited<
  ReturnType<DashboardTRPCClient['billing']['clientState']['query']>
>

/**
 * What the browser knows. "loading" and "forbidden" exist only here: loading while a request is in
 * flight, forbidden when the server rejected the role. A failed request is always `error`; it is
 * never rendered as "no subscription", "paid" or a zero balance.
 */
export type ClientBillingViewState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error'; kind: 'retrieval' | 'configuration'; lastConfirmedAt: Date | null }
  | { status: 'ready'; data: ClientBillingStateData }

export function isForbiddenError(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code
  return code === 'FORBIDDEN'
}
