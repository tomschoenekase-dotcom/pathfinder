import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  BoundedStreamingProcessError,
  runBoundedStreamingLeafProcess,
} from './bounded-streaming-process'

const node = process.execPath

function collectOutput(chunks: Buffer[]) {
  return async (stdout: NodeJS.ReadableStream, signal: AbortSignal) => {
    await pipeline(
      stdout,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk)
          callback()
        },
      }),
      { signal },
    )
  }
}

describe('runBoundedStreamingLeafProcess', () => {
  it('streams stdout with backpressure and direct arguments', async () => {
    const chunks: Buffer[] = []
    await runBoundedStreamingLeafProcess(node, ['-e', "process.stdout.write('streamed')"], {
      consumeStdout: collectOutput(chunks),
      label: 'test process',
      maxStderrBytes: 1024,
      timeoutMs: 5000,
    })
    expect(Buffer.concat(chunks).toString()).toBe('streamed')
  })

  it('kills a child at its timeout', async () => {
    const startedAt = Date.now()
    await expect(
      runBoundedStreamingLeafProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], {
        consumeStdout: collectOutput([]),
        label: 'test process',
        maxStderrBytes: 1024,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' })
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })

  it('kills a child after external cancellation', async () => {
    const controller = new AbortController()
    const result = runBoundedStreamingLeafProcess(node, ['-e', 'setTimeout(() => {}, 10000)'], {
      consumeStdout: collectOutput([]),
      label: 'test process',
      maxStderrBytes: 1024,
      signal: controller.signal,
      timeoutMs: 5000,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(result).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('refuses a pre-aborted launch without changing cancellation classification', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runBoundedStreamingLeafProcess(node, ['-e', "process.stdout.write('unused')"], {
        consumeStdout: collectOutput([]),
        label: 'test process',
        maxStderrBytes: 1024,
        signal: controller.signal,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ reason: 'aborted' })
  })

  it('kills a producer and preserves the consumer failure', async () => {
    const consumerFailure = new Error('budget crossed')
    await expect(
      runBoundedStreamingLeafProcess(
        node,
        ['-e', "process.stdout.write('data'); setTimeout(() => {}, 10000)"],
        {
          consumeStdout: async () => {
            throw consumerFailure
          },
          label: 'test process',
          maxStderrBytes: 1024,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toBe(consumerFailure)
  })

  it('kills a child before stderr can exceed the bound', async () => {
    await expect(
      runBoundedStreamingLeafProcess(
        node,
        ['-e', "process.stderr.write('x'.repeat(4096)); setTimeout(() => {}, 10000)"],
        {
          consumeStdout: collectOutput([]),
          label: 'test process',
          maxStderrBytes: 1024,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toMatchObject({ reason: 'stderr-limit' })
  })

  it('returns bounded stderr for an ordinary nonzero exit', async () => {
    await expect(
      runBoundedStreamingLeafProcess(
        node,
        ['-e', "process.stderr.write('expected failure'); process.exit(7)"],
        {
          consumeStdout: collectOutput([]),
          label: 'test process',
          maxStderrBytes: 1024,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toMatchObject({ message: 'expected failure', reason: 'exit' })
  })

  it('waits for child close before accepting a completed stdout consumer', async () => {
    const chunks: Buffer[] = []
    const startedAt = Date.now()
    await expect(
      runBoundedStreamingLeafProcess(
        node,
        ['-e', "process.stdout.write('complete'); setTimeout(() => process.exit(9), 100)"],
        {
          consumeStdout: collectOutput(chunks),
          label: 'test process',
          maxStderrBytes: 1024,
          timeoutMs: 5000,
        },
      ),
    ).rejects.toMatchObject({ reason: 'exit' })
    expect(Buffer.concat(chunks).toString()).toBe('complete')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75)
  })

  it('classifies a missing executable without leaking platform details', async () => {
    await expect(
      runBoundedStreamingLeafProcess('pathfinder-executable-that-does-not-exist', [], {
        consumeStdout: collectOutput([]),
        label: 'test process',
        maxStderrBytes: 1024,
        timeoutMs: 5000,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BoundedStreamingProcessError>>({
        message: 'test process could not be started.',
        reason: 'spawn',
      }),
    )
  })
})
