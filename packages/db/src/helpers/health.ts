import { db } from '../client'

const MAX_POSTGRES_TIMEOUT_MS = 2_147_483_647
const HEALTH_CLEANUP_MARGIN_MS = 50
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

function probeBudgets(timeoutMs: number): { maxWait: number; execution: number } {
  const margin = Math.min(HEALTH_CLEANUP_MARGIN_MS, Math.max(1, Math.floor(timeoutMs / 20)))
  const total = timeoutMs - margin
  const maxWait = Math.max(1, Math.floor(total / 4))
  return { maxWait, execution: total - maxWait }
}

export async function checkDatabaseConnection(timeoutMs: number): Promise<unknown> {
  validateTimeout(timeoutMs)
  const budgets = probeBudgets(timeoutMs)

  return db.$transaction(
    async (transaction) => {
      // This setting is transaction-local. It cancels a stalled probe in PostgreSQL
      // without imposing a global timeout on application queries.
      await transaction.$executeRaw`SELECT set_config('statement_timeout', ${String(budgets.execution)}, true)`
      return transaction.$queryRaw`SELECT 1`
    },
    {
      maxWait: budgets.maxWait,
      timeout: budgets.execution,
    },
  )
}
