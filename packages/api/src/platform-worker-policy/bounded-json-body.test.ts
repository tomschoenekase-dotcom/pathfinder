import { describe, expect, it, vi } from 'vitest'

import { readBoundedJsonBody } from './bounded-json-body'

function request(
  body: string | ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
) {
  const init = { method: 'POST', body, headers } as ConstructorParameters<typeof Request>[1] & {
    duplex?: 'half'
  }
  if (body instanceof ReadableStream) init!.duplex = 'half'
  return new Request('http://localhost/platform-worker', init)
}

describe('platform worker bounded JSON body', () => {
  it('parses a bounded streamed body', async () => {
    await expect(readBoundedJsonBody(request('{"ok":true}'), 32)).resolves.toEqual({ ok: true })
  })

  it.each(['33', '-1', 'private'])('rejects unsafe declared lengths: %s', async (value) => {
    await expect(
      readBoundedJsonBody(request('{}', { 'content-length': value }), 32),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
  })

  it('cancels an oversized chunked body', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(33))
      },
      cancel,
    })

    await expect(readBoundedJsonBody(request(stream), 32)).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a stalled body at one full-read deadline', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })

    await expect(readBoundedJsonBody(request(stream), 32, { timeoutMs: 10 })).rejects.toMatchObject(
      {
        code: 'BODY_TIMEOUT',
      },
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('supports an explicitly admitted empty value', async () => {
    await expect(readBoundedJsonBody(request(null), 32, { emptyValue: {} })).resolves.toEqual({})
  })

  it('fails closed on malformed JSON and an unadmitted empty body', async () => {
    await expect(readBoundedJsonBody(request('{'), 32)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    })
    await expect(readBoundedJsonBody(request(null), 32)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    })
  })
})
