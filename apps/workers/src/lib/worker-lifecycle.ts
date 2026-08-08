export type CloseResource = {
  name: string
  close: () => Promise<unknown>
}

export type ClosePhase = {
  name: string
  resources: CloseResource[]
}

function labelledFailures(prefix: string, reason: unknown): Error[] {
  if (reason instanceof AggregateError) {
    return reason.errors.flatMap((child) => labelledFailures(prefix, child))
  }
  const detail = reason instanceof Error ? reason.message : 'Unknown close error'
  return [new Error(`${prefix}: ${detail}`, { cause: reason })]
}

export function createShutdownCoordinator(options: {
  phases: ClosePhase[]
  onStart: () => void
}): () => Promise<void> {
  let inFlight: Promise<void> | undefined

  return function shutdown(): Promise<void> {
    if (inFlight) return inFlight

    inFlight = (async () => {
      options.onStart()
      const failures: Error[] = []

      for (const phase of options.phases) {
        const results = await Promise.allSettled(
          phase.resources.map((resource) => Promise.resolve().then(() => resource.close())),
        )
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return
          const resource = phase.resources[index]!
          failures.push(...labelledFailures(`${phase.name}/${resource.name}`, result.reason))
        })
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Worker shutdown completed with resource failures.')
      }
    })()

    return inFlight
  }
}

export async function runStartupWithCleanup<T>(
  start: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await start()
  } catch (startupError) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'Worker startup failed and cleanup reported resource failures.',
      )
    }
    throw startupError
  }
}

export function createEscalatingShutdownHandler(
  shutdown: () => Promise<void>,
  onFailure: (error: unknown) => void,
  onEscalate: () => void,
): () => void {
  let started = false

  return () => {
    if (started) {
      onEscalate()
      return
    }
    started = true
    void shutdown().catch(onFailure)
  }
}
