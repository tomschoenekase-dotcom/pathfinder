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
  const heartbeat = setInterval(() => {
    void dependencies
      .checkConnection()
      .catch((error: unknown) =>
        dependencies.onConnectionError(
          error instanceof Error ? error : new Error('Unknown Redis connectivity error'),
        ),
      )
  }, 30_000)

  const shutdown = async () => {
    clearInterval(heartbeat)
    await dependencies.closeConnection()
  }

  return {
    mode: 'provider-disabled' as const,
    queues: [] as const,
    shutdown,
  }
}
