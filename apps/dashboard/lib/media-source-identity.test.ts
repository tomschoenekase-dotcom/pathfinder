import { describe, expect, it, vi } from 'vitest'

import {
  fingerprintMediaSource,
  MAX_MEDIA_SOURCE_BYTES,
  MEDIA_SOURCE_FINGERPRINT_ALGORITHM,
  MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES,
} from './media-source-identity'

describe('media source identity', () => {
  it('produces a deterministic lowercase SHA-256 manifest identity', async () => {
    const source = new Blob([new TextEncoder().encode('PathFinder source archive')])
    await expect(fingerprintMediaSource(source)).resolves.toEqual({
      algorithm: MEDIA_SOURCE_FINGERPRINT_ALGORITHM,
      digest: '03c068848544ed0a7d266c6d848f2ef1c3ce3a8ba05fb262c15b29a271173231',
    })
  })

  it('changes for mutations in the first, middle, or final chunk', async () => {
    const original = new Uint8Array(MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES + 1)
    const first = original.slice()
    const middle = original.slice()
    const final = original.slice()
    first[0] = 1
    middle[Math.floor(MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES / 2)] = 1
    final[MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES] = 1

    const identities = await Promise.all(
      [original, first, middle, final].map((bytes) => fingerprintMediaSource(new Blob([bytes]))),
    )
    expect(new Set(identities.map(({ digest }) => digest))).toHaveProperty('size', 4)
  })

  it('binds the exact fixed-chunk boundary and total length', async () => {
    const identities = await Promise.all(
      [
        MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES - 1,
        MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES,
        MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES + 1,
      ].map((bytes) => fingerprintMediaSource(new Blob([new Uint8Array(bytes)]))),
    )
    expect(new Set(identities.map(({ digest }) => digest))).toHaveProperty('size', 3)
  })

  it('reports monotonic progress and stops on cancellation', async () => {
    const controller = new AbortController()
    const progress: number[] = []
    const source = new Blob([new Uint8Array(MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES + 1)])

    await expect(
      fingerprintMediaSource(source, {
        signal: controller.signal,
        onProgress(processed) {
          progress.push(processed)
          if (processed === MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toEqual([0, MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES])
  })

  it('never reads more than one upload-sized chunk at once', async () => {
    const source = new Blob([new Uint8Array(MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES + 1)])
    const slice = vi.spyOn(source, 'slice')
    await fingerprintMediaSource(source)
    expect(slice.mock.calls).toEqual([
      [0, MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES],
      [MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES, MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES + 1],
    ])
  })

  it('rejects invalid sizes and pre-cancelled work before reading', async () => {
    const oversized = {
      size: MAX_MEDIA_SOURCE_BYTES + 1,
      slice: vi.fn(),
    } as unknown as Blob
    await expect(fingerprintMediaSource(new Blob([]))).rejects.toThrow(/between 1 byte and 5 GB/)
    await expect(fingerprintMediaSource(oversized)).rejects.toThrow(/between 1 byte and 5 GB/)
    expect(oversized.slice).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    const maximum = {
      size: MAX_MEDIA_SOURCE_BYTES,
      slice: vi.fn(),
    } as unknown as Blob
    await expect(
      fingerprintMediaSource(maximum, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(maximum.slice).not.toHaveBeenCalled()

    const source = new Blob([new Uint8Array([1])])
    const slice = vi.spyOn(source, 'slice')
    await expect(
      fingerprintMediaSource(source, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(slice).not.toHaveBeenCalled()
  })

  it('honors cancellation after the final source chunk', async () => {
    const controller = new AbortController()
    const source = new Blob([new Uint8Array([1, 2, 3])])
    await expect(
      fingerprintMediaSource(source, {
        signal: controller.signal,
        onProgress(processed, total) {
          if (processed === total) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
