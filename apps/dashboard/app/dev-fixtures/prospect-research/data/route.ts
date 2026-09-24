import { createLocalProspectResearchReader } from '@pathfinder/api/prospect-research-reader'
import superjson from 'superjson'
import { isLocalProspectResearchRequest } from '../../../../lib/local-prospect-research-boundary'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const responseHeaders = {
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
  }
  if (!isLocalProspectResearchRequest(request.headers)) {
    return new Response('Not found', { status: 404, headers: responseHeaders })
  }
  const raw = new URL(request.url).searchParams.get('input') ?? '{}'
  if (raw.length > 4000)
    return new Response('Invalid read query', { status: 400, headers: responseHeaders })
  try {
    const reader = createLocalProspectResearchReader()
    const result = await reader.list(JSON.parse(raw))
    return new Response(superjson.stringify(result), {
      headers: { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    })
  } catch {
    return new Response('Invalid or unavailable local CRM read', {
      status: 400,
      headers: responseHeaders,
    })
  }
}
// There is deliberately no POST, PUT, PATCH, DELETE or general RPC proxy.
