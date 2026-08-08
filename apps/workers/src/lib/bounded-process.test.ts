import { describe, expect, it } from 'vitest'

import { runBoundedLeafProcess } from './bounded-process'

const node = process.execPath

describe('runBoundedLeafProcess', () => {
  it('resolves after a successful child process', async () => {
    await expect(
      runBoundedLeafProcess(node, ['-e', 'process.exit(0)'], {
        label: 'test process',
        maxOutputBytesPerStream: 1024,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined()
  })

  it('returns bounded stderr for a non-zero exit', async () => {
    const result = runBoundedLeafProcess(
      node,
      ['-e', "process.stderr.write('bad input'); process.exit(7)"],
      {
        label: 'test process',
        maxOutputBytesPerStream: 1024,
        timeoutMs: 5_000,
      },
    )

    await expect(result).rejects.toMatchObject({
      message: 'bad input',
      reason: 'exit',
    })
  })

  it('kills and rejects a child that exceeds its wall-clock limit', async () => {
    const startedAt = Date.now()
    const result = runBoundedLeafProcess(node, ['-e', 'setTimeout(() => {}, 10_000)'], {
      label: 'test process',
      maxOutputBytesPerStream: 1024,
      timeoutMs: 50,
    })

    await expect(result).rejects.toMatchObject({
      message: 'test process exceeded its 50-millisecond execution limit.',
      reason: 'timeout',
    })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('kills and rejects a child that exceeds its output limit', async () => {
    const result = runBoundedLeafProcess(node, ['-e', "process.stderr.write('x'.repeat(4096))"], {
      label: 'test process',
      maxOutputBytesPerStream: 1024,
      timeoutMs: 5_000,
    })

    await expect(result).rejects.toMatchObject({
      message: 'test process exceeded its 1024-byte per-stream output limit.',
      reason: 'output-limit',
    })
  })

  it('kills and rejects a child when its caller aborts', async () => {
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = runBoundedLeafProcess(node, ['-e', 'setTimeout(() => {}, 10_000)'], {
      label: 'test process',
      maxOutputBytesPerStream: 1024,
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    setTimeout(() => controller.abort(), 50)

    await expect(result).rejects.toMatchObject({
      message: 'test process was cancelled.',
      reason: 'aborted',
    })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('classifies an unavailable executable as a spawn failure', async () => {
    const result = runBoundedLeafProcess('pathfinder-executable-that-does-not-exist', [], {
      label: 'test process',
      maxOutputBytesPerStream: 1024,
      timeoutMs: 5_000,
    })

    await expect(result).rejects.toMatchObject({ reason: 'spawn' })
  })

  it.each([
    ['timeout', { maxOutputBytesPerStream: 1024, timeoutMs: 0 }],
    ['timeout', { maxOutputBytesPerStream: 1024, timeoutMs: Number.MAX_SAFE_INTEGER }],
    ['output limit', { maxOutputBytesPerStream: Number.NaN, timeoutMs: 5_000 }],
  ])('rejects an invalid %s before spawning', async (_label, limits) => {
    await expect(
      runBoundedLeafProcess('unused', [], { label: 'test process', ...limits }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})
