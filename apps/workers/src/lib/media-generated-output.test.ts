import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import ffmpegPath from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'

import { runBoundedLeafProcess } from './bounded-process'
import { runBoundedStreamingLeafProcess } from './bounded-streaming-process'
import { JpegFrameWriter } from './jpeg-frame-stream'
import { MediaGeneratedOutputBudget, MediaGeneratedOutputLimitError } from './media-attempt-limits'

const PROCESS_TIMEOUT_MS = 30_000
const STDERR_LIMIT_BYTES = 64 * 1024

async function createFixture(executable: string, inputPath: string): Promise<void> {
  await runBoundedLeafProcess(
    executable,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=4:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      inputPath,
    ],
    {
      label: 'FFmpeg fixture generation',
      maxOutputBytesPerStream: STDERR_LIMIT_BYTES,
      timeoutMs: PROCESS_TIMEOUT_MS,
    },
  )
}

describe('media generated-output streaming (bundled FFmpeg)', () => {
  it('streams readable frames and audio through one exact cumulative byte budget', async () => {
    if (!ffmpegPath) throw new Error('Bundled FFmpeg is unavailable.')
    const directory = await mkdtemp(join(tmpdir(), 'pathfinder-media-output-'))
    const inputPath = join(directory, 'fixture.mp4')
    const frameDirectory = join(directory, 'frames')
    const audioPath = join(directory, 'audio.mp3')
    const budget = new MediaGeneratedOutputBudget(10 * 1024 * 1024)

    try {
      await createFixture(ffmpegPath, inputPath)
      await mkdir(frameDirectory)
      const writer = new JpegFrameWriter({ budget, directory: frameDirectory })
      await runBoundedStreamingLeafProcess(
        ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-vf',
          'fps=2',
          '-frames:v',
          '120',
          '-q:v',
          '2',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        {
          consumeStdout: (stdout, signal) => pipeline(stdout, writer, { signal }),
          label: 'FFmpeg frame proof',
          maxStderrBytes: STDERR_LIMIT_BYTES,
          timeoutMs: PROCESS_TIMEOUT_MS,
        },
      )
      await runBoundedStreamingLeafProcess(
        ffmpegPath,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          '48k',
          '-f',
          'mp3',
          'pipe:1',
        ],
        {
          consumeStdout: (stdout, signal) =>
            pipeline(
              stdout,
              budget.createTransform(),
              createWriteStream(audioPath, { flags: 'wx' }),
              { signal },
            ),
          label: 'FFmpeg audio proof',
          maxStderrBytes: STDERR_LIMIT_BYTES,
          timeoutMs: PROCESS_TIMEOUT_MS,
        },
      )

      const frameNames = await readdir(frameDirectory)
      expect(frameNames).toHaveLength(2)
      let exactBytes = (await stat(audioPath)).size
      expect(exactBytes).toBeGreaterThan(0)
      for (const name of frameNames) {
        const frame = await readFile(join(frameDirectory, name))
        expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
        expect(frame.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
        exactBytes += frame.byteLength
      }
      expect(budget.bytes).toBe(exactBytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('kills FFmpeg before a crossing frame is persisted', async () => {
    if (!ffmpegPath) throw new Error('Bundled FFmpeg is unavailable.')
    const directory = await mkdtemp(join(tmpdir(), 'pathfinder-media-output-limit-'))
    const inputPath = join(directory, 'fixture.mp4')
    const frameDirectory = join(directory, 'frames')

    try {
      await createFixture(ffmpegPath, inputPath)
      await mkdir(frameDirectory)
      const writer = new JpegFrameWriter({
        budget: new MediaGeneratedOutputBudget(100),
        directory: frameDirectory,
      })
      await expect(
        runBoundedStreamingLeafProcess(
          ffmpegPath,
          [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            inputPath,
            '-frames:v',
            '1',
            '-f',
            'image2pipe',
            '-c:v',
            'mjpeg',
            'pipe:1',
          ],
          {
            consumeStdout: (stdout, signal) => pipeline(stdout, writer, { signal }),
            label: 'FFmpeg limit proof',
            maxStderrBytes: STDERR_LIMIT_BYTES,
            timeoutMs: PROCESS_TIMEOUT_MS,
          },
        ),
      ).rejects.toBeInstanceOf(MediaGeneratedOutputLimitError)
      expect(await readdir(frameDirectory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
