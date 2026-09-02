export class ProspectImportPollingCancelledError extends Error {
  constructor() {
    super('PROSPECT_IMPORT_POLLING_CANCELLED')
    this.name = 'ProspectImportPollingCancelledError'
  }
}

export const PROSPECT_IMPORT_REQUEST_DEADLINE_ERROR =
  'The import service did not respond in time. The durable job may still be running; reopen this import before retrying.'

export class ProspectImportRequestDeadlineError extends Error {
  constructor() {
    super(PROSPECT_IMPORT_REQUEST_DEADLINE_ERROR)
    this.name = 'ProspectImportRequestDeadlineError'
  }
}

export function throwIfProspectImportPollingCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ProspectImportPollingCancelledError()
}

export function waitForProspectImportPoll(signal: AbortSignal, delayMs = 2_000): Promise<void> {
  try {
    throwIfProspectImportPollingCancelled(signal)
  } catch (error) {
    return Promise.reject(error)
  }
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
    return Promise.reject(new RangeError('Poll delay must be a positive safe integer'))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new ProspectImportPollingCancelledError())
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runProspectImportRequest<T>(
  parentSignal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  try {
    return await runBoundedClientRequest({
      parentSignal,
      timeoutMs,
      request,
    })
  } catch (error) {
    if (error instanceof BoundedClientRequestError && error.code === 'CANCELLED') {
      throw new ProspectImportPollingCancelledError()
    }
    if (error instanceof BoundedClientRequestError && error.code === 'DEADLINE_EXCEEDED') {
      throw new ProspectImportRequestDeadlineError()
    }
    throw error
  }
}
import { BoundedClientRequestError, runBoundedClientRequest } from './bounded-client-request'
