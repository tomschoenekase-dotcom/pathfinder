export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleMcpHttpRequest } from '@pathfinder/api/mcp'
import { env } from '@pathfinder/config'

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; venueId: string }> },
) {
  if (!env.AGENT_BRIDGE_HTTP_ENABLED) {
    return new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  return handleMcpHttpRequest(request, await context.params)
}
