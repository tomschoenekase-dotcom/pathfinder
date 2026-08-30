import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(),
  stream: vi.fn(),
  safeParse: vi.fn(),
}))

vi.mock('@pathfinder/api', () => ({
  ChatSendInput: { safeParse: mocks.safeParse },
  createTRPCContext: mocks.createContext,
  streamChatTurn: mocks.stream,
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
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')
    expect((await response.text()).trim().split('\n')).toHaveLength(2)
    expect(mocks.stream).toHaveBeenCalledWith({ scope: 'anonymous' }, input)
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
})
