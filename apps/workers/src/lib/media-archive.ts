import { createReadStream } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

import { assertMediaJobActive, MediaJobCancelledError } from './media-job-cancellation'
import { Readable, Transform, type TransformCallback } from 'node:stream'

export class MediaArchiveByteLimitError extends Error {
  constructor(limitBytes: number) {
    super(`Archive expands beyond the ${limitBytes}-byte safety limit.`)
    this.name = 'MediaArchiveByteLimitError'
  }
}

export class MediaArchiveByteBudget {
  readonly limitBytes: number
  #totalBytes = 0

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('Archive byte limit must be a positive safe integer.')
    }
    this.limitBytes = limitBytes
  }

  get totalBytes(): number {
    return this.#totalBytes
  }

  createEntryCounter(): MediaArchiveEntryCounter {
    return new MediaArchiveEntryCounter(this)
  }

  consume(bytes: number): void {
    if (bytes > this.limitBytes - this.#totalBytes) {
      throw new MediaArchiveByteLimitError(this.limitBytes)
    }
    this.#totalBytes += bytes
  }
}

export class MediaArchiveEntryCounter extends Transform {
  #bytes = 0

  constructor(private readonly budget: MediaArchiveByteBudget) {
    super()
  }

  get bytes(): number {
    return this.#bytes
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding)
    try {
      this.budget.consume(bytes)
      this.#bytes += bytes
      callback(null, chunk)
    } catch (error) {
      callback(error as Error)
    }
  }
}

export class MediaTextRetentionBudget {
  readonly limitCharacters: number
  #retainedCharacters = 0

  constructor(limitCharacters: number) {
    if (!Number.isSafeInteger(limitCharacters) || limitCharacters <= 0) {
      throw new Error('Text-retention limit must be a positive safe integer.')
    }
    this.limitCharacters = limitCharacters
  }

  get retainedCharacters(): number {
    return this.#retainedCharacters
  }

  allowance(perFileLimit: number): number {
    if (!Number.isSafeInteger(perFileLimit) || perFileLimit <= 0) {
      throw new Error('Per-file text limit must be a positive safe integer.')
    }
    return Math.min(perFileLimit, this.limitCharacters - this.#retainedCharacters)
  }

  retain(text: string): void {
    let characters = 0
    for (let index = 0; index < text.length; characters++) {
      const codePoint = text.codePointAt(index)
      index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1
    }
    if (characters > this.limitCharacters - this.#retainedCharacters) {
      throw new Error('Media text exceeds the job retention budget.')
    }
    this.#retainedCharacters += characters
  }
}

export function jsonArrayExceedsCharacterLimit(
  values: readonly unknown[],
  limitCharacters: number,
): boolean {
  if (!Number.isSafeInteger(limitCharacters) || limitCharacters <= 0) {
    throw new Error('JSON character limit must be a positive safe integer.')
  }

  let characters = 2
  if (characters > limitCharacters) return true
  for (let index = 0; index < values.length; index++) {
    characters += (JSON.stringify(values[index]) ?? 'null').length
    if (index > 0) characters++
    if (characters > limitCharacters) return true
  }
  return false
}

export function forwardReadableErrors(source: Readable, destination: Readable): () => void {
  const forward = (error: Error) => destination.destroy(error)
  source.once('error', forward)
  return () => source.off('error', forward)
}

type TextPrefixReadOptions = {
  highWaterMark?: number
  openStream?: (filePath: string, highWaterMark: number) => ReadStream
  signal?: AbortSignal
}

const DEFAULT_TEXT_HIGH_WATER_MARK = 16 * 1024

export async function readUtf8TextPrefix(
  filePath: string,
  maxCharacters: number,
  options: TextPrefixReadOptions = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error('Text-prefix character limit must be a positive safe integer.')
  }
  const highWaterMark = options.highWaterMark ?? DEFAULT_TEXT_HIGH_WATER_MARK
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark <= 0) {
    throw new Error('Text-prefix highWaterMark must be a positive safe integer.')
  }

  const stream = options.openStream
    ? options.openStream(filePath, highWaterMark)
    : createReadStream(filePath, { highWaterMark })
  const decoder = new StringDecoder('utf8')
  const characters: string[] = []
  const abortStream = () => stream.destroy(new MediaJobCancelledError())
  options.signal?.addEventListener('abort', abortStream, { once: true })

  try {
    assertMediaJobActive(options.signal)
    for await (const rawChunk of stream) {
      assertMediaJobActive(options.signal)
      const decoded = decoder.write(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk))
      for (const character of decoded) {
        characters.push(character)
        if (characters.length === maxCharacters) return characters.join('')
      }
    }

    assertMediaJobActive(options.signal)
    for (const character of decoder.end()) {
      characters.push(character)
      if (characters.length === maxCharacters) break
    }
    return characters.join('')
  } finally {
    options.signal?.removeEventListener('abort', abortStream)
    stream.destroy()
  }
}
