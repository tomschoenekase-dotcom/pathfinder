export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleAuthorizationServerMetadata } from '@pathfinder/api/operator'

/** RFC 8414 metadata for the Dot operator. 404 unless OPERATOR_OAUTH_ENABLED. */
export async function GET() {
  return handleAuthorizationServerMetadata()
}
