export async function startProviderDisabledRuntime(dependencies: {
  checkConnection: () => Promise<unknown>
  closeConnection: () => Promise<void>
  onConnectionError: (error: Error) => void
}) {
  try {
    await dependencies.checkConnection()
  } catch (error) {
    try {
      await dependencies.closeConnection()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Redis connectivity check and provider-disabled cleanup both failed',
      )
    }
    throw error
  }
  let inFlightCheck: Promise<void> | undefined
  let stopping = false

  const checkConnection = () => {
    if (stopping || inFlightCheck) return inFlightCheck

    const execution = Promise.resolve()
      .then(() => dependencies.checkConnection())
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          dependencies.onConnectionError(
            error instanceof Error ? error : new Error('Unknown Redis connectivity error'),
          )
        } catch {
          // Keep a diagnostic callback failure from escaping the heartbeat task.
        }
      })
      .finally(() => {
        if (inFlightCheck === execution) inFlightCheck = undefined
      })
    inFlightCheck = execution
    return execution
  }

  const heartbeat = setInterval(() => {
    void checkConnection()
  }, 30_000)

  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      stopping = true
      clearInterval(heartbeat)
      await inFlightCheck
      await dependencies.closeConnection()
    })()
    return shutdownPromise
  }

  return {
    mode: 'provider-disabled' as const,
    queues: [] as const,
    shutdown,
  }
}
