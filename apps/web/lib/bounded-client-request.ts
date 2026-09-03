export type BoundedClientRequestFailure = 'CANCELLED' | 'DEADLINE_EXCEEDED'

export class BoundedClientRequestError extends Error {
  constructor(readonly code: BoundedClientRequestFailure) {
    super(code)
    this.name = 'BoundedClientRequestError'
  }
}

export async function runBoundedClientRequest<T>(input: {
  parentSignal: AbortSignal
  timeoutMs: number
  request: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (input.parentSignal.aborted) throw new BoundedClientRequestError('CANCELLED')
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
    throw new RangeError('Request deadline must be a positive safe integer')

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectCancellation: ((error: BoundedClientRequestError) => void) | undefined
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject
  })
  const onParentAbort = () => {
    controller.abort()
    rejectCancellation?.(new BoundedClientRequestError('CANCELLED'))
  }
  input.parentSignal.addEventListener('abort', onParentAbort, { once: true })
  try {
    const operation = Promise.resolve().then(() => input.request(controller.signal))
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new BoundedClientRequestError('DEADLINE_EXCEEDED'))
      }, input.timeoutMs)
    })
    return await Promise.race([operation, cancellation, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    input.parentSignal.removeEventListener('abort', onParentAbort)
  }
}
