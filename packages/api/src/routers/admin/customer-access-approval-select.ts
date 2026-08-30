/**
 * Narrow customer-access evidence safe for Founder Control Room approval views.
 * Provider payloads and mutable execution details stay outside this projection.
 */
export const customerAccessApprovalSelect = {
  id: true,
  targetEmail: true,
  requestedRole: true,
  status: true,
  supportRequestId: true,
  sourceSupportMessageId: true,
  providerInvitationId: true,
  updatedAt: true,
} as const
