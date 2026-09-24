import { isLocalProspectResearchRequest } from './local-prospect-research-boundary'

/** Separate, explicit opt-in. The original read-only directory endpoint stays read-only. */
export function isLocalProspectSalesRequest(
  headers: Pick<Headers, 'get'>,
  mutation: boolean,
  env: Record<string, string | undefined> = process.env,
) {
  if (!isLocalProspectResearchRequest(headers, env) || env.TORCHIKO_LOCAL_CRM_SALES_ENABLED !== '1')
    return false
  if (!mutation) return true
  return (
    headers.get('origin') === 'http://127.0.0.1:58618' &&
    headers.get('x-torchiko-no-send') === '1' &&
    headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
  )
}
