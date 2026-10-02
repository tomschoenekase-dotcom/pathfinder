import { logger } from '@pathfinder/config/logger'

/**
 * Operator page data loading. A failed read must render an honest error panel, never a
 * success-looking empty state, and must leave a structured log line an operator can search.
 * Categories are coarse on purpose: they are safe to show and safe to log.
 */
export type OperatorPanelFailureCategory =
  | 'schema_not_ready'
  | 'database_unavailable'
  | 'access_denied'
  | 'unexpected'

export type OperatorPanelResult<T> =
  | { ok: true; data: T }
  | { ok: false; category: OperatorPanelFailureCategory }

type ErrorLike = { code?: unknown; name?: unknown; digest?: unknown; cause?: unknown }

function asRecord(value: unknown): ErrorLike {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : {}
}

/** Walks error -> cause (tRPC wraps the original error as `cause`). */
function chain(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    out.push(asRecord(current))
    current = asRecord(current).cause
  }
  return out
}

/** Next.js control-flow errors (notFound, redirect, dynamic bailout) must never be swallowed. */
export function isNextControlFlowError(error: unknown): boolean {
  const digest = asRecord(error).digest
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_') ||
      digest === 'DYNAMIC_SERVER_USAGE' ||
      digest.startsWith('BAILOUT'))
  )
}

export function isNotFoundTrpcError(error: unknown): boolean {
  return asRecord(error).code === 'NOT_FOUND'
}

export function classifyOperatorPanelError(error: unknown): {
  category: OperatorPanelFailureCategory
  code: string | null
} {
  const codes = chain(error)
    .map((link) => link.code)
    .filter((code): code is string => typeof code === 'string')
  // Prisma: P2021 table missing, P2022 column missing (a migration has not reached this database).
  const prisma = codes.find((code) => /^P\d{4}$/.test(code)) ?? null
  if (prisma === 'P2021' || prisma === 'P2022') {
    return { category: 'schema_not_ready', code: prisma }
  }
  if (prisma && ['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(prisma)) {
    return { category: 'database_unavailable', code: prisma }
  }
  const denied = codes.find((code) => code === 'UNAUTHORIZED' || code === 'FORBIDDEN')
  if (denied) return { category: 'access_denied', code: denied }
  return { category: 'unexpected', code: prisma ?? codes[0] ?? null }
}

/**
 * Runs one panel's read. Control-flow errors and tRPC NOT_FOUND (the operator is absent by
 * design) propagate; every other failure is logged with its category and returned as data.
 */
export async function loadOperatorPanel<T>(
  panel: string,
  read: () => Promise<T>,
): Promise<OperatorPanelResult<T>> {
  try {
    return { ok: true, data: await read() }
  } catch (error) {
    if (isNextControlFlowError(error) || isNotFoundTrpcError(error)) throw error
    const { category, code } = classifyOperatorPanelError(error)
    const errorType = chain(error)
      .map((link) => (typeof link.name === 'string' ? link.name : null))
      .find((name) => name !== null && /^[A-Za-z0-9_.-]+$/.test(name))
    logger.error({
      action: 'operator.panel.load_failed',
      panel,
      category,
      ...(code ? { errorCode: code } : {}),
      ...(errorType ? { errorType } : {}),
      error: error instanceof Error ? error.message : 'non-error thrown',
    })
    return { ok: false, category }
  }
}

export const OPERATOR_PANEL_FAILURE_COPY: Record<OperatorPanelFailureCategory, string> = {
  schema_not_ready: 'The database is missing a recent update this section needs.',
  database_unavailable: 'The database did not respond.',
  access_denied: 'Your session is not allowed to read this section.',
  unexpected: 'An unexpected error occurred.',
}
