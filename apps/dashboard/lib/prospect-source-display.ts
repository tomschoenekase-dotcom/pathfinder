/** Read-only presentation of retained evidence; never promotes source data to authority. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function recordedWorkbookLocation(value: unknown) {
  const source = object(object(value)._source)
  if (
    typeof source.sheetName !== 'string' ||
    !Number.isInteger(source.originalRowNumber) ||
    Number(source.originalRowNumber) < 2
  )
    return null
  return {
    sheetName: source.sheetName,
    originalRowNumber: Number(source.originalRowNumber),
    rawRowSha256: typeof source.rawRowSha256 === 'string' ? source.rawRowSha256 : null,
  }
}

export function capturedWorkbookLocation(value: unknown) {
  return recordedWorkbookLocation(object(value).raw)
}

export function recordedResearchDate(value: unknown, fallback: Date | string | null | undefined) {
  const recorded = object(object(value).normalized).researchedAt
  // A workbook calendar date is not midnight in the viewer's timezone. Retain
  // the source day and its absent time instead of displaying the previous day.
  if (typeof recorded === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(recorded)) {
    const parsed = new Date(`${recorded}T00:00:00Z`)
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === recorded)
      return `${recorded} (source date; time not recorded)`
  }
  const date = fallback ? new Date(fallback) : null
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Date not recorded'
}

export function recordedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export function prospectDirectoryReturnHref(base: string, query?: string) {
  const allowed = new Set([
    'scope',
    'venue',
    'query',
    'geography',
    'lifecycle',
    'city',
    'state',
    'rankingState',
    'contactability',
    'stale',
    'sorts',
    'page',
    'pageSize',
    'search',
    'stage',
    'priority',
    'tier',
    'emailReadiness',
    'nextAction',
    'territoryId',
    'category',
    'contactState',
    'provenance',
    'completeness',
    'websiteState',
    'sort',
  ])
  const retained = new URLSearchParams()
  if (query && query.length <= 3000)
    for (const [key, value] of new URLSearchParams(query)) {
      if (allowed.has(key)) retained.set(key, value)
    }
  return retained.size ? `${base}?${retained}` : base
}

export function recordedContactRole(provenance: unknown) {
  if (!Array.isArray(provenance))
    return 'Contact fields recorded; identity not independently verified.'
  const roles = provenance.map((value) => object(value).sourceRole)
  return roles.includes('GENERAL_CHANNEL_RECORDED')
    ? 'General/public channel recorded; not assigned to a named person.'
    : 'Contact fields recorded; identity not independently verified.'
}
