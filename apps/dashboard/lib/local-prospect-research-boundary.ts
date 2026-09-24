/** Extra HTTP boundary for the existing development-only read adapter. */
export function isLocalProspectResearchRequest(
  requestHeaders: Pick<Headers, 'get'>,
  env: Record<string, string | undefined> = process.env,
) {
  if (
    env.NODE_ENV !== 'development' ||
    env.TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED !== '1' ||
    env.TORCHIKO_VISUAL_FIXTURES_ENABLED !== '1'
  )
    return false
  const host = requestHeaders.get('host')
  if (host !== '127.0.0.1:58618') return false
  const forwarded = requestHeaders.get('x-forwarded-host')
  if (forwarded && forwarded !== host) return false
  const origin = requestHeaders.get('origin')
  if (origin && origin !== 'http://127.0.0.1:58618') return false
  const site = requestHeaders.get('sec-fetch-site')
  return !site || site === 'same-origin' || site === 'none'
}
