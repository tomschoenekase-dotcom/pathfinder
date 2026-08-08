import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

export type BoundedStreamingProcessFailureReason =
  | 'aborted'
  | 'exit'
  | 'spawn'
  | 'stderr-limit'
  | 'timeout'

export class BoundedStreamingProcessError extends Error {
  constructor(
    message: string,
    readonly reason: BoundedStreamingProcessFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BoundedStreamingProcessError'
  }
}

type TerminationCause = 'consumer' | 'external' | 'stderr-limit' | 'timeout'

export async function runBoundedStreamingLeafProcess(
  executable: string,
  args: readonly string[],
  options: {
    consumeStdout: (stdout: Readable, signal: AbortSignal) => Promise<void>
    label: string
    maxStderrBytes: number
    signal?: AbortSignal
    timeoutMs: number
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2_147_483_647
  ) {
    throw new RangeError('Process timeout must fit the positive 32-bit timer range.')
  }
  if (!Number.isSafeInteger(options.maxStderrBytes) || options.maxStderrBytes <= 0) {
    throw new RangeError('Process stderr limit must be a positive safe integer.')
  }

  const controller = new AbortController()
  let terminationCause: TerminationCause | undefined
  const abort = (cause: TerminationCause) => {
    if (terminationCause !== undefined) return
    terminationCause = cause
    controller.abort()
  }
  const forwardAbort = () => abort('external')
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()

  const timeout = setTimeout(() => abort('timeout'), options.timeoutMs)
  timeout.unref?.()

  let childError: unknown
  let consumerError: unknown
  let stderrLimitError: BoundedStreamingProcessError | undefined
  const stderrChunks: Buffer[] = []
  let stderrBytes = 0

  try {
    const child = spawn(executable, [...args], {
      shell: false,
      signal: controller.signal,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (!child.stdout || !child.stderr) {
      throw new BoundedStreamingProcessError(
        `${options.label} did not expose bounded output streams.`,
        'spawn',
      )
    }

    child.once('error', (error) => {
      childError = error
    })
    child.stderr.on('data', (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      if (stderrLimitError) return
      if (chunk.byteLength > options.maxStderrBytes - stderrBytes) {
        stderrLimitError = new BoundedStreamingProcessError(
          `${options.label} exceeded its ${options.maxStderrBytes}-byte stderr limit.`,
          'stderr-limit',
        )
        abort('stderr-limit')
        return
      }
      stderrBytes += chunk.byteLength
      stderrChunks.push(chunk)
    })

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }))
      },
    )
    const consumed = Promise.resolve()
      .then(() => options.consumeStdout(child.stdout!, controller.signal))
      .catch((error: unknown) => {
        consumerError = error
        abort('consumer')
      })

    const [exit] = await Promise.all([closed, consumed])
    if (terminationCause === 'consumer') throw consumerError
    if (terminationCause === 'external') {
      throw new BoundedStreamingProcessError(`${options.label} was cancelled.`, 'aborted', {
        cause: childError,
      })
    }
    if (terminationCause === 'timeout') {
      throw new BoundedStreamingProcessError(
        `${options.label} exceeded its ${options.timeoutMs}-millisecond execution limit.`,
        'timeout',
        { cause: childError },
      )
    }
    if (terminationCause === 'stderr-limit') throw stderrLimitError
    if (childError) {
      throw new BoundedStreamingProcessError(`${options.label} could not be started.`, 'spawn', {
        cause: childError,
      })
    }
    if (consumerError) throw consumerError
    if (exit.code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
      throw new BoundedStreamingProcessError(
        stderr ||
          `${options.label} failed${exit.code === null ? '' : ` with code ${String(exit.code)}`}.`,
        'exit',
      )
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}
