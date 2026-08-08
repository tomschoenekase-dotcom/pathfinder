import { db } from '@pathfinder/db'

export function startOfCurrentUtcWeek(date: Date): Date {
  const result = new Date(date)
  const day = result.getUTCDay()
  const daysFromMonday = (day + 6) % 7

  result.setUTCDate(result.getUTCDate() - daysFromMonday)
  result.setUTCHours(0, 0, 0, 0)

  return result
}

export function endOfUtcWeek(weekStart: Date): Date {
  const result = new Date(weekStart)

  result.setUTCDate(result.getUTCDate() + 6)
  result.setUTCHours(23, 59, 59, 999)

  return result
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

export async function uniqueTenantSlug(base: string): Promise<string> {
  let candidate = base
  let suffix = 2

  for (;;) {
    const existing = await db.tenant.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })
    if (!existing) return candidate

    candidate = `${base}-${suffix}`
    suffix++
  }
}
