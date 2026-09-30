export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleTokenRequest } from '@pathfinder/api/operator'

/** Authorization-code (S256 PKCE) and rotating refresh-token grants. */
export async function POST(request: Request) {
  return handleTokenRequest(request)
}
