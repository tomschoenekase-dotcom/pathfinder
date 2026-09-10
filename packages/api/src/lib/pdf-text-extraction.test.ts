import { describe, expect, it, vi } from 'vitest'

import {
  createPdfLoadingTaskCleanup,
  extractPdfDocumentText,
  PDF_EXTRACTION_MAX_BYTES,
  PDF_EXTRACTION_TIMEOUT_MS,
} from './pdf-text-extraction'

function pdfWithText(text: string, pageCount = 1) {
  const escaped = text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
  const firstContentObject = 3 + pageCount
  const fontObject = firstContentObject + pageCount
  const pages = Array.from(
    { length: pageCount },
    (_, index) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`,
  )
  const contents = Array.from(
    { length: pageCount },
    () => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  )
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...pages,
    ...contents,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(document)
}

describe('shared PDF text extraction', () => {
  it(
    'extracts actual pdf.js text with page provenance',
    async () => {
      await expect(
        extractPdfDocumentText(pdfWithText('Visitor information', 2)),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        text: 'Visitor information\n\nVisitor information',
        pageCount: 2,
        characterCount: 40,
        lineCount: 3,
      })
    },
    // Include cold pdf.js loading while preserving the extractor's own deadline.
    PDF_EXTRACTION_TIMEOUT_MS + 5_000,
  )

  it('fails closed for invalid, over-page, over-byte, and pre-cancelled inputs', async () => {
    await expect(extractPdfDocumentText(Buffer.from('invalid'))).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'PDF_PARSE_FAILED',
    })
    await expect(extractPdfDocumentText(pdfWithText('x', 201))).resolves.toEqual({
      outcome: 'FAILED',
      errorCode: 'PDF_TOO_MANY_PAGES',
    })
    await expect(
      extractPdfDocumentText(new Uint8Array(PDF_EXTRACTION_MAX_BYTES + 1)),
    ).resolves.toEqual({ outcome: 'FAILED', errorCode: 'PDF_TOO_LARGE' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      extractPdfDocumentText(pdfWithText('x'), { signal: controller.signal }),
    ).resolves.toEqual({ outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_CANCELLED' })
  })

  it('clamps the deadline and does not report success after it expires', async () => {
    const result = await extractPdfDocumentText(pdfWithText('bounded', 200), { timeoutMs: 0 })
    expect(result).toEqual({ outcome: 'FAILED', errorCode: 'PDF_EXTRACTION_TIMEOUT' })
  })

  it('runs loading-task cleanup once even when cleanup rejects', async () => {
    const destroy = vi.fn(async () => {
      throw new Error('private')
    })
    const cleanup = createPdfLoadingTaskCleanup({ destroy })
    await expect(Promise.all([cleanup(), cleanup()])).resolves.toEqual([undefined, undefined])
    expect(destroy).toHaveBeenCalledOnce()
  })
})
