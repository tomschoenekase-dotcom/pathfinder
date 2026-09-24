export const CHICAGO_SORT_FIELDS = [
  'productFit',
  'attainability',
  'contactability',
  'evidenceQuality',
  'completeness',
  'researchPriority',
  'name',
  'city',
  'category',
] as const
export type ChicagoSortField = (typeof CHICAGO_SORT_FIELDS)[number]
export type ChicagoDirectoryState = {
  query: string
  geography: 'all' | 'chicago-proper' | 'metro'
  lifecycle: 'active' | 'archived' | 'all'
  category: string
  city: string
  state: string
  rankingState: string
  contactability: string
  stale: boolean | undefined
  sorts: { field: ChicagoSortField; direction: 'asc' | 'desc' }[]
  page: number
  pageSize: number
}

export function readChicagoDirectoryState(params: URLSearchParams): ChicagoDirectoryState {
  const rawSorts = (params.get('sorts') ?? 'productFit:desc,name:asc').split(',')
  const sorts: ChicagoDirectoryState['sorts'] = []
  for (const raw of rawSorts.slice(0, 3)) {
    const [field, direction] = raw.split(':')
    if (
      CHICAGO_SORT_FIELDS.includes(field as ChicagoSortField) &&
      (direction === 'asc' || direction === 'desc') &&
      !sorts.some((item) => item.field === field)
    )
      sorts.push({ field: field as ChicagoSortField, direction })
  }
  const rawPage = Number(params.get('page') ?? 1)
  const size = Number(params.get('pageSize') ?? 50)
  const geography = params.get('geography')
  return {
    query: (params.get('query') ?? '').slice(0, 200),
    geography: geography === 'chicago-proper' || geography === 'metro' ? geography : 'all',
    lifecycle:
      params.get('lifecycle') === 'archived'
        ? 'archived'
        : params.get('lifecycle') === 'all'
          ? 'all'
          : 'active',
    category: (params.get('category') ?? '').slice(0, 200),
    city: (params.get('city') ?? '').slice(0, 200),
    state: params.get('state') ?? '',
    rankingState: params.get('rankingState') ?? '',
    contactability: params.get('contactability') ?? '',
    stale:
      params.get('stale') === 'true' ? true : params.get('stale') === 'false' ? false : undefined,
    sorts: sorts.length
      ? sorts
      : [
          { field: 'productFit', direction: 'desc' },
          { field: 'name', direction: 'asc' },
        ],
    page: Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 100000 ? rawPage : 1,
    pageSize: [25, 50, 100].includes(size) ? size : 50,
  }
}

export function chicagoDirectoryParams(state: ChicagoDirectoryState, venueId?: string | null) {
  const params = new URLSearchParams({
    scope: 'chicago',
    geography: state.geography,
    lifecycle: state.lifecycle,
    page: String(state.page),
    pageSize: String(state.pageSize),
    sorts: state.sorts.map((item) => `${item.field}:${item.direction}`).join(','),
  })
  for (const key of [
    'query',
    'category',
    'city',
    'state',
    'rankingState',
    'contactability',
  ] as const)
    if (state[key]) params.set(key, state[key])
  if (state.stale !== undefined) params.set('stale', String(state.stale))
  if (venueId) params.set('venue', venueId)
  return params
}

export function chicagoLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())
}

export function chicagoSafeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
