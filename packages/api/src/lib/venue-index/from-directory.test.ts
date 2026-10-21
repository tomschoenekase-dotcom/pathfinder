import { describe, expect, it } from 'vitest'

import { venueRecordsFromDirectory } from './from-directory'
import { VenueIndex } from './venue-index'

describe('directory index source identity', () => {
  it('keeps place and knowledge rows with the same database ID distinct through updates', () => {
    const records = venueRecordsFromDirectory({
      places: [{ id: 'shared', name: 'Moon Cafe', longDescription: 'Sells: Tea' }],
      knowledge: [{ id: 'shared', title: 'Tea policy', content: 'Tea contains caffeine.' }],
    })
    const index = VenueIndex.build('Example Park', records)
    expect([...index.records.keys()].sort()).toEqual(['knowledge:shared', 'place:shared'])
    expect(index.records.get('place:shared')?.body).toBe('Sells: Tea')
    expect(index.records.get('knowledge:shared')?.body).toBe('Tea contains caffeine.')
    index.upsert({ ...records[0]!, body: 'Sells: Water' })
    expect(index.records.get('place:shared')?.body).toBe('Sells: Water')
    expect(index.records.get('knowledge:shared')?.body).toBe('Tea contains caffeine.')
    index.withdraw('place:shared')
    expect(index.records.has('place:shared')).toBe(false)
    expect(index.records.get('knowledge:shared')?.body).toBe('Tea contains caffeine.')
  })
})
