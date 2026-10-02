/**
 * Single source of truth for "is this visitor notice live right now?".
 *
 * `OperationalUpdate.isActive` is only an operator switch (true while published, false once an
 * operator ends the notice). It is NEVER sufficient on its own: a notice can be published with
 * `isActive: true` and still be scheduled for later or long past its expiry. Every guest read,
 * operator read and dashboard label must go through this module.
 *
 * Effective lifecycle, evaluated in this precedence order:
 *   1. DRAFT      status is DRAFT (isActive is ignored).
 *   2. ENDED      published but `isActive` is false: an operator explicitly ended it. This wins over
 *                 the window, so an ended notice never reads as merely "expired".
 *   3. EXPIRED    `expiresAt <= now` (expiry instant is exclusive).
 *   4. SCHEDULED  `startsAt > now` (start instant is inclusive).
 *   5. LIVE       `startsAt <= now < expiresAt`.
 * Only LIVE is guest visible. `isActiveButExpired` flags the dangerous raw combination
 * (published, isActive true, window already over) so operators can be told to clean it up.
 *
 * Timestamps are absolute instants. Timezones matter only where a human supplies local or
 * date-only values: use `dateOnlyWindowToInstants` / `zonedWallTimeToInstant` to turn them into
 * instants in the venue's IANA timezone (DST aware) before storing.
 *
 * Overlap precedence for simultaneously LIVE notices (`compareLiveNoticePrecedence`, most
 * important first): priority (URGENT > HIGH > NORMAL > LOW), then severity (REDIRECT > CLOSURE >
 * WARNING > INFO; this equals the Prisma enum declaration order so the database ORDER BY and this
 * comparator agree), then most recent `startsAt`, then `id` ascending as a stable tiebreak.
 */

export type OperationalUpdateEffectiveLifecycle =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'LIVE'
  | 'EXPIRED'
  | 'ENDED'

export const OPERATIONAL_UPDATE_LIFECYCLES = [
  'DRAFT',
  'SCHEDULED',
  'LIVE',
  'EXPIRED',
  'ENDED',
] as const satisfies readonly OperationalUpdateEffectiveLifecycle[]

type Instant = Date | string | number

export type OperationalUpdateLifecycleInputShape = {
  status: string
  isActive: boolean
  startsAt: Instant
  expiresAt: Instant
}

export type OperationalUpdateLifecycleResult = {
  lifecycle: OperationalUpdateEffectiveLifecycle
  guestVisibleNow: boolean
  /** Raw `isActive` is true although the notice is not live (expired or not yet started). */
  isActiveButNotLive: boolean
  /** Raw `isActive` is true and the window is over: the production incident shape. */
  isActiveButExpired: boolean
  /** Short operator-facing explanation, safe to show verbatim. */
  label: string
}

function toMs(value: Instant): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

export function computeOperationalUpdateLifecycle(
  update: OperationalUpdateLifecycleInputShape,
  now: Instant = new Date(),
): OperationalUpdateLifecycleResult {
  const current = toMs(now)
  const startsAt = toMs(update.startsAt)
  const expiresAt = toMs(update.expiresAt)
  let lifecycle: OperationalUpdateEffectiveLifecycle
  if (update.status !== 'PUBLISHED') lifecycle = 'DRAFT'
  else if (!update.isActive) lifecycle = 'ENDED'
  else if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || !Number.isFinite(current))
    lifecycle = 'EXPIRED' // fail closed on unparseable data
  else if (expiresAt <= current) lifecycle = 'EXPIRED'
  else if (startsAt > current) lifecycle = 'SCHEDULED'
  else lifecycle = 'LIVE'
  const published = update.status === 'PUBLISHED'
  const isActiveButExpired = published && update.isActive && lifecycle === 'EXPIRED'
  const isActiveButNotLive = published && update.isActive && lifecycle !== 'LIVE'
  const label =
    lifecycle === 'DRAFT'
      ? 'Draft (visitors do not see it)'
      : lifecycle === 'ENDED'
        ? 'Ended by an operator (visitors do not see it)'
        : lifecycle === 'EXPIRED'
          ? 'Expired: marked active but its window is over, so visitors do not see it'
          : lifecycle === 'SCHEDULED'
            ? 'Scheduled (not live until its start time)'
            : 'Live now (visitors see it)'
  return {
    lifecycle,
    guestVisibleNow: lifecycle === 'LIVE',
    isActiveButNotLive,
    isActiveButExpired,
    label,
  }
}

/**
 * The only definition of the guest-visible database filter. Spread into a Prisma `where`; it
 * encodes exactly the LIVE branch above (PUBLISHED, isActive, startsAt <= now < expiresAt).
 */
export function liveOperationalUpdateWindowWhere(now: Date) {
  return {
    status: 'PUBLISHED' as const,
    isActive: true,
    startsAt: { lte: now },
    expiresAt: { gt: now },
  }
}

/** Matches `compareLiveNoticePrecedence` (Prisma enum order: REDIRECT > CLOSURE > WARNING > INFO). */
export const LIVE_OPERATIONAL_UPDATE_ORDER_BY = [
  { priority: 'desc' as const },
  { severity: 'desc' as const },
  { startsAt: 'desc' as const },
  { id: 'asc' as const },
]

const PRIORITY_RANK: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 }
const SEVERITY_RANK: Record<string, number> = { INFO: 0, WARNING: 1, CLOSURE: 2, REDIRECT: 3 }

/** Negative when `a` outranks `b` (sort ascending to get most important first). */
export function compareLiveNoticePrecedence(
  a: { id: string; priority: string; severity: string; startsAt: Instant },
  b: { id: string; priority: string; severity: string; startsAt: Instant },
): number {
  const byPriority = (PRIORITY_RANK[b.priority] ?? -1) - (PRIORITY_RANK[a.priority] ?? -1)
  if (byPriority !== 0) return byPriority
  const bySeverity = (SEVERITY_RANK[b.severity] ?? -1) - (SEVERITY_RANK[a.severity] ?? -1)
  if (bySeverity !== 0) return bySeverity
  const byStart = toMs(b.startsAt) - toMs(a.startsAt)
  if (byStart !== 0) return byStart
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ---------------------------------------------------------------------------
// IANA timezone helpers (venue-local wall time and date-only windows)
// ---------------------------------------------------------------------------

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function offsetMsAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

export type WallTime = {
  year: number
  month: number
  day: number
  hour?: number
  minute?: number
}

/**
 * Converts venue-local wall time to an instant. A wall time skipped by a spring-forward gap
 * resolves to the instant after the gap; an ambiguous fall-back time resolves to its first
 * (earlier, daylight) occurrence.
 */
export function zonedWallTimeToInstant(wall: WallTime, timeZone: string): Date {
  if (!isValidIanaTimeZone(timeZone)) throw new RangeError(`Invalid IANA time zone: ${timeZone}`)
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0)
  const earlier = wallAsUtc - offsetMsAt(wallAsUtc - 86_400_000, timeZone)
  const later = wallAsUtc - offsetMsAt(wallAsUtc + 86_400_000, timeZone)
  const candidates = [earlier, later].filter(
    (candidate) => wallAsUtc - offsetMsAt(candidate, timeZone) === candidate,
  )
  if (candidates.length > 0) return new Date(Math.min(...candidates))
  // Gap: the wall time never existed. Use the pre-transition offset to land just after the gap.
  return new Date(Math.max(earlier, later))
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDateOnly(value: string): { year: number; month: number; day: number } {
  const match = DATE_ONLY.exec(value)
  if (!match) throw new RangeError(`Expected YYYY-MM-DD, received: ${value}`)
  const parsed = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const check = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day))
  if (check.getUTCMonth() !== parsed.month - 1 || check.getUTCDate() !== parsed.day) {
    throw new RangeError(`Not a calendar date: ${value}`)
  }
  return parsed
}

/**
 * A date-only window is inclusive of both calendar days in the venue's timezone:
 * startsAt = local midnight starting `startDate`; expiresAt = local midnight starting the day
 * AFTER `endDate` (exclusive, so the whole last day is covered even on 23h/25h DST days).
 */
export function dateOnlyWindowToInstants(input: {
  startDate: string
  endDate: string
  timeZone: string
}): { startsAt: Date; expiresAt: Date } {
  const start = parseDateOnly(input.startDate)
  const end = parseDateOnly(input.endDate)
  const dayAfterEnd = new Date(Date.UTC(end.year, end.month - 1, end.day + 1))
  const startsAt = zonedWallTimeToInstant(start, input.timeZone)
  const expiresAt = zonedWallTimeToInstant(
    {
      year: dayAfterEnd.getUTCFullYear(),
      month: dayAfterEnd.getUTCMonth() + 1,
      day: dayAfterEnd.getUTCDate(),
    },
    input.timeZone,
  )
  if (startsAt.getTime() >= expiresAt.getTime()) {
    throw new RangeError('End date must not be before the start date')
  }
  return { startsAt, expiresAt }
}
