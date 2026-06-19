import { logger } from './logger'

/**
 * Fails fast (throws) when a required environment variable is missing or empty.
 *
 * The shared `env` schema marks several keys optional because not every surface
 * needs them (e.g. the dashboard does not need OPENAI_API_KEY). Use this at a
 * process entry point to assert the keys THAT surface actually requires, so a
 * misconfigured deploy fails immediately with a clear message instead of
 * surfacing hours later as a silently broken job or a 500 on first use.
 */
export function assertServerEnv(requiredKeys: string[], context: string): void {
  const missing = requiredKeys.filter((key) => {
    const value = process.env[key]
    return value === undefined || value === ''
  })

  if (missing.length > 0) {
    const message = `Missing required environment variable(s) for ${context}: ${missing.join(', ')}`
    logger.error({ action: 'env.assert_failed', context, error: message })
    throw new Error(message)
  }
}
