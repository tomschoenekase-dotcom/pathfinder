import { Transform } from 'node:stream'

import { UnrecoverableError } from 'bullmq'

import { MediaAttemptDeadlineExceededError } from './media-job-cancellation'

export const MEDIA_ATTEMPT_DEADLINE_MS = 6 * 60 * 60 * 1000
export const MAX_MEDIA_GENERATED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024

export class MediaGeneratedOutputLimitError extends UnrecoverableError {
  constructor(readonly maxBytes: number) {
    super(`Media ingestion exceeded its ${maxBytes}-byte generated-output safety limit.`)
    this.name = 'MediaGeneratedOutputLimitError'
  }
}

export class MediaGeneratedOutputBudget {
  private retainedBytes = 0

  constructor(readonly maxBytes = MAX_MEDIA_GENERATED_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('Generated-output limit must be a positive safe integer.')
    }
  }

  get bytes(): number {
    return this.retainedBytes
  }

  get remainingBytes(): number {
    return this.maxBytes - this.retainedBytes
  }

  consume(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError('Generated-output bytes must be a nonnegative safe integer.')
    }
    if (bytes > this.remainingBytes) throw new MediaGeneratedOutputLimitError(this.maxBytes)
    this.retainedBytes += bytes
  }

  createTransform(): Transform {
    return new Transform({
      transform: (chunk: Buffer | string, encoding, callback) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        try {
          this.consume(value.byteLength)
          callback(null, value)
        } catch (error) {
          callback(error as Error)
        }
      },
    })
  }
}

export type MediaAttemptSignal = {
  dispose: () => void
  signal: AbortSignal
}

export function createMediaAttemptSignal(
  ownershipSignal?: AbortSignal,
  timeoutMs = MEDIA_ATTEMPT_DEADLINE_MS,
): MediaAttemptSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Media attempt deadline must fit the positive 32-bit timer range.')
  }

  const controller = new AbortController()
  const forwardOwnershipAbort = () => {
    if (!controller.signal.aborted) controller.abort(ownershipSignal?.reason)
  }
  ownershipSignal?.addEventListener('abort', forwardOwnershipAbort, { once: true })
  if (ownershipSignal?.aborted) forwardOwnershipAbort()

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new MediaAttemptDeadlineExceededError(timeoutMs))
    }
  }, timeoutMs)
  timer.unref?.()

  let disposed = false
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      ownershipSignal?.removeEventListener('abort', forwardOwnershipAbort)
    },
  }
}
