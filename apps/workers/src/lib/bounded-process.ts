import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type BoundedProcessFailureReason = 'exit' | 'output-limit' | 'spawn' | 'timeout'

export class BoundedProcessError extends Error {
  constructor(
    message: string,
    readonly reason: BoundedProcessFailureReason,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'BoundedProcessError'
  }
}

type ExecFileFailure = Error & {
  code?: number | string | null
  killed?: boolean
  signal?: NodeJS.Signals | null
  stderr?: Buffer | string
}

// This boundary is intentionally for direct leaf executables. Node's portable
// kill contract terminates the child itself, not an arbitrary descendant tree.
export async function runBoundedLeafProcess(
  executable: string,
  args: readonly string[],
  options: {
    label: string
    maxOutputBytesPerStream: number
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
  if (
    !Number.isSafeInteger(options.maxOutputBytesPerStream) ||
    options.maxOutputBytesPerStream <= 0
  ) {
    throw new RangeError('Per-stream process output limit must be a positive safe integer.')
  }

  try {
    await execFileAsync(executable, [...args], {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: options.maxOutputBytesPerStream,
      timeout: options.timeoutMs,
      windowsHide: true,
    })
  } catch (error) {
    const failure = error as ExecFileFailure
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new BoundedProcessError(
        `${options.label} exceeded its ${options.maxOutputBytesPerStream}-byte per-stream output limit.`,
        'output-limit',
        { cause: error },
      )
    }
    if (failure.killed && failure.signal === 'SIGKILL') {
      throw new BoundedProcessError(
        `${options.label} exceeded its ${options.timeoutMs}-millisecond execution limit.`,
        'timeout',
        { cause: error },
      )
    }

    const stderr = String(failure.stderr ?? '').trim()
    const code = failure.code
    const reason = typeof code === 'number' || code === null ? 'exit' : 'spawn'
    throw new BoundedProcessError(
      stderr || `${options.label} failed${code === undefined ? '' : ` with code ${String(code)}`}.`,
      reason,
      { cause: error },
    )
  }
}
