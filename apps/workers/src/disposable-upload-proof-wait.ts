export class DisposableUploadProofTimeout extends Error {
  readonly code = 'DISPOSABLE_UPLOAD_WORKER_WAIT_TIMEOUT'
  constructor(description: string) {
    super(`DISPOSABLE_UPLOAD_WORKER_WAIT_TIMEOUT: ${description}`)
  }
}

export async function withDisposableUploadProofDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DisposableUploadProofTimeout(`Timed out waiting for ${description}`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function waitForDisposableUploadProof<T>(
  probe: () => Promise<T | null>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await withDisposableUploadProofDeadline(probe, deadline - Date.now(), description)
    if (value !== null) return value
    const remaining = deadline - Date.now()
    if (remaining > 0) {
      await withDisposableUploadProofDeadline(
        () => new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining))),
        remaining,
        description,
      )
    }
  }
  throw new DisposableUploadProofTimeout(`Timed out waiting for ${description}`)
}
