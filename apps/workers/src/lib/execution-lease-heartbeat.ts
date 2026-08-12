export class ExecutionLeaseOwnershipLostError extends Error {
  readonly code = 'execution-lease-ownership-lost'

  constructor(message = 'Execution lease ownership was lost.') {
    super(message)
    this.name = 'ExecutionLeaseOwnershipLostError'
  }
}

export class ExecutionLeaseCancelledError extends Error {
  readonly code = 'execution-lease-cancelled'

  constructor(message = 'Execution was cancelled by the user.') {
    super(message)
    this.name = 'ExecutionLeaseCancelledError'
  }
}

type LeaseHeartbeatOptions<T> = {
  intervalMs: number
  renew: () => Promise<boolean>
  operation: (signal: AbortSignal) => Promise<T>
  leaseLostError?: () => Error | Promise<Error>
  signal?: AbortSignal
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Execution aborted.')
}

export async function withExecutionLeaseHeartbeat<T>(
  options: LeaseHeartbeatOptions<T>,
): Promise<T> {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Lease heartbeat interval must be positive.')
  }

  const controller = new AbortController()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeat: Promise<void> | undefined

  const loseLease = async (): Promise<never> => {
    const error = options.leaseLostError
      ? await options.leaseLostError()
      : new ExecutionLeaseOwnershipLostError()
    if (!controller.signal.aborted) controller.abort(error)
    throw error
  }
  const renew = async (): Promise<void> => {
    if (!(await options.renew())) await loseLease()
  }
  const schedule = (): void => {
    if (stopped || controller.signal.aborted) return
    timer = setTimeout(() => {
      heartbeat = renew()
        .then(schedule)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) controller.abort(error)
        })
    }, options.intervalMs)
  }
  const onExternalAbort = (): void => {
    if (!controller.signal.aborted && options.signal) {
      controller.abort(abortReason(options.signal))
    }
  }

  if (options.signal?.aborted) throw abortReason(options.signal)
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    await renew()
    schedule()
    const result = await options.operation(controller.signal)
    if (controller.signal.aborted) throw abortReason(controller.signal)
    await renew()
    return result
  } finally {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
    await heartbeat?.catch(() => undefined)
  }
}
