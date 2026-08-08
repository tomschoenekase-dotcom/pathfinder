import { finished } from 'node:stream/promises'
import { describe, expect, it, vi } from 'vitest'

import { MediaGeneratedOutputBudget, MediaGeneratedOutputLimitError } from './media-attempt-limits'
import {
  findJpegFrameEnd,
  JpegFrameStreamError,
  JpegFrameWriter,
  MAX_GENERATED_FRAME_BYTES,
  MAX_GENERATED_VIDEO_FRAMES,
} from './jpeg-frame-stream'

const frameA = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9])
const frameB = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x03, 0xff, 0xd9])

async function writeChunks(writer: JpegFrameWriter, chunks: Buffer[]): Promise<void> {
  const settled = finished(writer)
  for (const chunk of chunks) writer.write(chunk)
  writer.end()
  await settled
}

describe('JPEG frame stream', () => {
  it('writes two frames in order when markers cross chunk boundaries', async () => {
    const writeFrame = vi.fn(async (path: string, frame: Buffer, options: { flag: 'wx' }) => {
      void path
      void frame
      void options
    })
    const writer = new JpegFrameWriter({
      budget: new MediaGeneratedOutputBudget(100),
      directory: 'frames',
      writeFrame,
    })
    const joined = Buffer.concat([frameA, frameB])
    await writeChunks(writer, [joined.subarray(0, 1), joined.subarray(1, 8), joined.subarray(8)])

    expect(writer.filenames).toEqual(['frame-0001.jpg', 'frame-0002.jpg'])
    expect(writeFrame.mock.calls.map((call) => call[1])).toEqual([frameA, frameB])
    expect(writeFrame.mock.calls.map((call) => call[2])).toEqual([{ flag: 'wx' }, { flag: 'wx' }])
  })

  it('does not treat EOI-like bytes inside a length-delimited segment as a frame boundary', async () => {
    const frame = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x11, 0xff, 0xd9, 0x22, 0xff, 0xda, 0x00, 0x02, 0x33,
      0xff, 0x00, 0x44, 0xff, 0xd9,
    ])
    const writeFrame = vi.fn(async (path: string, bytes: Buffer, options: { flag: 'wx' }) => {
      void path
      void bytes
      void options
    })
    const writer = new JpegFrameWriter({
      budget: new MediaGeneratedOutputBudget(100),
      directory: 'frames',
      writeFrame,
    })
    await writeChunks(writer, [frame.subarray(0, 9), frame.subarray(9, 17), frame.subarray(17)])

    expect(findJpegFrameEnd(frame)).toBe(frame.byteLength)
    expect(writeFrame).toHaveBeenCalledOnce()
    expect(writeFrame.mock.calls[0]?.[1]).toEqual(frame)
  })

  it('rejects a crossing frame before writing it', async () => {
    const writeFrame = vi.fn(async (path: string, frame: Buffer, options: { flag: 'wx' }) => {
      void path
      void frame
      void options
    })
    const budget = new MediaGeneratedOutputBudget(frameA.byteLength)
    const writer = new JpegFrameWriter({ budget, directory: 'frames', writeFrame })
    const settled = finished(writer)
    writer.end(Buffer.concat([frameA, frameB]))

    await expect(settled).rejects.toBeInstanceOf(MediaGeneratedOutputLimitError)
    expect(writeFrame).toHaveBeenCalledOnce()
    expect(budget.bytes).toBe(frameA.byteLength)
  })

  it('rejects malformed, incomplete, oversized, and excess frames', async () => {
    const cases: Array<{
      chunks: Buffer[]
      options?: { maxFrameBytes?: number; maxFrames?: number }
    }> = [
      { chunks: [Buffer.from('not-jpeg')] },
      { chunks: [frameA.subarray(0, -1)] },
      { chunks: [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])] },
      { chunks: [frameA], options: { maxFrameBytes: frameA.byteLength - 1 } },
      { chunks: [Buffer.concat([frameA, frameB])], options: { maxFrames: 1 } },
    ]

    for (const testCase of cases) {
      const writer = new JpegFrameWriter({
        budget: new MediaGeneratedOutputBudget(100),
        directory: 'frames',
        writeFrame: async () => undefined,
        ...testCase.options,
      })
      await expect(writeChunks(writer, testCase.chunks)).rejects.toBeInstanceOf(
        JpegFrameStreamError,
      )
    }
  })

  it('keeps explicit frame-count and memory fuses', () => {
    expect(MAX_GENERATED_VIDEO_FRAMES).toBe(120)
    expect(MAX_GENERATED_FRAME_BYTES).toBe(32 * 1024 * 1024)
  })
})
