import { createLocalProspectGeographyClient } from '@pathfinder/api/prospect-geography-local'
import { z } from 'zod'
import superjson from 'superjson'
import { isLocalProspectResearchRequest } from '../../../../../lib/local-prospect-research-boundary'

export const dynamic = 'force-dynamic'
const headers = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
}
const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), { status, headers })
function caught(error: unknown) {
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return failure(400, 'The request does not match this geography operation.')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return failure(
    code === 'CONFLICT'
      ? 409
      : code === 'FORBIDDEN'
        ? 403
        : code === 'NOT_FOUND'
          ? 404
          : code === 'BAD_REQUEST'
            ? 400
            : 500,
    code === 'CONFLICT'
      ? 'Geography or proposal changed. Reload; retry only an identical unconfirmed proposal.'
      : code === 'FORBIDDEN'
        ? 'This geography operation is outside the current grant.'
        : 'Geography operation unavailable. No approval or send action was performed.',
  )
}
export async function GET(request: Request) {
  if (!isLocalProspectResearchRequest(request.headers)) return failure(404, 'Not found')
  const url = new URL(request.url),
    operation = url.searchParams.get('operation'),
    raw = url.searchParams.get('input') ?? '{}'
  if (
    !['territories', 'geography', 'records', 'proposals'].includes(operation ?? '') ||
    raw.length > 8000
  )
    return failure(400, 'Unsupported or oversized geography read')
  try {
    const caller = createLocalProspectGeographyClient(),
      input: unknown = JSON.parse(raw)
    const result =
      operation === 'territories'
        ? await caller.territories(input as Parameters<typeof caller.territories>[0])
        : operation === 'records'
          ? await caller.records(input as Parameters<typeof caller.records>[0])
          : operation === 'proposals'
            ? await caller.proposals(input)
            : await caller.geography(
                z
                  .object({ venueId: z.string().min(1).max(191) })
                  .strict()
                  .parse(input),
              )
    return new Response(superjson.stringify(result), { headers })
  } catch (error) {
    return caught(error)
  }
}
export async function POST(request: Request) {
  if (
    !isLocalProspectResearchRequest(request.headers) ||
    request.headers.get('origin') !== 'http://127.0.0.1:58618'
  )
    return failure(404, 'Not found')
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    return failure(400, 'JSON required')
  if (Number(request.headers.get('content-length')) > 24000)
    return failure(413, 'Proposal exceeds 24 KB')
  try {
    const caller = createLocalProspectGeographyClient(),
      reader = request.body?.getReader()
    if (!reader) return failure(400, 'Body required')
    let size = 0
    const chunks: Uint8Array[] = []
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 24000) {
          await reader.cancel()
          return failure(413, 'Proposal exceeds 24 KB')
        }
        chunks.push(part.value)
      }
    } finally {
      reader.releaseLock()
    }
    const all = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      all.set(chunk, offset)
      offset += chunk.byteLength
    }
    const body = z
      .object({ operation: z.literal('propose'), input: z.unknown() })
      .strict()
      .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)))
    const result = await caller.propose(body.input)
    return new Response(superjson.stringify(result), { headers })
  } catch (error) {
    return caught(error)
  }
}
