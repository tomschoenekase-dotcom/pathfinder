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
