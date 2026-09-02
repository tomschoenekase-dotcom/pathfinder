import { afterEach, describe, expect, it, vi } from 'vitest'

import { putBlobWithDeadline, UploadDeadlineError } from './bounded-upload'

describe('putBlobWithDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns bounded response metadata and cancels the unused body', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 201,
        headers: { etag: 'part-1' },
      }),
    )

    const result = await putBlobWithDeadline({
      url: 'https://storage.example.test/part',
      body: new Blob(['part']),
      timeoutMs: 1_000,
    })

    expect(result).toMatchObject({ ok: true, status: 201 })
    expect(result.headers.get('etag')).toBe('part-1')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts a stalled request at its caller-owned deadline', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })
    const rejection = expect(
      putBlobWithDeadline({
        url: 'https://storage.example.test/part',
        body: new Blob(['part']),
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(UploadDeadlineError)

    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
    expect(observedSignal?.aborted).toBe(true)
  })

  it('preserves explicit caller cancellation as AbortError', async () => {
    const controller = new AbortController()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined))
    const rejection = expect(
      putBlobWithDeadline({
        url: 'https://storage.example.test/part',
        body: new Blob(['part']),
        signal: controller.signal,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()

    await rejection
  })

  it('cancels a response that arrives after the deadline', async () => {
    vi.useFakeTimers()
    let resolveFetch: ((response: Response) => void) | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const cancel = vi.fn()
    const rejection = expect(
      putBlobWithDeadline({
        url: 'https://storage.example.test/part',
        body: new Blob(['part']),
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(UploadDeadlineError)

    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    resolveFetch?.(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }))
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledOnce()
  })
})
