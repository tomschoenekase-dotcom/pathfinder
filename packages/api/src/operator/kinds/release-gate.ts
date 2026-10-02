/**
 * The operator's campaign release adapter is dark unless a deployment turns it on. Read at call
 * time so a rollback of the flag takes effect on the next request, and never inferred from any
 * other flag. Turning it on does not enable delivery: the canonical release still needs the global
 * delivery control, a connected and explicitly enabled mailbox, and the 1 to 50 recipient canary.
 */
export function isCampaignReleaseEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.OPERATOR_CAMPAIGN_RELEASE_ENABLED === 'true'
}

/** Creating a customer organization at the identity provider. Dark unless a deployment turns it on. */
export function isCustomerCreateEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.OPERATOR_CUSTOMER_CREATE_ENABLED === 'true'
}

/**
 * Executing a reviewed offboarding plan: closes the customer's venues, stops its schedules,
 * revokes its credentials and suspends its members. Local effects only (no provider is called),
 * but it is customer-wide and hard to undo, so it is dark unless a deployment turns it on.
 */
export function isOffboardingExecutionEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.OPERATOR_OFFBOARDING_EXECUTION_ENABLED === 'true'
}

/** Having the identity provider email a sign-up link. A separate switch from creation. */
export function isCustomerInviteEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.OPERATOR_CUSTOMER_INVITE_ENABLED === 'true'
}

/**
 * Email copies of approved information requests, sent by the worker to a member's verified
 * address. Default off, read at call time, and never inferred from another flag. While off, the
 * portal post still happens and the email is recorded as not sent.
 */
export function isClientNotificationEmailEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.CLIENT_NOTIFICATION_EMAIL_ENABLED === 'true'
}
