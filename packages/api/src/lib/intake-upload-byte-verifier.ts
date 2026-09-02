import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createConnection } from 'node:net'

import {
  INTAKE_UPLOAD_MAX_BYTES,
  type IntakeUploadMimeType,
} from '@pathfinder/contracts/intake-upload'

const FORMAT_ENGINE = 'pathfinder-magic-bytes'
const FORMAT_ENGINE_VERSION = '1'
const CLAMAV_RESPONSE_MAX_BYTES = 4 * 1024
export type IntakeUploadByteSource = AsyncIterable<Uint8Array>

export type IntakeUploadPrecheckVerdict = {
  passed: boolean
  engine: typeof FORMAT_ENGINE
  engineVersion: typeof FORMAT_ENGINE_VERSION
  verdictHash: string
  reason: 'PASSED' | 'FORMAT_MISMATCH' | 'UNSAFE_CONTAINER' | 'SIZE_MISMATCH' | 'HASH_MISMATCH'
  computedByteSize: number
  computedSha256: string
}

export type IntakeUploadMalwareScanner = {
  engine: string
  engineVersion: string
  scan(input: {
    bytes: IntakeUploadByteSource
    expectedBytes: number
    expectedSha256: string
  }): Promise<{
    verdict: 'CLEAN' | 'INFECTED'
    verdictHash: string
    computedByteSize: number
    computedSha256: string
  }>
}

export function createBoundedClamAvResponseCollector(maxBytes = CLAMAV_RESPONSE_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError('ClamAV response limit must be a positive safe integer')
  const chunks: Buffer[] = []
  let total = 0
  return {
    push(chunk: Uint8Array): boolean {
      if (chunk.byteLength > maxBytes - total) return false
      total += chunk.byteLength
      chunks.push(Buffer.from(chunk))
      return true
    },
    value(): Buffer {
      return Buffer.concat(chunks, total)
    },
  }
}

export function parseClamAvResponse(bytes: Uint8Array): {
  response: string
  verdict: 'CLEAN' | 'INFECTED'
} {
  const response = Buffer.from(bytes).toString('utf8').replace(/\0+$/u, '').trim()
  if (response.endsWith(' OK')) return { response, verdict: 'CLEAN' }
  if (response.includes(' FOUND')) return { response, verdict: 'INFECTED' }
  throw new Error('ClamAV returned an unrecognized response')
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function isStreamingMediaMime(mimeType: IntakeUploadMimeType): boolean {
  return mimeType.startsWith('video/') || mimeType.startsWith('audio/')
}

function isTextDocumentMime(mimeType: IntakeUploadMimeType): boolean {
  return (
    mimeType === 'application/json' ||
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/csv'
  )
}

function decodeSafeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!text.trim()) return null
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return null
    }
    return text
  } catch {
    return null
  }
}

function matchesMime(bytes: Uint8Array, mimeType: IntakeUploadMimeType): boolean {
  if (isTextDocumentMime(mimeType)) {
    const text = decodeSafeUtf8(bytes)
    if (text === null) return false
    if (mimeType !== 'application/json') return true
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }
  if (mimeType === 'application/pdf') {
    const text = new TextDecoder('latin1').decode(bytes)
    return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) && /%%EOF\s*$/u.test(text)
  }
  if (mimeType === 'image/jpeg')
    return startsWith(bytes, [0xff, 0xd8, 0xff]) && startsWith(bytes.slice(-2), [0xff, 0xd9])
  if (mimeType === 'image/png')
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mimeType === 'image/webp')
    return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
  if (mimeType === 'image/tiff')
    return (
      startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
    )
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    if (ascii(bytes, 4, 4) !== 'ftyp') return false
    const brand = ascii(bytes, 8, 4)
    return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)
  }
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') {
    if (ascii(bytes, 4, 4) !== 'ftyp') return false
    const brand = ascii(bytes, 8, 4)
    return mimeType === 'video/quicktime'
      ? brand === 'qt  '
      : ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4A '].includes(brand)
  }
  if (mimeType === 'video/webm' || mimeType === 'audio/webm')
    return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])
  if (mimeType === 'audio/wav')
    return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE'
  if (mimeType === 'audio/mpeg')
    return (
      ascii(bytes, 0, 3) === 'ID3' ||
      (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
    )
  return false
}

function conservativeStructurePrecheck(bytes: Buffer, mimeType: IntakeUploadMimeType): boolean {
  if (isTextDocumentMime(mimeType)) return matchesMime(bytes, mimeType)
  if (mimeType === 'application/pdf') {
    const text = bytes.toString('latin1')
    return /\n(?:xref\s|\d+\s+\d+\s+obj\b)/u.test(text) && /startxref\s+\d+\s+%%EOF\s*$/u.test(text)
  }
  if (mimeType === 'image/png') {
    let offset = 8
    let sawHeader = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > bytes.length) return false
      const kind = bytes.toString('ascii', offset + 4, offset + 8)
      if (!sawHeader) {
        if (kind !== 'IHDR' || length !== 13) return false
        const width = bytes.readUInt32BE(offset + 8)
        const height = bytes.readUInt32BE(offset + 12)
        if (width < 1 || height < 1 || width * height > 100_000_000) return false
        sawHeader = true
      }
      offset = end
      if (kind === 'IEND') return length === 0 && offset === bytes.length
    }
    return false
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2
    let dimensions = false
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 0xff) return false
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset++]
      if (marker === 0xd9) return dimensions && offset === bytes.length
      if (marker === 0xda) return dimensions && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      if (offset + 2 > bytes.length) return false
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) return false
      if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return false
        const height = bytes.readUInt16BE(offset + 3)
        const width = bytes.readUInt16BE(offset + 5)
        if (width < 1 || height < 1 || width * height > 100_000_000) return false
        dimensions = true
      }
      offset += length
    }
    return false
  }
  if (mimeType === 'image/webp') return bytes.readUInt32LE(4) + 8 === bytes.length
  if (mimeType === 'image/tiff') {
    if (bytes.length < 8) return false
    const little = bytes[0] === 0x49
    const offset = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
    return offset >= 8 && offset + 2 <= bytes.length
  }
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    let offset = 0
    let sawFtyp = false
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      if (size < 8 || offset + size > bytes.length) return false
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'ftyp') sawFtyp = true
      offset += size
    }
    return sawFtyp && offset === bytes.length
  }
  if (isStreamingMediaMime(mimeType)) return bytes.length >= 12 && matchesMime(bytes, mimeType)
  return false
}

function containsConflictingContainer(bytes: Uint8Array, mimeType: IntakeUploadMimeType): boolean {
  const signatures = [
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  ]
  return signatures.some(
    (signature) => signature.mime !== mimeType && startsWith(bytes, signature.bytes),
  )
}

function verdictHash(input: {
  passed: boolean
  reason: IntakeUploadPrecheckVerdict['reason']
  mimeType: IntakeUploadMimeType
  byteSize: number
  sha256: string
  storageVersionId: string
  objectGeneration: string
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        byteSize: input.byteSize,
        passed: input.passed,
        engine: FORMAT_ENGINE,
        engineVersion: FORMAT_ENGINE_VERSION,
        mimeType: input.mimeType,
        objectGeneration: input.objectGeneration,
        reason: input.reason,
        sha256: input.sha256,
        storageVersionId: input.storageVersionId,
      }),
    )
    .digest('hex')
}

export async function verifyIntakeUploadBytes(input: {
  bytes: IntakeUploadByteSource
  mimeType: IntakeUploadMimeType
  expectedBytes: number
  expectedSha256: string
  storageVersionId: string
  objectGeneration: string
  signal?: AbortSignal
  onProgress?: (byteSize: number) => Promise<void>
}): Promise<IntakeUploadPrecheckVerdict> {
  const hash = createHash('sha256')
  const chunks: Uint8Array[] = []
  const streamingMedia = isStreamingMediaMime(input.mimeType)
  const mediaPrefixLimit = 1024 * 1024
  let capturedBytes = 0
  let total = 0
  for await (const chunk of input.bytes) {
    if (input.signal?.aborted) throw new Error('Intake upload precheck was aborted')
    total += chunk.byteLength
    if (total > input.expectedBytes || total > INTAKE_UPLOAD_MAX_BYTES) {
      const reason = 'SIZE_MISMATCH' as const
      hash.update(chunk)
      const digest = hash.digest('hex')
      return {
        passed: false,
        reason,
        engine: FORMAT_ENGINE,
        engineVersion: FORMAT_ENGINE_VERSION,
        verdictHash: verdictHash({
          ...input,
          passed: false,
          reason,
          byteSize: total,
          sha256: digest,
        }),
        computedByteSize: total,
        computedSha256: digest,
      }
    }
    hash.update(chunk)
    if (!streamingMedia) chunks.push(chunk)
    else if (capturedBytes < mediaPrefixLimit) {
      const captured = chunk.subarray(0, mediaPrefixLimit - capturedBytes)
      chunks.push(captured)
      capturedBytes += captured.byteLength
    }
    await input.onProgress?.(total)
  }
  const digest = hash.digest('hex')
  let reason: IntakeUploadPrecheckVerdict['reason'] = 'PASSED'
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  if (total !== input.expectedBytes) reason = 'SIZE_MISMATCH'
  else if (digest !== input.expectedSha256) reason = 'HASH_MISMATCH'
  else if (containsConflictingContainer(bytes, input.mimeType)) reason = 'UNSAFE_CONTAINER'
  else if (
    !matchesMime(bytes, input.mimeType) ||
    !conservativeStructurePrecheck(bytes, input.mimeType)
  )
    reason = 'FORMAT_MISMATCH'
  const passed = reason === 'PASSED'
  return {
    passed,
    reason,
    engine: FORMAT_ENGINE,
    engineVersion: FORMAT_ENGINE_VERSION,
    verdictHash: verdictHash({ ...input, passed, reason, byteSize: total, sha256: digest }),
    computedByteSize: total,
    computedSha256: digest,
  }
}

export function configuredIntakeUploadMalwareScanner(): IntakeUploadMalwareScanner | null {
  const host = process.env.INTAKE_CLAMAV_HOST?.trim()
  const parsedPort = Number(process.env.INTAKE_CLAMAV_PORT ?? '3310')
  if (!host) return null
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)
    throw new Error('INTAKE_CLAMAV_PORT must be a valid TCP port')
  return {
    engine: 'clamav-clamd',
    engineVersion: 'daemon',
    async scan(input) {
      const socket = createConnection({ host, port: parsedPort })
      socket.setTimeout(30 * 60_000)
      const responseCollector = createBoundedClamAvResponseCollector()
      socket.on('data', (chunk: Buffer) => {
        if (!responseCollector.push(chunk))
          socket.destroy(new Error('ClamAV response exceeded its byte limit'))
      })
      const socketError = new Promise<never>((_, reject) => {
        socket.once('error', reject)
        socket.once('timeout', () => reject(new Error('ClamAV scan timed out')))
      })
      await Promise.race([once(socket, 'connect'), socketError])
      socket.write(Buffer.from('zINSTREAM\0'))
      const hash = createHash('sha256')
      let total = 0
      for await (const chunk of input.bytes) {
        total += chunk.byteLength
        if (total > input.expectedBytes || total > INTAKE_UPLOAD_MAX_BYTES) {
          socket.destroy()
          throw new Error('ClamAV stream exceeded immutable upload size')
        }
        hash.update(chunk)
        const size = Buffer.allocUnsafe(4)
        size.writeUInt32BE(chunk.byteLength)
        if (!socket.write(size)) await Promise.race([once(socket, 'drain'), socketError])
        if (!socket.write(chunk)) await Promise.race([once(socket, 'drain'), socketError])
      }
      socket.end(Buffer.alloc(4))
      await Promise.race([once(socket, 'close'), socketError])
      const computedSha256 = hash.digest('hex')
      if (total !== input.expectedBytes || computedSha256 !== input.expectedSha256)
        throw new Error('ClamAV stream did not match immutable upload evidence')
      const { response, verdict } = parseClamAvResponse(responseCollector.value())
      return {
        verdict,
        computedByteSize: total,
        computedSha256,
        verdictHash: createHash('sha256')
          .update(
            JSON.stringify({
              domain: 'pathfinder.clamav-verdict.v1',
              engine: 'clamav-clamd',
              response,
              byteSize: total,
              sha256: computedSha256,
            }),
          )
          .digest('hex'),
      }
    },
  }
}
