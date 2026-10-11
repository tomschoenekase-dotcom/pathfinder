import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  stream: vi.fn(),
  safeParse: vi.fn(),
  publicCode: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ logger: { error: mocks.logError } }))

vi.mock('@pathfinder/api', () => ({
  ChatSendInput: { safeParse: mocks.safeParse },
  createTRPCContext: mocks.createContext,
  streamChatTurn: mocks.stream,
  getPublicTRPCErrorCode: mocks.publicCode,
}))

import { POST } from './route'

const input = {
  venueId: 'venue-1',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
  message: 'Where is the café?',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.safeParse.mockReturnValue({ success: true, data: input })
  mocks.createContext.mockResolvedValue({ scope: 'anonymous' })
  mocks.stream.mockImplementation(async function* () {
    yield { type: 'delta', delta: 'Near', providerFirstTextMs: 20, requestFirstTextMs: 30 }
    yield { type: 'complete', result: { response: 'Nearby.', sessionId: 'session-1' } }
  })
  mocks.publicCode.mockReturnValue(null)
})

describe('private-body chat streaming route', () => {
  it('keeps visitor text in a bounded POST body and streams no-store NDJSON', async () => {
    const request = new Request('https://guide.example/api/chat-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const response = await POST(request)

    expect(request.url).not.toContain('Where')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect((await response.text()).trim().split('\n')).toHaveLength(2)
    expect(mocks.stream).toHaveBeenCalledWith({ scope: 'anonymous' }, input)
  })

  it('makes the first delta readable before the answer stream completes', async () => {
    let completed = false
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'delta', delta: 'First words' }
      await new Promise((resolve) => setTimeout(resolve, 40))
      completed = true
      yield { type: 'complete', result: { response: 'First words, then more.' } }
    })
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
    const reader = response.body!.getReader()

    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"delta":"First words"')
    expect(completed).toBe(false)

    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain('"type":"complete"')
    expect(completed).toBe(true)
    await reader.cancel()
  })

  it('rejects oversized input before context or execution', async () => {
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-length': '4097', 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(400)
    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
  })

  it('stops an undeclared oversized body before context or execution', async () => {
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(4_096) }),
      }),
    )
    expect(response.status).toBe(400)
    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
  })

  it('rejects non-JSON requests before context or execution', async () => {
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(input),
      }),
    )
    expect(response.status).toBe(400)
    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.stream).not.toHaveBeenCalled()
  })

  it('carries only an explicitly public recovery code in a stream error', async () => {
    mocks.stream.mockImplementation(async function* () {
      yield Promise.reject(new Error('private provider details'))
    })
    mocks.publicCode.mockReturnValue('OUTCOME_AMBIGUOUS')
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
    const body = await response.text()
    expect(body).toContain('OUTCOME_AMBIGUOUS')
    expect(body).not.toContain('private provider details')
    expect(mocks.logError).toHaveBeenCalledExactlyOnceWith({
      action: 'guest_chat.stream_failed',
      error: 'guest-chat-stream-failed',
      errorCode: 'INTERNAL_SERVER_ERROR',
      publicCode: 'OUTCOME_AMBIGUOUS',
      operationId: null,
      hadTextDelta: false,
    })
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('private provider details')
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain(input.message)
  })

  it('correlates a failure after text without logging content or claiming completion', async () => {
    const operationId = 'ed39d30b-3799-4d2f-a0f4-a866566e590e'
    mocks.safeParse.mockReturnValue({ success: true, data: { ...input, operationId } })
    mocks.stream.mockImplementation(async function* () {
      yield { type: 'delta', delta: 'Provisional private answer' }
      throw new Error('private database details')
    })
    const response = await POST(
      new Request('https://guide.example/api/chat-stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, operationId }),
      }),
    )
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(events.map((event) => event.type)).toEqual(['delta', 'error'])
    expect(events[1]).toEqual({ type: 'error', code: 'INTERNAL_SERVER_ERROR' })
    expect(mocks.logError).toHaveBeenCalledExactlyOnceWith({
      action: 'guest_chat.stream_failed',
      error: 'guest-chat-stream-failed',
      errorCode: 'INTERNAL_SERVER_ERROR',
      publicCode: null,
      operationId,
      hadTextDelta: true,
    })
    const log = JSON.stringify(mocks.logError.mock.calls)
    for (const privateValue of [
      input.message,
      input.anonymousToken,
      input.venueId,
      'Provisional private answer',
      'private database details',
    ])
      expect(log).not.toContain(privateValue)
  })
})
