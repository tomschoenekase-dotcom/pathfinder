import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createLocalProviderStub,
  LOCAL_PROVIDER_HOST,
} from './local-provider-stub.mjs'

const server = createLocalProviderStub({
  port: 0,
  firstTokenDelayMs: 3,
  tokenCadenceMs: 0,
})
const requireAi = createRequire(fileURLToPath(new URL('../packages/ai/package.json', import.meta.url)))
let origin

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOCAL_PROVIDER_HOST, resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  assert.equal(address.address, LOCAL_PROVIDER_HOST)
  origin = `http://${LOCAL_PROVIDER_HOST}:${address.port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

function responseRequest(overrides = {}) {
  return {
    model: 'gpt-6-luna',
    instructions: 'Use only the invented local guide facts.',
    input: [{ role: 'user', content: 'What can I explore?' }],
    max_output_tokens: 512,
    reasoning: { effort: 'none' },
    store: false,
    ...overrides,
  }
}

test('health responds locally and binds only to IPv4 loopback', async () => {
  const response = await fetch(`${origin}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok', provider: 'local-fixture' })
})

test('Responses nonstream returns the SDK response shape with usage', async () => {
  const response = await fetch(`${origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseRequest()),
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.object, 'response')
  assert.equal(payload.status, 'completed')
  assert.equal(payload.model, 'gpt-6-luna')
  assert.match(payload.output_text, /^Welcome to the science museum, an invented local guide fixture\./u)
  assert.deepEqual(payload.output[0].content[0], {
    type: 'output_text',
    text: payload.output_text,
    annotations: [],
  })
  assert.ok(Number.isInteger(payload.usage.input_tokens))
  assert.ok(Number.isInteger(payload.usage.output_tokens))
  assert.equal(payload.usage.input_tokens_details.cached_tokens, 0)
})

test('Responses streaming emits text deltas and a terminal usage event as SSE', async () => {
  const response = await fetch(`${origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseRequest({ stream: true })),
  })
  const body = await response.text()
  const events = body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)))

  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.ok(events.some((event) => event.type === 'response.output_text.delta'))
  assert.equal(events.at(-1).type, 'response.completed')
  assert.equal(events.at(-1).response.status, 'completed')
  assert.equal(typeof events.at(-1).response.usage.input_tokens, 'number')
  assert.equal(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join(''), events.at(-1).response.output_text)
})

test('Responses fixture keeps a venue choice across turns and selects from prompt context', async () => {
  for (const [prompt, expected] of [
    ['Tell me about the science museum.', 'Welcome to the science museum, an invented local guide fixture.'],
    ['I want to see the small collection museum.', 'Welcome to the small collection museum, an invented local guide fixture.'],
    ['What is at the nature centre?', 'Welcome to the nature centre, an invented local guide fixture.'],
  ]) {
    const first = await fetch(`${origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(responseRequest({ input: [{ role: 'user', content: prompt }] })),
    })
    const firstText = (await first.json()).output_text
    assert.ok(firstText.startsWith(expected))

    const followUp = await fetch(`${origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        responseRequest({
          input: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: firstText },
            { role: 'user', content: 'What should I look for next?' },
          ],
        }),
      ),
    })
    assert.ok((await followUp.json()).output_text.startsWith(expected))
  }
})

test('every invented venue streams more than 40 words across at least three text deltas', async () => {
  for (const [prompt, expected] of [
    ['Tell me about the science museum.', 'Welcome to the science museum'],
    ['I want to see the small collection museum.', 'Welcome to the small collection museum'],
    ['What is at the nature centre?', 'Welcome to the nature centre'],
  ]) {
    const response = await fetch(`${origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        responseRequest({ input: [{ role: 'user', content: prompt }], stream: true }),
      ),
    })
    assert.equal(response.status, 200)
    const events = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)))
    const deltas = events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta)
    const terminal = events.at(-1)
    const text = deltas.join('')

    assert.match(text, new RegExp(`^${expected}`, 'u'))
    assert.ok(text.trim().split(/\s+/u).length > 40, `${expected} must exceed 40 words`)
    assert.ok(deltas.length >= 3, `${expected} must use at least three SSE text delta events`)
    assert.equal(terminal.type, 'response.completed')
    assert.equal(text, terminal.response.output_text)
  }
})

test('installed OpenAI SDK parses Responses SSE and decodes base64 embeddings', async () => {
  const imported = requireAi('openai')
  const OpenAI = imported.default ?? imported
  const client = new OpenAI({
    apiKey: 'local-fixture-test-only',
    baseURL: `${origin}/v1`,
    maxRetries: 0,
  })

  const stream = await client.responses.create({
    model: 'gpt-6-luna',
    instructions: 'Keep the invented nature centre context across turns.',
    input: [
      { role: 'user', content: 'What is at the nature centre?' },
      { role: 'assistant', content: 'The nature centre has outdoor trails and indoor displays.' },
      { role: 'user', content: 'What should I see next?' },
    ],
    max_output_tokens: 512,
    reasoning: { effort: 'none' },
    store: false,
    stream: true,
  })
  const events = []
  for await (const event of stream) events.push(event)
  const deltas = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
  const terminal = events.at(-1)
  assert.ok(deltas.join('').startsWith('Welcome to the nature centre, an invented local guide fixture.'))
  assert.equal(terminal.type, 'response.completed')
  assert.equal(terminal.response.status, 'completed')
  assert.equal(terminal.response.usage.input_tokens_details.cached_tokens, 0)

  const embeddings = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: ['first SDK phrase', 'second SDK phrase'],
    dimensions: 1_536,
  })
  assert.deepEqual(embeddings.data.map((item) => item.index), [0, 1])
  assert.ok(embeddings.data.every((item) => Array.isArray(item.embedding)))
  assert.ok(embeddings.data.every((item) => item.embedding.length === 1_536))
  assert.equal(embeddings.data[0].embedding.find((value) => value === 1), 1)
  assert.equal(embeddings.usage.prompt_tokens, 9)
})

test('embeddings require base64 wire format and return indexed little-endian float32 vectors', async () => {
  const input = ['first invented phrase', 'second invented phrase']
  const response = await fetch(`${origin}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input,
      dimensions: 1_536,
      encoding_format: 'base64',
    }),
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.model, 'text-embedding-3-small')
  assert.deepEqual(payload.data.map((item) => item.index), [0, 1])
  assert.ok(payload.data.every((item) => typeof item.embedding === 'string'))
  const vectors = payload.data.map((item) => {
    const bytes = Buffer.from(item.embedding, 'base64')
    assert.equal(bytes.length, 1_536 * Float32Array.BYTES_PER_ELEMENT)
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  })
  assert.equal(vectors[0].length, 1_536)
  assert.equal(vectors[1].length, 1_536)
  assert.equal(vectors[0].find((value) => value === 1), 1)
  assert.equal(vectors[1].find((value) => value === 1), 1)
  assert.deepEqual(payload.usage, { prompt_tokens: 11, total_tokens: 11 })
})

test('unknown paths, response models, embedding models, and embedding formats fail closed', async () => {
  const unknownPath = await fetch(`${origin}/v1/chat/completions`, { method: 'POST' })
  assert.equal(unknownPath.status, 404)

  const unknownModel = await fetch(`${origin}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseRequest({ model: 'unknown-model' })),
  })
  assert.equal(unknownModel.status, 400)
  assert.match((await unknownModel.json()).error.message, /Unknown/u)

  const badEmbeddingModel = await fetch(`${origin}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'unknown-model',
      input: ['invented'],
      dimensions: 1_536,
      encoding_format: 'base64',
    }),
  })
  assert.equal(badEmbeddingModel.status, 400)

  const badFormat = await fetch(`${origin}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: ['invented'],
      dimensions: 1_536,
      encoding_format: 'float',
    }),
  })
  assert.equal(badFormat.status, 400)
})

test('invalid timing and port settings are rejected', () => {
  assert.throws(() => createLocalProviderStub({ port: 65_536 }), /Invalid port/u)
  assert.throws(() => createLocalProviderStub({ firstTokenDelayMs: -1 }), /delay/u)
  assert.throws(() => createLocalProviderStub({ tokenCadenceMs: Number.NaN }), /cadence/u)
})

test('command line refuses a non-loopback bind address', () => {
  const scriptPath = fileURLToPath(new URL('./local-provider-stub.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--host', '0.0.0.0', '--port', '56344'],
    { encoding: 'utf8', timeout: 5_000 },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /must bind to 127\.0\.0\.1:56344/u)
})
