import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { verifyIntakeUploadBytes } from './intake-upload-byte-verifier'

async function* chunks(...values: Uint8Array[]) {
  yield* values
}

function request(bytes: Uint8Array, mimeType: 'image/png' | 'application/pdf' = 'image/png') {
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
})
