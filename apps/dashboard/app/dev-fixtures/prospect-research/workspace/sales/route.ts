import { getNativeSalesWorkflow } from '@pathfinder/api/prospect-sales-workflow'
import { salesReadInput } from '@pathfinder/api/prospect-sales-contract'
import { localFirstSendRehearsalEnabled } from '@pathfinder/db'

import { isLocalProspectResearchRequest } from '../../../../../lib/local-prospect-research-boundary'

export const dynamic = 'force-dynamic'
const syntheticVenue = /^SYN-CRM-FIRSTSEND-VENUE-r\d+$/
const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
}
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers })

function safeFailure(error: unknown) {
  const value = error as { name?: string; message?: string; code?: string }
  if (value.name === 'ProspectSalesError')
    return reply(
      { error: value.message, SEND_AUTHORIZED: false, senderAvailable: false },
      value.code === 'NOT_FOUND' ? 404 : value.code === 'FORBIDDEN' ? 403 : 409,
    )
  return reply(
    {
      error: 'Synthetic sales fixture is unavailable',
      SEND_AUTHORIZED: false,
      senderAvailable: false,
    },
    400,
  )
}

function enabled(request: Request) {
  return localFirstSendRehearsalEnabled() && isLocalProspectResearchRequest(request.headers)
}

export async function GET(request: Request) {
  if (!enabled(request)) return reply({ error: 'Not found' }, 404)
  try {
    const input = salesReadInput.parse({
      venueId: new URL(request.url).searchParams.get('venueId'),
    })
    if (!syntheticVenue.test(input.venueId)) return reply({ error: 'Not found' }, 404)
    return reply(await getNativeSalesWorkflow(input.venueId))
  } catch (error) {
    return safeFailure(error)
  }
}
