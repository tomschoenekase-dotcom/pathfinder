export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { handleAgentBridgeHttpRequest } from '@pathfinder/api/agent-bridge'
import { env } from '@pathfinder/config'

export async function POST(
  request: Request,
  context: { params: Promise<{ tenantId: string; venueId: string }> },
) {
  if (!env.AGENT_BRIDGE_HTTP_ENABLED) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  return handleAgentBridgeHttpRequest(request, await context.params)
}
