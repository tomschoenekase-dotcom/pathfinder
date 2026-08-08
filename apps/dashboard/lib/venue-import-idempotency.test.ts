import { describe, expect, it } from 'vitest'

import {
  clearVenueContentImportAttempt,
  getOrCreateVenueContentImportAttempt,
} from './venue-import-idempotency'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

const payload = {
  venueId: 'cvenueabc123456789012',
  places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0 }],
  knowledgeEntries: [{ title: 'Policy', category: 'FAQ', content: 'Details', isEnabled: true }],
}

describe('venue import attempt identity', () => {
  it('reuses one opaque key for the same canonical payload without storing content', async () => {
    const storage = memoryStorage()
    const first = await getOrCreateVenueContentImportAttempt(payload, storage)
    const replay = await getOrCreateVenueContentImportAttempt(payload, storage)

    expect(replay).toEqual(first)
    const persisted = [...storage.values.values()].join('')
    expect(persisted).not.toContain('Lobby')
    expect(persisted).not.toContain('Details')
  })

  it('uses a new key when validated content or array order changes', async () => {
    const storage = memoryStorage()
    const first = await getOrCreateVenueContentImportAttempt(payload, storage)
    const changed = await getOrCreateVenueContentImportAttempt(
      { ...payload, places: [{ ...payload.places[0]!, name: 'Atrium' }] },
      storage,
    )

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('clears only the matching completed attempt', async () => {
    const storage = memoryStorage()
    const first = await getOrCreateVenueContentImportAttempt(payload, storage)
    clearVenueContentImportAttempt(
      payload.venueId,
      { ...first, idempotencyKey: crypto.randomUUID() },
      storage,
    )
    expect(storage.values.size).toBe(1)

    clearVenueContentImportAttempt(payload.venueId, first, storage)
    expect(storage.values.size).toBe(0)
  })
})
