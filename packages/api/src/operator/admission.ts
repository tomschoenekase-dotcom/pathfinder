import { db } from '@pathfinder/db'

import type { OperatorDatabase } from './audit'

/** Calls one connection may make per minute across every tool. */
export const OPERATOR_CALLS_PER_MINUTE = 120
/** Changes one connection may have applied by policy (no human) per hour. Past it, they ask. */
export const OPERATOR_AUTO_APPLIES_PER_HOUR = 120

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Old counters are only history; they are swept opportunistically, never on the hot path alone. */
const RETAIN_MS = 6 * HOUR_MS

export type Admission = Readonly<{
  allowed: boolean
  count: number
  limit: number
  retryAfterSeconds: number
  /** True only for the first denied request of a window, so denials can be recorded once. */
  firstDenial: boolean
}>

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * Admits a request by counting it in the same statement that decides. Two concurrent callers get
 * different counts, so a burst can never all slip past a read-then-act gap, and a denied caller's
 * retries only increment a number: they neither extend the window nor write more rows.
 */
export async function admit(
  database: OperatorDatabase,
  key: string,
  limit: number,
  windowMs: number,
  now: Date,
): Promise<Admission> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
  const where = { key_windowStart: { key, windowStart } }
  const bump = () =>
    database.operatorAdmissionCounter.upsert({
      where,
      create: { key, windowStart, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    })
  let count: number
  try {
    count = (await bump()).count
  } catch (error) {
    // Two first callers of a window raced to create the row; the loser simply increments it.
    if (!isUniqueViolation(error)) throw error
    count = (await bump()).count
  }
  if (count === 1) {
    // A new window is the cheap moment to sweep very old counters; failure here never matters.
    void database.operatorAdmissionCounter
      .deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - RETAIN_MS) } } })
      .catch(() => undefined)
  }
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
    ),
    firstDenial: count === limit + 1,
  }
}

export const admitCall = (database: OperatorDatabase = db, grantId: string, now: Date) =>
  admit(database, `calls:${grantId}`, OPERATOR_CALLS_PER_MINUTE, MINUTE_MS, now)

/** Budget for changes applied by policy. When spent, work waits for a human instead. */
export const admitAutoApply = (database: OperatorDatabase = db, grantId: string, now: Date) =>
  admit(database, `auto:${grantId}`, OPERATOR_AUTO_APPLIES_PER_HOUR, HOUR_MS, now)
