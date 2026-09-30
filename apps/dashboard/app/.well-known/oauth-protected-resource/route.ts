export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleProtectedResourceMetadata } from '@pathfinder/api/operator'

/** RFC 9728 root metadata for the operator MCP resource. 404 unless OPERATOR_OAUTH_ENABLED. */
export async function GET() {
  return handleProtectedResourceMetadata()
}
