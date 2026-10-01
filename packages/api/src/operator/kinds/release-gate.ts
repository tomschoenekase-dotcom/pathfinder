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

/** Having the identity provider email a sign-up link. A separate switch from creation. */
export function isCustomerInviteEnabled(
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return source.OPERATOR_CUSTOMER_INVITE_ENABLED === 'true'
}
