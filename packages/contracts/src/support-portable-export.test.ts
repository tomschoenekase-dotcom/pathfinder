import { describe, expect, it } from 'vitest'

import {
  canonicalSupportPortableExportJson,
  SupportPortableExportInput,
} from './support-portable-export'

describe('support portable export contract', () => {
  it('accepts exact sections and rejects duplicates or authority overrides', () => {
    expect(
      SupportPortableExportInput.parse({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        recipientUserId: 'user-a',
        sections: ['current-venue', 'recipient-support'],
      }).sections,
    ).toEqual(['current-venue', 'recipient-support'])
    expect(() =>
      SupportPortableExportInput.parse({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        recipientUserId: 'user-a',
        sections: ['current-venue', 'current-venue'],
      }),
    ).toThrow('Export sections must be unique')
    expect(() =>
      SupportPortableExportInput.parse({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        recipientUserId: 'user-a',
        sections: ['current-venue'],
        role: 'OWNER',
      }),
    ).toThrow()
  })

  it('canonicalizes object keys while retaining array order', () => {
    expect(canonicalSupportPortableExportJson({ z: 1, a: [{ b: 2, a: 1 }, 'x'] })).toBe(
      '{"a":[{"a":1,"b":2},"x"],"z":1}',
    )
    expect(() => canonicalSupportPortableExportJson({ unsafe: undefined })).toThrow(
      'non-JSON value',
    )
  })
})
