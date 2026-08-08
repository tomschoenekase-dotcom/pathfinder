export const MEDIA_SOURCE_FINGERPRINT_ALGORITHM = 'pathfinder-sha256-part-manifest-v1' as const
export const MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES = 16 * 1024 * 1024
export const MAX_MEDIA_SOURCE_BYTES = 5 * 1024 * 1024 * 1024

const DOMAIN = new TextEncoder().encode('PathFinder media source fingerprint v1\0')

export type MediaSourceIdentity = {
  algorithm: typeof MEDIA_SOURCE_FINGERPRINT_ALGORITHM
  digest: string
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException('Media source fingerprinting was cancelled.', 'AbortError')
  }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function fingerprintMediaSource(
  source: Blob,
  options: {
    signal?: AbortSignal
    onProgress?: (processedBytes: number, totalBytes: number) => void
  } = {},
): Promise<MediaSourceIdentity> {
  if (!Number.isSafeInteger(source.size) || source.size < 0) {
    throw new Error('Media source size is invalid.')
  }
  if (source.size === 0 || source.size > MAX_MEDIA_SOURCE_BYTES) {
    throw new Error('Media source must be between 1 byte and 5 GB.')
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'This browser cannot verify the media source. Update the browser and try again.',
    )
  }

  const chunkCount = Math.ceil(source.size / MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES)
  const chunkDigests: Array<{ bytes: number; digest: Uint8Array }> = []
  options.onProgress?.(0, source.size)

  for (let index = 0; index < chunkCount; index++) {
    throwIfAborted(options.signal)
    const start = index * MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES
    const end = Math.min(start + MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES, source.size)
    const chunk = await source.slice(start, end).arrayBuffer()
    throwIfAborted(options.signal)
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', chunk))
    throwIfAborted(options.signal)
    chunkDigests.push({ bytes: end - start, digest })
    options.onProgress?.(end, source.size)
  }

  throwIfAborted(options.signal)
  const manifest = new Uint8Array(DOMAIN.byteLength + 8 + 4 + 4 + chunkCount * (4 + 4 + 32))
  manifest.set(DOMAIN, 0)
  const view = new DataView(manifest.buffer)
  let offset = DOMAIN.byteLength
  view.setBigUint64(offset, BigInt(source.size), false)
  offset += 8
  view.setUint32(offset, MEDIA_SOURCE_FINGERPRINT_CHUNK_BYTES, false)
  offset += 4
  view.setUint32(offset, chunkCount, false)
  offset += 4
  for (let index = 0; index < chunkDigests.length; index++) {
    const chunk = chunkDigests[index]
    if (!chunk) throw new Error('Media source fingerprint state is invalid.')
    view.setUint32(offset, index + 1, false)
    offset += 4
    view.setUint32(offset, chunk.bytes, false)
    offset += 4
    manifest.set(chunk.digest, offset)
    offset += chunk.digest.byteLength
  }

  throwIfAborted(options.signal)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', manifest))
  throwIfAborted(options.signal)
  return { algorithm: MEDIA_SOURCE_FINGERPRINT_ALGORITHM, digest: bytesToHex(digest) }
}
