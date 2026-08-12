export type AdminReportRouteQuery = {
  weekStart?: string
  weekEnd?: string
  cursorWeekStart?: string
  cursorId?: string
}

type ResolvedAdminReportRouteInput = {
  weekStart: Date
  weekEnd: Date
  cursor: { weekStart: string; id: string } | null
  warning: string | null
}

function defaultRangeStart(now: Date) {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - 6)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

function parseCalendarDate(value: string | undefined, endOfDay: boolean): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  return date
}

function isIsoDateTime(value: string): boolean {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

export function resolveAdminReportRouteInput(
  query: AdminReportRouteQuery,
  now = new Date(),
): ResolvedAdminReportRouteInput {
  const fallbackStart = defaultRangeStart(now)
  const suppliedDateFilter = query.weekStart !== undefined || query.weekEnd !== undefined
  const parsedStart = query.weekStart ? parseCalendarDate(query.weekStart, false) : fallbackStart
  const parsedEnd = query.weekEnd ? parseCalendarDate(query.weekEnd, true) : new Date(now)

  let warning: string | null = null
  let weekStart = parsedStart
  let weekEnd = parsedEnd
  if (!weekStart || !weekEnd || weekStart > weekEnd) {
    weekStart = fallbackStart
    weekEnd = new Date(now)
    warning = suppliedDateFilter
      ? 'The report date filter was invalid, so the default recent range is shown.'
      : null
  }

  const hasCursorPart = query.cursorWeekStart !== undefined || query.cursorId !== undefined
  const validCursor =
    typeof query.cursorWeekStart === 'string' &&
    isIsoDateTime(query.cursorWeekStart) &&
    typeof query.cursorId === 'string' &&
    query.cursorId.length > 0 &&
    query.cursorId.length <= 191

  if (hasCursorPart && !validCursor) {
    warning = warning
      ? `${warning} The report page cursor was also invalid, so the newest page is shown.`
      : 'The report page cursor was invalid, so the newest page is shown.'
  }

  return {
    weekStart,
    weekEnd,
    cursor: validCursor
      ? { weekStart: query.cursorWeekStart as string, id: query.cursorId as string }
      : null,
    warning,
  }
}
