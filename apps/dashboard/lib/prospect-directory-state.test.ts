import { describe, expect, it } from 'vitest'

import {
  cleanDirectoryQuery,
  type DirectoryPreferenceLocks,
  readDirectoryNavigation,
  readDirectoryPreference,
  recordDirectoryNavigation,
  saveDirectoryPreference,
} from './prospect-directory-state'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function exclusiveLocks(): DirectoryPreferenceLocks {
  let tail = Promise.resolve()
  return {
    request: (_name, _options, callback) => {
      const next = tail.then(callback)
      tail = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    },
  }
}

describe('prospect directory browser state', () => {
  it('retains only bounded filter keys and tab-local loaded IDs', () => {
    const tab = storage()
    const query = cleanDirectoryQuery(
      'search=Harbor&outreachState=DRAFTED&privateBody=do-not-store',
    )
    recordDirectoryNavigation(tab, {
      base: '/admin/prospects',
      query,
      ids: ['one', 'two'],
      scrollY: 350,
    })
    expect(readDirectoryNavigation(tab, '/admin/prospects', query)).toEqual({
      base: '/admin/prospects',
      query: 'search=Harbor&outreachState=DRAFTED',
      ids: ['one', 'two'],
      scrollY: 350,
    })
    expect(readDirectoryNavigation(tab, '/admin/prospects', 'search=Other')).toBeNull()
    expect(readDirectoryNavigation(storage(), '/admin/prospects', query)).toBeNull()
  })

  it('serializes simultaneous tabs so a stale check cannot overwrite a newer preference', async () => {
    const shared = storage()
    const locks = exclusiveLocks()
    const firstTab = saveDirectoryPreference(shared, 'stage=RESEARCHED', null, 'a', locks)
    const secondTab = saveDirectoryPreference(shared, 'stage=CONTACTED', null, 'b', locks)

    await expect(firstTab).resolves.toEqual({
      status: 'saved',
      preference: { query: 'stage=RESEARCHED', revision: 'a' },
    })
    await expect(secondTab).resolves.toEqual({
      status: 'conflict',
      preference: { query: 'stage=RESEARCHED', revision: 'a' },
    })
    expect(readDirectoryPreference(shared)).toEqual({ query: 'stage=RESEARCHED', revision: 'a' })
  })

  it('does not claim an atomic write or mutate storage when Web Locks are unavailable', async () => {
    const shared = storage()
    await expect(
      saveDirectoryPreference(shared, 'stage=RESEARCHED', null, 'a', null),
    ).resolves.toEqual({ status: 'serialization-unavailable' })
    expect(readDirectoryPreference(shared)).toBeNull()
  })
})
