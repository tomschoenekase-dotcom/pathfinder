import type { SupportCompletionPackageFulfillment } from './agent-approval-policy'

export const SupportCompletionOutcome = ['UPDATED', 'NO_CHANGE', 'MIXED', 'RESOLVED'] as const
export type SupportCompletionOutcome = (typeof SupportCompletionOutcome)[number]

export function deriveSupportCompletionOutcome(
  fulfillment: SupportCompletionPackageFulfillment,
): SupportCompletionOutcome {
  if (fulfillment.contractVersion === 1) return 'RESOLVED'
  const packageMutation = fulfillment.guestObservability.effects.length > 0
  const contentMutation =
    'contentFulfillment' in fulfillment &&
    fulfillment.contentFulfillment.receipts.some(
      (receipt) => !('state' in receipt) || receipt.state === 'CURRENT',
    )
  const temporalMutation =
    'temporalFulfillment' in fulfillment && fulfillment.temporalFulfillment.receipts.length > 0
  const noChange =
    (fulfillment.contractVersion === 6 || fulfillment.contractVersion === 7) &&
    fulfillment.noChangeFulfillment.receipts.length > 0
  const declines =
    fulfillment.contractVersion === 7 &&
    fulfillment.proposalResolutionFulfillment.declines.length > 0
  const mutation = packageMutation || contentMutation || temporalMutation
  if (mutation && (noChange || declines)) return 'MIXED'
  if (mutation) return 'UPDATED'
  if (declines) return 'RESOLVED'
  if (noChange) return 'NO_CHANGE'
  return 'RESOLVED'
}
