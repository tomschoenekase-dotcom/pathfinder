export class ProspectImportPollingCancelledError extends Error {
  constructor() {
    super('PROSPECT_IMPORT_POLLING_CANCELLED')
    this.name = 'ProspectImportPollingCancelledError'
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
