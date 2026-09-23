import { db } from '../client'

const MAX_POSTGRES_TIMEOUT_MS = 2_147_483_647
const MIN_HEALTH_TIMEOUT_MS = 4

function validateTimeout(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_HEALTH_TIMEOUT_MS ||
    timeoutMs > MAX_POSTGRES_TIMEOUT_MS
  ) {
    throw new Error('Health-check timeout must be a supported PostgreSQL integer')
  }
}

export async function checkDatabaseConnection(timeoutMs: number): Promise<unknown> {
  validateTimeout(timeoutMs)
  // The public venue lookup and normal reads do not open an interactive
  // transaction. Probe the same minimal read path; the health route applies
  // its own deadline and reports a timeout rather than a false success.
  return db.$queryRaw`SELECT 1`
}
