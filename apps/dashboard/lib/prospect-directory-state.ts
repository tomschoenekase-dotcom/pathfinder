const NAV_KEY = 'torchiko.prospect-directory.navigation.v1'
const VIEW_KEY = 'torchiko.prospect-directory.preference.v1'
const VIEW_LOCK = 'torchiko.prospect-directory.preference.v1'

export type DirectoryNavigation = {
  base: string
  query: string
  ids: string[]
  scrollY: number
}

export type DirectoryPreference = {
  query: string
  revision: string
}

/**
 * The browser's Web Locks API is the only cross-tab serialization mechanism
 * this module relies on. A Storage read followed by setItem is not atomic.
 */
export type DirectoryPreferenceLocks = {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => T | Promise<T>,
  ): Promise<T>
}

export type DirectoryPreferenceSaveResult =
  | { status: 'saved'; preference: DirectoryPreference }
  | { status: 'conflict'; preference: DirectoryPreference | null }
  | { status: 'serialization-unavailable' }

const FILTER_KEYS = new Set([
  'search',
  'stage',
  'priority',
  'tier',
  'emailReadiness',
  'outreachState',
  'nextAction',
  'territoryId',
  'category',
  'contactState',
  'provenance',
  'completeness',
  'websiteState',
  'sort',
])

export function cleanDirectoryQuery(query: string): string {
  if (query.length > 3000) return ''
  const clean = new URLSearchParams()
  for (const [key, value] of new URLSearchParams(query)) {
    if (FILTER_KEYS.has(key) && value.length <= 200) clean.set(key, value)
  }
  return clean.toString()
}

export function recordDirectoryNavigation(storage: Storage, value: DirectoryNavigation): void {
  storage.setItem(
    NAV_KEY,
    JSON.stringify({
      base: value.base,
      query: cleanDirectoryQuery(value.query),
      ids: value.ids.slice(0, 1000),
      scrollY: Math.max(0, Math.floor(value.scrollY)),
    }),
  )
}

export function readDirectoryNavigation(
  storage: Storage,
  base: string,
  query: string,
): DirectoryNavigation | null {
  try {
    const value = JSON.parse(storage.getItem(NAV_KEY) ?? 'null') as DirectoryNavigation | null
    if (!value || value.base !== base || value.query !== cleanDirectoryQuery(query)) return null
    if (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === 'string')) return null
    if (!Number.isFinite(value.scrollY) || value.scrollY < 0) return null
    return value
  } catch {
    return null
  }
}

export function readDirectoryPreference(storage: Storage): DirectoryPreference | null {
  try {
    const value = JSON.parse(storage.getItem(VIEW_KEY) ?? 'null') as DirectoryPreference | null
    if (!value || typeof value.query !== 'string' || typeof value.revision !== 'string') return null
    if (cleanDirectoryQuery(value.query) !== value.query) return null
    return value
  } catch {
    return null
  }
}

function browserDirectoryPreferenceLocks(): DirectoryPreferenceLocks | null {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as Navigator & { locks?: DirectoryPreferenceLocks }).locks
  return locks && typeof locks.request === 'function' ? locks : null
}

export async function saveDirectoryPreference(
  storage: Storage,
  query: string,
  expectedRevision: string | null,
  revision: string,
  locks: DirectoryPreferenceLocks | null = browserDirectoryPreferenceLocks(),
): Promise<DirectoryPreferenceSaveResult> {
  if (!locks) return { status: 'serialization-unavailable' }
  try {
    return await locks.request(VIEW_LOCK, { mode: 'exclusive' }, () => {
      const current = readDirectoryPreference(storage)
      if ((current?.revision ?? null) !== expectedRevision)
        return { status: 'conflict', preference: current }
      const preference = { query: cleanDirectoryQuery(query), revision }
      storage.setItem(VIEW_KEY, JSON.stringify(preference))
      return { status: 'saved', preference }
    })
  } catch {
    // Do not attempt an unprotected fallback write when locks or storage fail.
    return { status: 'serialization-unavailable' }
  }
}

export function isDirectoryPreferenceEvent(event: Pick<StorageEvent, 'key'>): boolean {
  return event.key === VIEW_KEY || event.key === null
}
