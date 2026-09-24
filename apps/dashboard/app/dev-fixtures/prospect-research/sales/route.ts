import {
  getNativeSalesWorkflow,
  applyNativeSalesAction,
} from '@pathfinder/api/prospect-sales-workflow'
import { salesLocalAction, salesReadInput } from '@pathfinder/api/prospect-sales-contract'
import { isLocalProspectSalesRequest } from '../../../../lib/local-prospect-sales-boundary'

export const dynamic = 'force-dynamic'
const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers })

function failure(error: unknown) {
  const value = error as { name?: string; message?: string; code?: string }
  // Bounded component/identity blockers are actionable; database/provider details never are.
  const message = [
    'ProspectSalesError',
    'ProspectOutreachError',
    'ProspectSendOutboxError',
  ].includes(value.name ?? '')
    ? value.message
    : 'Invalid or unavailable local sales preparation'
  return reply(
    { error: message, SEND_AUTHORIZED: false },
    ['ProspectSalesError', 'ProspectOutreachError', 'ProspectSendOutboxError'].includes(
      value.name ?? '',
    )
      ? value.code === 'FORBIDDEN'
        ? 403
        : value.code === 'NOT_FOUND'
          ? 404
          : 409
      : 400,
  )
}

export async function GET(request: Request) {
  if (!isLocalProspectSalesRequest(request.headers, false))
    return reply({ error: 'Not found' }, 404)
  try {
    const input = salesReadInput.parse({
      venueId: new URL(request.url).searchParams.get('venueId'),
    })
    return reply(await getNativeSalesWorkflow(input.venueId))
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  if (!isLocalProspectSalesRequest(request.headers, true)) return reply({ error: 'Not found' }, 404)
  const length = Number(request.headers.get('content-length') ?? 0)
  if (!Number.isFinite(length) || length > 64_000)
    return reply({ error: 'Bounded input required' }, 413)
  try {
    const reader = request.body?.getReader()
    if (!reader) return reply({ error: 'A local preparation action is required' }, 400)
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 64_000) {
        await reader.cancel()
        return reply({ error: 'Bounded input required' }, 413)
      }
      chunks.push(next.value)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const action = salesLocalAction.parse(JSON.parse(body))
    return reply(
      await applyNativeSalesAction(action, {
        type: 'SYSTEM',
        role: 'PLATFORM_ADMIN',
        id: 'synthetic:crm-meaning:local-operator',
      }),
    )
  } catch (error) {
    return failure(error)
  }
}
// No provider authentication, live queue release, provider dispatch or arbitrary RPC proxy.
// Rehearsal approval/release is server-restricted to isolated synthetic origins and a disabled FAKE account.
