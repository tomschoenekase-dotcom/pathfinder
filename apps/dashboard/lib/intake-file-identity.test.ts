import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  identifyIntakeFile,
  INTAKE_FILE_HASH_CHUNK_BYTES,
  intakeFileFingerprint,
  MAX_INTAKE_FILE_BYTES,
  validateIntakeFile,
} from './intake-file-identity'

describe('intake file identity', () => {
  it('returns the exact full-file SHA-256 in hex and base64', async () => {
    const bytes = new TextEncoder().encode('Torchiko quarantine evidence')
    const file = new File([bytes], 'evidence.pdf', { type: 'application/pdf' })
    const identity = await identifyIntakeFile(file)
    expect(identity).toEqual({
      sha256Hex: createHash('sha256').update(bytes).digest('hex'),
      sha256Base64: createHash('sha256').update(bytes).digest('base64'),
    })
    expect(intakeFileFingerprint(file, identity)).not.toContain('Torchiko quarantine evidence')
  })

  it('hashes bounded slices when File.stream is unavailable', async () => {
    const slice = vi
      .fn()
      .mockReturnValueOnce(new Blob([new Uint8Array([1, 2])]))
      .mockReturnValueOnce(new Blob([new Uint8Array([3, 4])]))
    const arrayBuffer = vi.fn(() => {
      throw new Error('whole-file arrayBuffer must not be used')
    })
    const file = {
      name: 'fallback.mp4',
      type: 'video/mp4',
      size: INTAKE_FILE_HASH_CHUNK_BYTES + 1,
      stream: undefined,
      slice,
      arrayBuffer,
    } as unknown as File

    const identity = await identifyIntakeFile(file)

    expect(identity.sha256Hex).toBe(
      createHash('sha256')
        .update(new Uint8Array([1, 2, 3, 4]))
        .digest('hex'),
    )
    expect(slice).toHaveBeenNthCalledWith(1, 0, INTAKE_FILE_HASH_CHUNK_BYTES)
    expect(slice).toHaveBeenNthCalledWith(
      2,
      INTAKE_FILE_HASH_CHUNK_BYTES,
      INTAKE_FILE_HASH_CHUNK_BYTES + 1,
    )
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('allows supported documents, images, video, and audio within the exact size bound', () => {
    expect(validateIntakeFile(new File(['x'], 'image.svg', { type: 'image/svg+xml' }))).toMatch(
      /supported document, image, video, or audio/,
    )
    expect(validateIntakeFile(new File(['x'], 'photo.heic', { type: 'image/heic' }))).toBeNull()
    expect(validateIntakeFile(new File(['x'], 'scan.tiff', { type: 'image/tiff' }))).toBeNull()
    expect(validateIntakeFile(new File(['x'], 'tour.mp4', { type: 'video/mp4' }))).toBeNull()
    expect(validateIntakeFile(new File(['x'], 'interview.mp3', { type: 'audio/mpeg' }))).toBeNull()
    expect(validateIntakeFile(new File([], 'empty.pdf', { type: 'application/pdf' }))).toMatch(
      /empty/,
    )
    const oversizedDocument = new File(['x'], 'large.pdf', { type: 'application/pdf' })
    Object.defineProperty(oversizedDocument, 'size', { value: 101 * 1024 * 1024 })
    expect(validateIntakeFile(oversizedDocument)).toMatch(/100 MB/)
    const oversized = new File(['x'], 'large.mp4', { type: 'video/mp4' })
    Object.defineProperty(oversized, 'size', { value: MAX_INTAKE_FILE_BYTES + 1 })
    expect(validateIntakeFile(oversized)).toMatch(/2 GB/)
  })
})
