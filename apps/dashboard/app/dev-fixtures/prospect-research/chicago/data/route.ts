import { createLocalChicagoIntelligenceCaller } from '@pathfinder/api/chicago-intelligence-local'
import {
  chicagoDirectoryInput,
  chicagoVenueInput,
  chicagoAddInput,
  chicagoChangeInput,
  chicagoDuplicateInput,
} from '@pathfinder/api/chicago-intelligence-contract'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import superjson from 'superjson'
import { isLocalProspectResearchRequest } from '../../../../../lib/local-prospect-research-boundary'

export const dynamic = 'force-dynamic'
const responseHeaders = {
  'Cache-Control': 'no-store, private',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json; charset=utf-8',
}
function failure(code: string, message: string, status: number) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: responseHeaders,
  })
}
function caught(error: unknown) {
  if (error instanceof SyntaxError) return failure('BAD_REQUEST', 'Malformed JSON request', 400)
  if (error instanceof z.ZodError)
    return failure('BAD_REQUEST', 'The Chicago request does not match its operation schema.', 400)
  if (error instanceof TRPCError)
    return failure(
      error.code,
      error.message.slice(0, 1000),
      error.code === 'CONFLICT'
        ? 409
        : error.code === 'FORBIDDEN'
          ? 403
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'BAD_REQUEST'
              ? 400
              : 500,
    )
  return failure(
    'INTERNAL_SERVER_ERROR',
    'The isolated Chicago fixture is unavailable or its environment boundary rejected this request.',
    500,
  )
}
export async function GET(request: Request) {
  if (!isLocalProspectResearchRequest(request.headers))
    return failure('NOT_FOUND', 'Not found', 404)
  const url = new URL(request.url)
  const operation = url.searchParams.get('operation')
  if (!['list', 'read', 'health'].includes(operation ?? ''))
    return failure('BAD_REQUEST', 'Unsupported Chicago read operation', 400)
  const raw = url.searchParams.get('input') ?? '{}'
  if (raw.length > 8000) return failure('BAD_REQUEST', 'Read input is too large', 400)
  try {
    const caller = createLocalChicagoIntelligenceCaller()
    const input: unknown = JSON.parse(raw)
    const result =
      operation === 'list'
        ? await caller.list(chicagoDirectoryInput.parse(input))
        : operation === 'read'
          ? await caller.read(chicagoVenueInput.parse(input))
          : await caller.health(z.object({}).strict().parse(input))
    return new Response(superjson.stringify(result), { headers: responseHeaders })
  } catch (error) {
    return caught(error)
  }
}
export async function POST(request: Request) {
  if (
    !isLocalProspectResearchRequest(request.headers) ||
    request.headers.get('origin') !== 'http://127.0.0.1:58618'
  )
    return failure('NOT_FOUND', 'Not found', 404)
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    return failure('BAD_REQUEST', 'JSON request required', 400)
  if (Number(request.headers.get('content-length')) > 32768)
    return failure('BAD_REQUEST', 'Request exceeds 32 KB', 413)
  try {
    // Recheck the database guard before consuming or dispatching any mutation input.
    const caller = createLocalChicagoIntelligenceCaller()
    const reader = request.body?.getReader()
    if (!reader) return failure('BAD_REQUEST', 'Request body required', 400)
    let length = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > 32768) {
        await reader.cancel()
        return failure('BAD_REQUEST', 'Request exceeds 32 KB', 413)
      }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const body = z
      .object({ operation: z.enum(['add', 'change', 'duplicate']), input: z.unknown() })
      .strict()
      .parse(JSON.parse(new TextDecoder().decode(bytes)))
    const result =
      body.operation === 'add'
        ? await caller.add(chicagoAddInput.parse(body.input))
        : body.operation === 'change'
          ? await caller.change(chicagoChangeInput.parse(body.input))
          : await caller.duplicate(chicagoDuplicateInput.parse(body.input))
    return new Response(superjson.stringify(result), { headers: responseHeaders })
  } catch (error) {
    return caught(error)
  }
}
