import { getTRPCErrorFromUnknown } from '@trpc/server'

import { ChatSendInput, createTRPCContext, streamChatTurn } from '@pathfinder/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4_096
const encoder = new TextEncoder()

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('unsupported-content-type')
  }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body-too-large')

  if (!request.body) throw new Error('missing-body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let bodyComplete = false
  while (!bodyComplete) {
    const { done, value } = await reader.read()
    if (done) {
      bodyComplete = true
      continue
    }
    byteLength += value.byteLength
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel('body-too-large')
      throw new Error('body-too-large')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export async function POST(request: Request): Promise<Response> {
  let input: unknown
  try {
    input = await readBoundedJson(request)
  } catch {
    return Response.json({ error: 'invalid-request' }, { status: 400 })
  }
  const parsed = ChatSendInput.safeParse(input)
  if (!parsed.success) return Response.json({ error: 'invalid-request' }, { status: 400 })

  const context = await createTRPCContext({ req: request })
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of streamChatTurn(context, parsed.data)) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
      } catch (cause) {
        const error = getTRPCErrorFromUnknown(cause)
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: 'error', code: error.code })}\n`),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/x-ndjson; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })
}
