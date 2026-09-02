import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  createBoundedClamAvResponseCollector,
  nextClamAvInputChunk,
  parseClamAvResponse,
  verifyIntakeUploadBytes,
} from './intake-upload-byte-verifier'

async function* chunks(...values: Uint8Array[]) {
  yield* values
}

function request(
  bytes: Uint8Array,
  mimeType:
    | 'image/png'
    | 'application/pdf'
    | 'application/json'
    | 'text/plain'
    | 'text/markdown'
    | 'text/csv'
    | 'video/mp4' = 'image/png',
) {
  return {
    bytes: chunks(bytes.subarray(0, 3), bytes.subarray(3)),
    mimeType,
    expectedBytes: bytes.length,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    storageVersionId: 'immutable-version-1',
    objectGeneration: '33333333-3333-4333-8333-333333333333',
  }
}

describe('bounded intake upload byte verification', () => {
  it('observes scanner failure while the upload byte source is stalled', async () => {
    let rejectSocket!: (error: Error) => void
    const socketError = new Promise<never>((_resolve, reject) => {
      rejectSocket = reject
    })
    const iterator: AsyncIterator<Uint8Array> = {
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    }
    const pending = nextClamAvInputChunk(iterator, socketError)

    rejectSocket(new Error('ClamAV scan timed out'))

    await expect(pending).rejects.toThrow('ClamAV scan timed out')
  })

  it('bounds ClamAV response bytes and keeps malformed response content out of errors', () => {
    const collector = createBoundedClamAvResponseCollector(5)
    expect(collector.push(Buffer.from('abcd'))).toBe(true)
    expect(collector.push(Buffer.from('ef'))).toBe(false)
    expect(collector.value().toString('utf8')).toBe('abcd')
    expect(parseClamAvResponse(Buffer.from('stream: OK\0'))).toEqual({
      response: 'stream: OK',
      verdict: 'CLEAN',
    })
    expect(parseClamAvResponse(Buffer.from('stream: Eicar FOUND\0'))).toEqual({
      response: 'stream: Eicar FOUND',
      verdict: 'INFECTED',
    })
    expect(() => parseClamAvResponse(Buffer.from('private scanner detail'))).toThrow(
      'ClamAV returned an unrecognized response',
    )
    try {
      parseClamAvResponse(Buffer.from('private scanner detail'))
    } catch (error) {
      expect(String(error)).not.toContain('private scanner detail')
    }
  })

  it('recognizes a matching signature only after exact streamed size and hash verification', async () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
    ])
    await expect(verifyIntakeUploadBytes(request(bytes))).resolves.toMatchObject({
      passed: true,
      reason: 'PASSED',
    })
  })

  it('does not mistake an embedded signature for a complete second container', async () => {
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x50, 0x4b, 0x03, 0x04,
    ])
    await expect(verifyIntakeUploadBytes(request(bytes))).resolves.toMatchObject({
      passed: false,
      reason: 'FORMAT_MISMATCH',
    })
  })

  it('rejects truncated PDF and streamed byte overflow', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\nno eof')
    await expect(verifyIntakeUploadBytes(request(pdf, 'application/pdf'))).resolves.toMatchObject({
      passed: false,
      reason: 'FORMAT_MISMATCH',
    })
    await expect(
      verifyIntakeUploadBytes({ ...request(pdf, 'application/pdf'), expectedBytes: 2 }),
    ).resolves.toMatchObject({ passed: false, reason: 'SIZE_MISMATCH' })
  })

  it('accepts a streamed MP4 file-type box without buffering the entire media file', async () => {
    const bytes = Uint8Array.from([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f,
      0x6d, 0x6d, 0x70, 0x34, 0x32,
    ])
    await expect(verifyIntakeUploadBytes(request(bytes, 'video/mp4'))).resolves.toMatchObject({
      passed: true,
      reason: 'PASSED',
    })
  })

  it.each([
    ['text/plain', 'Hours\nMonday: 9–5\n'],
    ['text/markdown', '# Visitor guide\n\nUse the east entrance.\n'],
    ['text/csv', 'place,hours\nGallery,9–5\n'],
    ['application/json', '{"place":"Gallery","hours":"9–5"}'],
  ] as const)('accepts bounded, valid UTF-8 %s documents', async (mimeType, value) => {
    await expect(
      verifyIntakeUploadBytes(request(new TextEncoder().encode(value), mimeType)),
    ).resolves.toMatchObject({ passed: true, reason: 'PASSED' })
  })

  it.each([
    ['text/plain', Uint8Array.from([0x66, 0x6f, 0x80])],
    ['text/markdown', new TextEncoder().encode('# Guide\u0000hidden')],
    ['application/json', new TextEncoder().encode('{"broken":}')],
  ] as const)('rejects malformed or unsafe %s documents', async (mimeType, bytes) => {
    await expect(verifyIntakeUploadBytes(request(bytes, mimeType))).resolves.toMatchObject({
      passed: false,
      reason: 'FORMAT_MISMATCH',
    })
  })
})
