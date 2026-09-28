import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_PROVIDER_HOST = '127.0.0.1'
export const LOCAL_PROVIDER_PORT = 56344

const RESPONSE_MODELS = new Set(['gpt-5-mini-2025-08-07', 'gpt-6-luna'])
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1_536
const MAX_REQUEST_BYTES = 1_048_576

const ANSWERS = [
  'Welcome to the science museum, an invented local guide fixture. Begin at the fictional Orbit Table, where turning a brass wheel makes a paper planet cross a painted night sky. The Pocket Weather Wall uses colored tiles to show a made-up storm moving over a tiny island. Nearby, a quiet reading nook has diagrams of imaginary moon gardens. You can explore in any order, pause between rooms, and ask for another detail about these sample exhibits.',
  'Welcome to the small collection museum, an invented local guide fixture. Its fictional Harbor Cabinet holds a blue ceramic cup, a postcard of a made-up island, and a brass key with no known lock. A rotating display pairs each object with a short story created for this sample venue. Look for the paper map beside the window and the little label explaining how curators care for fragile things. The rooms are compact, so take your time and choose one object to study closely.',
  'Welcome to the nature centre, an invented local guide fixture. The fictional Fern Loop passes a painted pond, a wooden listening post, and a small shelter with a made-up map of bird shapes. Indoors, the Seed Desk displays paper models of imaginary plants and explains how seeds travel in this sample story. Trail conditions and wildlife details here are fictional; check with local staff before a real visit. You can stay inside or ask for a gentle route through the invented grounds.',
]

function responseText(instructions, input) {
  const context = [
    typeof instructions === 'string' ? instructions : '',
    ...(Array.isArray(input)
      ? input.map((item) => (typeof item?.content === 'string' ? item.content : ''))
      : []),
  ].join(' ').toLowerCase()
  if (/nature cent(?:er|re)|wildlife|outdoor trail/u.test(context)) return ANSWERS[2]
  if (/small collection|collection museum|historic collection/u.test(context)) return ANSWERS[1]
  return ANSWERS[0]
}

function usageFor(text, input) {
  const inputText = [
    typeof input === 'string' ? input : '',
    ...(Array.isArray(input)
      ? input.map((item) => (typeof item?.content === 'string' ? item.content : ''))
      : []),
  ].join(' ')
  const inputTokens = Math.max(1, Math.ceil(inputText.length / 4))
  const outputTokens = Math.max(1, Math.ceil(text.length / 4))
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function outputItem(text) {
  return {
    id: 'msg_local_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

function completedResponse(text, input) {
  return {
    id: 'resp_local_fixture',
    object: 'response',
    created_at: 0,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: 'local-fixture',
    output: [outputItem(text)],
    output_text: text,
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: usageFor(text, input),
    user: null,
    metadata: {},
  }
}

function jsonError(response, status, message, type = 'invalid_request_error') {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify({ error: { message, type } }))
}

async function readJson(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_REQUEST_BYTES) throw new RangeError('request-too-large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SyntaxError('invalid-json')
  }
}

function validateResponseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object.'
  if (!RESPONSE_MODELS.has(body.model)) return 'Unknown local Responses model.'
  if (typeof body.instructions !== 'string' || !Array.isArray(body.input)) {
    return 'Expected instructions and an input message array.'
  }
  if (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1) {
    return 'Expected a positive max_output_tokens value.'
  }
  if (body.store !== false) return 'Local Responses must set store=false.'
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    return 'Expected stream to be a boolean.'
  }
  if (
    body.input.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        !['user', 'assistant'].includes(item.role) ||
        typeof item.content !== 'string',
    )
  ) {
    return 'Input messages must have user or assistant roles and string content.'
  }
  return null
}

function streamEvent(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

async function streamResponse(response, body, options) {
  const text = responseText(body.instructions, body.input)
  const terminalResponse = completedResponse(text, body.input)
  terminalResponse.model = body.model
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  })
  streamEvent(response, 'response.created', { response: { ...terminalResponse, status: 'in_progress', output: [] } })
  streamEvent(response, 'response.in_progress', { response: { ...terminalResponse, status: 'in_progress', output: [] } })

  const chunks = text.match(/\S+\s*/gu) ?? []
  for (let index = 0; index < chunks.length; index += 1) {
    await sleep(index === 0 ? options.firstTokenDelayMs : options.tokenCadenceMs)
    streamEvent(response, 'response.output_text.delta', {
      item_id: 'msg_local_fixture',
      output_index: 0,
      content_index: 0,
      delta: chunks[index],
    })
  }
  streamEvent(response, 'response.completed', { response: terminalResponse })
  response.end()
}

function embeddingVector(text, index) {
  let hash = 2_166_136_261 ^ index
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(cursor), 16_777_619) >>> 0
  }
  const vector = Buffer.alloc(EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT)
  vector.writeFloatLE(1, (hash % EMBEDDING_DIMENSIONS) * Float32Array.BYTES_PER_ELEMENT)
  vector.writeFloatLE(0.5, ((hash >>> 11) % EMBEDDING_DIMENSIONS) * Float32Array.BYTES_PER_ELEMENT)
  return vector.toString('base64')
}

function validateEmbeddingRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Expected a JSON object.'
  if (body.model !== EMBEDDING_MODEL) return 'Unknown local embeddings model.'
  if (!Array.isArray(body.input) || body.input.length === 0 || body.input.some((item) => typeof item !== 'string')) {
    return 'Expected a nonempty array of input strings.'
  }
  if (body.dimensions !== EMBEDDING_DIMENSIONS) return `Expected dimensions=${EMBEDDING_DIMENSIONS}.`
  if (body.encoding_format !== 'base64') return 'Expected encoding_format=base64.'
  return null
}

function tokenCount(input) {
  const text = input.join(' ')
  return Math.max(1, Math.ceil(text.length / 4))
}

async function handle(request, response, options) {
  const url = new URL(request.url ?? '/', `http://${LOCAL_PROVIDER_HOST}:${LOCAL_PROVIDER_PORT}`)
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify({ status: 'ok', provider: 'local-fixture' }))
    return
  }
  if (request.method !== 'POST' || !['/v1/responses', '/v1/embeddings'].includes(url.pathname)) {
    jsonError(response, 404, 'Unknown local provider route.', 'not_found_error')
    return
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    jsonError(response, 415, 'Content-Type must be application/json.')
    return
  }

  let body
  try {
    body = await readJson(request)
  } catch (error) {
    const tooLarge = error instanceof RangeError
    jsonError(response, tooLarge ? 413 : 400, tooLarge ? 'Request body is too large.' : 'Request body must be valid JSON.')
    return
  }

  if (url.pathname === '/v1/responses') {
    const invalid = validateResponseRequest(body)
    if (invalid) {
      jsonError(response, 400, invalid)
      return
    }
    if (body.stream === true) {
      await streamResponse(response, body, options)
      return
    }
    const text = responseText(body.instructions, body.input)
    const result = completedResponse(text, body.input)
    result.model = body.model
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(result))
    return
  }

  const invalid = validateEmbeddingRequest(body)
  if (invalid) {
    jsonError(response, 400, invalid)
    return
  }
  const data = body.input.map((text, index) => ({
    object: 'embedding',
    index,
    embedding: embeddingVector(text, index),
  }))
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(
    JSON.stringify({
      object: 'list',
      data,
      model: EMBEDDING_MODEL,
      usage: { prompt_tokens: tokenCount(body.input), total_tokens: tokenCount(body.input) },
    }),
  )
}

export function createLocalProviderStub({
  port = LOCAL_PROVIDER_PORT,
  firstTokenDelayMs = Number(process.env.TORCHIKO_LOCAL_PROVIDER_FIRST_TOKEN_DELAY_MS ?? 100),
  tokenCadenceMs = Number(process.env.TORCHIKO_LOCAL_PROVIDER_TOKEN_CADENCE_MS ?? 25),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('Invalid port.')
  if (!Number.isFinite(firstTokenDelayMs) || firstTokenDelayMs < 0) {
    throw new RangeError('First-token delay must be a nonnegative finite number.')
  }
  if (!Number.isFinite(tokenCadenceMs) || tokenCadenceMs < 0) {
    throw new RangeError('Token cadence must be a nonnegative finite number.')
  }
  const options = { firstTokenDelayMs, tokenCadenceMs }
  const server = createServer((request, response) => {
    void handle(request, response, options).catch(() => {
      if (!response.headersSent) jsonError(response, 500, 'Local provider fixture failed.', 'server_error')
      else response.destroy()
    })
  })
  server.requestTimeout = 5_000
  server.headersTimeout = 6_000
  return server
}

export async function startLocalProviderStub(options) {
  const server = createLocalProviderStub(options)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options?.port ?? LOCAL_PROVIDER_PORT, LOCAL_PROVIDER_HOST, resolve)
  })
  return server
}

function parseCliOptions(argv) {
  const options = { host: LOCAL_PROVIDER_HOST, port: LOCAL_PROVIDER_PORT }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === '--host' && value) {
      options.host = value
      index += 1
    } else if (name === '--port' && value && /^\d+$/u.test(value)) {
      options.port = Number(value)
      index += 1
    } else {
      throw new Error('Only --host 127.0.0.1 and --port 56344 are supported.')
    }
  }
  if (options.host !== LOCAL_PROVIDER_HOST || options.port !== LOCAL_PROVIDER_PORT) {
    throw new Error('The local provider stub must bind to 127.0.0.1:56344.')
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cliOptions = parseCliOptions(process.argv.slice(2))
    startLocalProviderStub(cliOptions).then((server) => {
      const address = server.address()
      process.stdout.write(`Local provider stub listening on http://${LOCAL_PROVIDER_HOST}:${address.port}\n`)
      const stop = () => server.close(() => process.exit(0))
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    }).catch((error) => {
      process.stderr.write(`Local provider stub failed to start: ${error.message}\n`)
      process.exitCode = 1
    })
  } catch (error) {
    process.stderr.write(`Local provider stub failed to start: ${error.message}\n`)
    process.exitCode = 1
  }
}
