import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { UnrecoverableError } from 'bullmq'

import { MediaGeneratedOutputBudget } from './media-attempt-limits'

export const MAX_GENERATED_VIDEO_FRAMES = 120
export const MAX_GENERATED_FRAME_BYTES = 32 * 1024 * 1024

export class JpegFrameStreamError extends UnrecoverableError {
  constructor(message: string) {
    super(message)
    this.name = 'JpegFrameStreamError'
  }
}

type WriteFrame = (filePath: string, frame: Buffer, options: { flag: 'wx' }) => Promise<void>

function isStandaloneMarker(code: number): boolean {
  return code === 0x01 || (code >= 0xd0 && code <= 0xd7)
}

export function findJpegFrameEnd(frame: Buffer): number | null {
  if (frame.byteLength < 2) return null
  if (frame[0] !== 0xff || frame[1] !== 0xd8) {
    throw new JpegFrameStreamError('FFmpeg returned a malformed JPEG frame stream.')
  }

  let cursor = 2
  let entropyCoded = false
  while (cursor < frame.byteLength) {
    let markerCodeIndex: number
    if (entropyCoded) {
      const markerPrefix = frame.indexOf(0xff, cursor)
      if (markerPrefix < 0) return null
      markerCodeIndex = markerPrefix + 1
    } else {
      if (frame[cursor] !== 0xff) {
        throw new JpegFrameStreamError('FFmpeg returned a malformed JPEG frame stream.')
      }
      markerCodeIndex = cursor + 1
    }

    while (markerCodeIndex < frame.byteLength && frame[markerCodeIndex] === 0xff) {
      markerCodeIndex += 1
    }
    if (markerCodeIndex >= frame.byteLength) return null

    const markerCode = frame[markerCodeIndex]!
    const afterMarker = markerCodeIndex + 1
    if (entropyCoded && markerCode === 0x00) {
      cursor = afterMarker
      continue
    }
    if (entropyCoded && markerCode >= 0xd0 && markerCode <= 0xd7) {
      cursor = afterMarker
      continue
    }
    if (markerCode === 0xd9) return afterMarker
    if (markerCode === 0xd8 || markerCode === 0x00) {
      throw new JpegFrameStreamError('FFmpeg returned a malformed JPEG frame stream.')
    }
    if (isStandaloneMarker(markerCode)) {
      cursor = afterMarker
      entropyCoded = false
      continue
    }
    if (afterMarker + 2 > frame.byteLength) return null

    const segmentLength = frame.readUInt16BE(afterMarker)
    if (segmentLength < 2) {
      throw new JpegFrameStreamError('FFmpeg returned a malformed JPEG segment length.')
    }
    const segmentEnd = afterMarker + segmentLength
    if (segmentEnd > frame.byteLength) return null
    cursor = segmentEnd
    entropyCoded = markerCode === 0xda
  }
  return null
}

export class JpegFrameWriter extends Writable {
  private pending = Buffer.alloc(0)
  private readonly writtenNames: string[] = []

  constructor(
    private readonly options: {
      budget: MediaGeneratedOutputBudget
      directory: string
      maxFrameBytes?: number
      maxFrames?: number
      writeFrame?: WriteFrame
    },
  ) {
    super()
  }

  get filenames(): readonly string[] {
    return this.writtenNames
  }

  override _write(
    rawChunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, encoding)
    void this.accept(chunk).then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.pending.byteLength !== 0) {
      callback(new JpegFrameStreamError('FFmpeg returned an incomplete JPEG frame stream.'))
      return
    }
    callback()
  }

  private async accept(chunk: Buffer): Promise<void> {
    this.pending = Buffer.concat([this.pending, chunk])
    const maxFrameBytes = this.options.maxFrameBytes ?? MAX_GENERATED_FRAME_BYTES
    const maxFrames = this.options.maxFrames ?? MAX_GENERATED_VIDEO_FRAMES
    const writeFrame = this.options.writeFrame ?? writeFile

    while (this.pending.byteLength > 0) {
      const frameBytes = findJpegFrameEnd(this.pending)
      if (frameBytes === null) {
        if (this.pending.byteLength > maxFrameBytes) {
          throw new JpegFrameStreamError(
            `FFmpeg generated a JPEG frame larger than ${maxFrameBytes} bytes.`,
          )
        }
        return
      }
      if (frameBytes > maxFrameBytes) {
        throw new JpegFrameStreamError(
          `FFmpeg generated a JPEG frame larger than ${maxFrameBytes} bytes.`,
        )
      }
      if (this.writtenNames.length >= maxFrames) {
        throw new JpegFrameStreamError(`FFmpeg generated more than ${maxFrames} video frames.`)
      }

      const frame = this.pending.subarray(0, frameBytes)
      this.pending = this.pending.subarray(frameBytes)
      this.options.budget.consume(frame.byteLength)
      const filename = `frame-${String(this.writtenNames.length + 1).padStart(4, '0')}.jpg`
      await writeFrame(join(this.options.directory, filename), frame, { flag: 'wx' })
      this.writtenNames.push(filename)
    }
  }
}
