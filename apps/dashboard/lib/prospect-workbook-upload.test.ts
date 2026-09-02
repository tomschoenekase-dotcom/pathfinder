import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROSPECT_WORKBOOK_UPLOAD_ERROR, uploadProspectWorkbook } from './prospect-workbook-upload'

function workbookFile() {
  return new File(['venue_name\nNorthstar'], 'prospects.csv', { type: 'text/csv' })
}

describe('uploadProspectWorkbook', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('accepts a successful immutable upload and cancels its unused response body', async () => {
    const cancel = vi.fn()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }))
    const file = workbookFile()

    await uploadProspectWorkbook({
      url: 'https://storage.example.test/reserved',
      requiredHeaders: { 'x-upload-token': 'bounded' },
      file,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://storage.example.test/reserved',
      expect.objectContaining({
        method: 'PUT',
        body: file,
        headers: { 'x-upload-token': 'bounded' },
        signal: expect.any(AbortSignal),
      }),
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects storage failures with fixed operator-safe copy and cancels the response', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }),
    )

    await expect(
      uploadProspectWorkbook({
        url: 'https://storage.example.test/reserved',
        requiredHeaders: {},
        file: workbookFile(),
      }),
    ).rejects.toThrow(PROSPECT_WORKBOOK_UPLOAD_ERROR)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts a stalled upload at the fixed two-minute deadline', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })

    const rejection = expect(
      uploadProspectWorkbook({
        url: 'https://storage.example.test/reserved',
        requiredHeaders: {},
        file: workbookFile(),
      }),
    ).rejects.toThrow(PROSPECT_WORKBOOK_UPLOAD_ERROR)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)

    await rejection
    expect(observedSignal?.aborted).toBe(true)
  })

  it('cancels a response that arrives after the deadline instead of leaking its body', async () => {
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
      uploadProspectWorkbook({
        url: 'https://storage.example.test/reserved',
        requiredHeaders: {},
        file: workbookFile(),
      }),
    ).rejects.toThrow(PROSPECT_WORKBOOK_UPLOAD_ERROR)

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await rejection
    resolveFetch?.(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }))
    await Promise.resolve()

    expect(cancel).toHaveBeenCalledOnce()
  })
})
