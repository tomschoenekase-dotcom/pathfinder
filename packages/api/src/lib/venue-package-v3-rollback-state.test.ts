import { describe, expect, it } from 'vitest'

import {
  parseVenuePackageContentVersionProvenance,
  venuePackageRollbackCasWhere,
  venuePackageRollbackMutationData,
} from './venue-package-v3-rollback-state'

const fail = (message: string): never => {
  throw new Error(message)
}

describe('venue package V3 rollback state', () => {
  it('allowlists mutable fields and converts provenance dates without copying scope fields', () => {
    const result = venuePackageRollbackMutationData('PLACE', {
      id: 'place-1',
      tenantId: 'other-tenant',
      venueId: 'other-venue',
      name: 'Restored',
      tags: ['gallery'],
      importedAt: '2026-08-11T12:00:00.000Z',
      unexpected: 'must-not-be-written',
    })

    expect(result).toEqual({
      name: 'Restored',
      tags: ['gallery'],
      importedAt: new Date('2026-08-11T12:00:00.000Z'),
    })
  })

  it('uses Prisma scalar-list equality in exact-state guards', () => {
    expect(
      venuePackageRollbackCasWhere('PLACE', { name: 'Current', tags: ['one', 'two'] }),
    ).toEqual({ name: 'Current', tags: { equals: ['one', 'two'] } })
  })

  it('accepts complete immutable provenance and rejects malformed history', () => {
    const valid = {
      sourceType: 'curated-notes',
      contentOrigin: 'HUMAN_AUTHORED',
      importedAt: '2026-08-11T10:00:00.000Z',
      humanConfirmedAt: '2026-08-11T11:00:00.000Z',
      lastReviewedAt: '2026-08-11T11:00:00.000Z',
    }
    expect(parseVenuePackageContentVersionProvenance(valid, fail)).toBe(valid)
    expect(() =>
      parseVenuePackageContentVersionProvenance({ ...valid, sourceUrl: 42 }, fail),
    ).toThrow('Package history provenance is invalid')
    expect(() => parseVenuePackageContentVersionProvenance([], fail)).toThrow(
      'Package history provenance is invalid',
    )
  })
})
