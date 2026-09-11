import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { extractPdfDocumentText } from './pdf-text-extraction'

const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: pdfjs.getDocument }))

function loadingTask(input: { text?: string; destroy?: () => Promise<void> } = {}) {
  const cleanup = vi.fn()
  const getTextContent = vi.fn(async () => ({
    items: [{ str: input.text ?? 'bounded text', hasEOL: false }],
  }))
  const destroy = vi.fn(input.destroy ?? (async () => undefined))
  return {
    task: {
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn(async () => ({ getTextContent, cleanup })),
      }),
      destroy,
    },
    destroy,
  }
}

describe('PDF extraction deadline boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    pdfjs.getDocument.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('rejects a result when normalization crosses the deadline', async () => {
    const source = loadingTask()
    pdfjs.getDocument.mockReturnValue(source.task)
    const observedTimes = [0, 0, 0, 0, 0, 0, 0, 20, 20]
    vi.spyOn(Date, 'now').mockImplementation(() => observedTimes.shift() ?? 20)

    await expect(extractPdfDocumentText(new Uint8Array([1]), { timeoutMs: 10 })).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'PDF_EXTRACTION_TIMEOUT',
    })
  })

  it('rejects an otherwise successful result when cleanup finishes after the deadline', async () => {
    let finishCleanup: (() => void) | undefined
    const source = loadingTask({
      destroy: () => new Promise<void>((resolve) => (finishCleanup = resolve)),
    })
    pdfjs.getDocument.mockReturnValue(source.task)
    const extraction = extractPdfDocumentText(new Uint8Array([1]), { timeoutMs: 100 })
    await vi.waitFor(() => expect(source.destroy).toHaveBeenCalledOnce())
    vi.setSystemTime(200)
    finishCleanup?.()

    await expect(extraction).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'PDF_EXTRACTION_TIMEOUT',
    })
    expect(source.destroy).toHaveBeenCalledOnce()
  })

  it('classifies synchronous parser initialization failures without leaking them', async () => {
    pdfjs.getDocument.mockImplementation(() => {
      throw new Error('private parser initialization detail')
    })
    await expect(extractPdfDocumentText(new Uint8Array([1]))).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'PDF_PARSE_FAILED',
    })
  })

  it('stops a single oversized text item at the code-point limit', async () => {
    const source = loadingTask({ text: '😀'.repeat(500_001) })
    pdfjs.getDocument.mockReturnValue(source.task)
    await expect(extractPdfDocumentText(new Uint8Array([1]))).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'TEXT_TOO_LARGE',
    })
    expect(source.destroy).toHaveBeenCalledOnce()
  })
})
