export async function startOperationalHeartbeat(options: {
  write: () => Promise<unknown>
  onError: (error: unknown) => void
  intervalMs?: number
}): Promise<() => Promise<void>> {
  let stopped = false
  let activeWrite: Promise<void> | undefined

  const write = () => {
    if (stopped) return activeWrite ?? Promise.resolve()
    if (activeWrite) return activeWrite

    const operation = options
      .write()
      .then(() => undefined)
      .catch((error: unknown) => {
        try {
          options.onError(error)
        } catch {
          // Keep a diagnostic callback failure from escaping the heartbeat task.
        }
      })
      .finally(() => {
        if (activeWrite === operation) activeWrite = undefined
      })
    activeWrite = operation
    return operation
  }

  await write()
  const timer = setInterval(() => {
    void write()
  }, options.intervalMs ?? 30_000)
  timer.unref()

  let stopPromise: Promise<void> | undefined
  return () => {
    if (stopPromise) return stopPromise
    stopped = true
    clearInterval(timer)
    stopPromise = activeWrite ?? Promise.resolve()
    return stopPromise
  }
}
