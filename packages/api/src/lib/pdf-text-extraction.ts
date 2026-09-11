import { createHash } from 'node:crypto'

export const PDF_EXTRACTION_MAX_BYTES = 10 * 1024 * 1024
export const PDF_EXTRACTION_MAX_PAGES = 200
export const PDF_EXTRACTION_MAX_CODE_POINTS = 500_000
export const PDF_EXTRACTION_TIMEOUT_MS = 15_000

export type PdfTextExtractionFailureCode =
  | 'UNSAFE_TEXT_CONTROL'
  | 'TEXT_TOO_LARGE'
  | 'PDF_TOO_LARGE'
  | 'PDF_TOO_MANY_PAGES'
  | 'PDF_NO_EXTRACTABLE_TEXT'
  | 'PDF_EXTRACTION_TIMEOUT'
  | 'PDF_EXTRACTION_CANCELLED'
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PARSE_FAILED'

export type PdfTextExtractionResult =
  | {
      outcome: 'SUCCEEDED'
      text: string
      textHash: string
      characterCount: number
      lineCount: number
      pageCount: number
    }
  | { outcome: 'FAILED'; errorCode: PdfTextExtractionFailureCode }

export type PdfTextExtractionOptions = {
  /** Values outside the supported range are clamped to 1..15,000 ms. */
  timeoutMs?: number
  signal?: AbortSignal
}

function appendTextItem(line: string, value: string) {
  if (!value) return line
  if (!line || /\s$/u.test(line) || /^[,.;:!?)}\]]/u.test(value)) return `${line}${value}`
  return `${line} ${value}`
}

function normalizeText(value: string, pageCount: number): PdfTextExtractionResult {
  const text = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!text.trim()) return { outcome: 'FAILED', errorCode: 'PDF_NO_EXTRACTABLE_TEXT' }
  let characterCount = 0
  for (const character of text) {
    characterCount += 1
    if (characterCount > PDF_EXTRACTION_MAX_CODE_POINTS) {
      return { outcome: 'FAILED', errorCode: 'TEXT_TOO_LARGE' }
    }
    const code = character.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) {
      return { outcome: 'FAILED', errorCode: 'UNSAFE_TEXT_CONTROL' }
    }
  }
  return {
    outcome: 'SUCCEEDED',
    text,
    textHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    characterCount,
    lineCount: text.split('\n').length,
    pageCount,
  }
}

export function createPdfLoadingTaskCleanup(loadingTask: {
  destroy(): Promise<void>
}): () => Promise<void> {
  let cleanup: Promise<void> | undefined
  return () => {
    cleanup ??= Promise.resolve()
      .then(() => loadingTask.destroy())
      .catch(() => undefined)
    return cleanup
  }
}

/**
 * Deterministically extracts embedded PDF text without OCR. Deadline and abort checks happen at
 * every asynchronous/page boundary. Synchronous work inside pdf.js cannot be preempted on the same
 * thread, so a result is checked again and never reported as success after the deadline.
 */
export async function extractPdfDocumentText(
  bytes: Uint8Array,
  options: PdfTextExtractionOptions = {},
): Promise<PdfTextExtractionResult> {
  if (bytes.byteLength > PDF_EXTRACTION_MAX_BYTES) {
    return { outcome: 'FAILED', errorCode: 'PDF_TOO_LARGE' }
  }
  if (options.signal?.aborted) {
    return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' }
  }
  const requestedTimeout = Number.isFinite(options.timeoutMs)
    ? Math.trunc(options.timeoutMs!)
    : PDF_EXTRACTION_TIMEOUT_MS
  const timeoutMs = Math.max(1, Math.min(PDF_EXTRACTION_TIMEOUT_MS, requestedTimeout))
  const deadline = Date.now() + timeoutMs
  let getDocument: (typeof import('pdfjs-dist/legacy/build/pdf.mjs', {
    with: { 'resolution-mode': 'import' },
  }))['getDocument']
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    getDocument = pdfjs.getDocument
  } catch {
    if (options.signal?.aborted) return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' }
    return Date.now() >= deadline
      ? { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_TIMEOUT' }
      : { outcome: 'FAILED', errorCode: 'PDF_PARSE_FAILED' }
  }
  if (options.signal?.aborted) return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' }
  if (Date.now() >= deadline) return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_TIMEOUT' }

  let loadingTask: ReturnType<typeof getDocument>
  try {
    loadingTask = getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      stopAtErrors: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    })
  } catch {
    if (options.signal?.aborted) return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' }
    return Date.now() >= deadline
      ? { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_TIMEOUT' }
      : { outcome: 'FAILED', errorCode: 'PDF_PARSE_FAILED' }
  }
  const cleanup = createPdfLoadingTaskCleanup(loadingTask)
  let terminal: 'ACTIVE' | 'TIMED_OUT' | 'CANCELLED' = 'ACTIVE'
  const stop = (reason: 'TIMED_OUT' | 'CANCELLED') => {
    if (terminal !== 'ACTIVE') return
    terminal = reason
    void cleanup()
  }
  const timeout = setTimeout(() => stop('TIMED_OUT'), Math.max(0, deadline - Date.now()))
  const abort = () => stop('CANCELLED')
  options.signal?.addEventListener('abort', abort, { once: true })
  const boundaryFailure = (): PdfTextExtractionResult | null => {
    if (terminal === 'CANCELLED' || options.signal?.aborted) {
      terminal = 'CANCELLED'
      return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' }
    }
    if (terminal === 'TIMED_OUT' || Date.now() >= deadline) {
      terminal = 'TIMED_OUT'
      return { outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_TIMEOUT' }
    }
    return null
  }

  let result: PdfTextExtractionResult
  try {
    result = await (async (): Promise<PdfTextExtractionResult> => {
      const document = await loadingTask.promise
      const afterLoad = boundaryFailure()
      if (afterLoad) return afterLoad
      if (document.numPages > PDF_EXTRACTION_MAX_PAGES) {
        return { outcome: 'FAILED', errorCode: 'PDF_TOO_MANY_PAGES' }
      }
      const pages: string[] = []
      let extractedCodePoints = 0
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const beforePage = boundaryFailure()
        if (beforePage) return beforePage
        const page = await document.getPage(pageNumber)
        try {
          const content = await page.getTextContent()
          const afterContent = boundaryFailure()
          if (afterContent) return afterContent
          const lines: string[] = []
          let line = ''
          for (const item of content.items) {
            if (!('str' in item)) continue
            for (const codePoint of item.str) {
              void codePoint
              extractedCodePoints += 1
              if (extractedCodePoints > PDF_EXTRACTION_MAX_CODE_POINTS) {
                return { outcome: 'FAILED', errorCode: 'TEXT_TOO_LARGE' }
              }
            }
            line = appendTextItem(line, item.str)
            if (item.hasEOL) {
              lines.push(line.trimEnd())
              line = ''
            }
          }
          if (line) lines.push(line.trimEnd())
          pages.push(lines.join('\n').trim())
        } finally {
          page.cleanup()
        }
      }
      const beforeNormalization = boundaryFailure()
      if (beforeNormalization) return beforeNormalization
      const normalized = normalizeText(pages.filter(Boolean).join('\n\n'), document.numPages)
      return boundaryFailure() ?? normalized
    })()
  } catch (error) {
    result = boundaryFailure() ?? {
      outcome: 'FAILED',
      errorCode:
        error instanceof Error && error.name === 'PasswordException'
          ? 'PDF_PASSWORD_REQUIRED'
          : 'PDF_PARSE_FAILED',
    }
  }
  await cleanup()
  clearTimeout(timeout)
  options.signal?.removeEventListener('abort', abort)
  return boundaryFailure() ?? result
}
