export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleRevocationRequest } from '@pathfinder/api/operator'

/** RFC 7009 token revocation. Revoking a refresh token revokes the whole grant. */
export async function POST(request: Request) {
  return handleRevocationRequest(request)
}
