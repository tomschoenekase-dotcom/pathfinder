import { describe, expect, it, vi } from 'vitest'

import {
  createEscalatingShutdownHandler,
  createShutdownCoordinator,
  runStartupWithCleanup,
} from './worker-lifecycle'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('worker shutdown lifecycle', () => {
  it('closes every registered startup resource before preserving the startup failure', async () => {
    const startupFailure = new Error('scheduler registration failed')
    const closes = Array.from({ length: 9 }, () => vi.fn(async () => undefined))
    const closeConnection = vi.fn(async () => undefined)
    const cleanup = createShutdownCoordinator({
      onStart: vi.fn(),
      phases: [
        {
          name: 'scheduler-queues',
          resources: closes.map((close, index) => ({ name: `queue-${index}`, close })),
        },
        { name: 'connection', resources: [{ name: 'redis', close: closeConnection }] },
      ],
    })

    const error = await runStartupWithCleanup(
      async () => Promise.reject(startupFailure),
      cleanup,
    ).catch((failure: unknown) => failure)

    expect(error).toBe(startupFailure)
    for (const close of closes) expect(close).toHaveBeenCalledOnce()
    expect(closeConnection).toHaveBeenCalledOnce()
  })

  it('preserves startup and cleanup failures together', async () => {
    const startupFailure = new Error('scheduler registration failed')
    const cleanupFailure = new Error('redis close failed')

    const error = await runStartupWithCleanup(
      async () => Promise.reject(startupFailure),
      async () => Promise.reject(cleanupFailure),
    ).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([startupFailure, cleanupFailure])
  })

  it('returns one in-flight promise and closes phases in dependency order', async () => {
    const workerClose = deferred()
    const order: string[] = []
    const shutdown = createShutdownCoordinator({
      onStart: () => order.push('start'),
      phases: [
        {
          name: 'workers',
          resources: [
            {
              name: 'worker-a',
              close: () => {
                order.push('worker')
                return workerClose.promise
              },
            },
          ],
        },
        {
          name: 'queues',
          resources: [
            {
              name: 'queue-a',
              close: async () => {
                order.push('queue')
              },
            },
          ],
        },
        {
          name: 'connection',
          resources: [
            {
              name: 'redis',
              close: async () => {
                order.push('redis')
              },
            },
          ],
        },
      ],
    })

    const first = shutdown()
    const second = shutdown()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(order).toEqual(['start', 'worker'])

    workerClose.resolve()
    await first
    expect(order).toEqual(['start', 'worker', 'queue', 'redis'])
  })

  it('waits for every resource and later phase before surfacing labelled failures', async () => {
    const successfulWorkerClose = vi.fn(async () => undefined)
    const queueClose = vi.fn(async () => undefined)
    const connectionClose = vi.fn(async () => undefined)
    const shutdown = createShutdownCoordinator({
      onStart: vi.fn(),
      phases: [
        {
          name: 'workers',
          resources: [
            { name: 'broken', close: async () => Promise.reject(new Error('close failed')) },
            { name: 'healthy', close: successfulWorkerClose },
          ],
        },
        { name: 'queues', resources: [{ name: 'queue', close: queueClose }] },
        { name: 'connection', resources: [{ name: 'redis', close: connectionClose }] },
      ],
    })

    const error = await shutdown().catch((failure: unknown) => failure)
    expect(successfulWorkerClose).toHaveBeenCalledOnce()
    expect(queueClose).toHaveBeenCalledOnce()
    expect(connectionClose).toHaveBeenCalledOnce()
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toMatchObject([
      { message: 'workers/broken: close failed' },
    ])
  })

  it('flattens nested aggregate failures so every resource identity reaches the caller', async () => {
    const shutdown = createShutdownCoordinator({
      onStart: vi.fn(),
      phases: [
        {
          name: 'enqueue-queues',
          resources: [
            {
              name: 'cached',
              close: async () =>
                Promise.reject(
                  new AggregateError(
                    [new Error('queue-a: first'), new Error('queue-b: second')],
                    'cache close failed',
                  ),
                ),
            },
          ],
        },
      ],
    })

    const error = await shutdown().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toMatchObject([
      { message: 'enqueue-queues/cached: queue-a: first' },
      { message: 'enqueue-queues/cached: queue-b: second' },
    ])
  })

  it('starts graceful shutdown once and escalates a second signal', async () => {
    const failure = new Error('shutdown failed')
    const shutdown = vi.fn(async () => Promise.reject(failure))
    const onFailure = vi.fn()
    const onEscalate = vi.fn()
    const handleSignal = createEscalatingShutdownHandler(shutdown, onFailure, onEscalate)

    handleSignal()
    handleSignal()
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(failure))
    expect(shutdown).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onEscalate).toHaveBeenCalledOnce()
  })
})
