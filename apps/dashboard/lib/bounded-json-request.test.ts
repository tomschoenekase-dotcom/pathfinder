import { describe, expect, it, vi } from 'vitest'

import { BoundedJsonRequestError, readBoundedJsonRequest } from './bounded-json-request'

function request(body: BodyInit | null, headers: HeadersInit = {}) {
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', body, headers }
  if (body instanceof ReadableStream) init.duplex = 'half'
  return new Request('https://dashboard.example/internal', init)
}

describe('readBoundedJsonRequest', () => {
  it('parses bounded streamed JSON', async () => {
    await expect(readBoundedJsonRequest(request('{"ok":true}'), { maxBytes: 32 })).resolves.toEqual(
      {
        ok: true,
      },
    )
  })

  it.each(['-1', '1.5', 'private'])(
    'rejects an invalid declared length without reading: %s',
    async (value) => {
      await expect(
        readBoundedJsonRequest(request('{}', { 'content-length': value }), { maxBytes: 32 }),
      ).rejects.toMatchObject({ code: 'INVALID_CONTENT_LENGTH' })
    },
  )

  it('rejects an oversized declared length before reading', async () => {
    await expect(
      readBoundedJsonRequest(request('{}', { 'content-length': '33' }), { maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
  })

  it('cancels an oversized undeclared stream', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(33))
      },
      cancel,
    })

    await expect(readBoundedJsonRequest(request(body), { maxBytes: 32 })).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a stalled stream at the full-body deadline', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })

    await expect(
      readBoundedJsonRequest(request(body), { maxBytes: 32, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'BODY_TIMEOUT' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['', '{', '"unterminated'])(
    'contains malformed content as INVALID_JSON',
    async (value) => {
      await expect(readBoundedJsonRequest(request(value), { maxBytes: 32 })).rejects.toEqual(
        new BoundedJsonRequestError('INVALID_JSON'),
      )
    },
  )
})
