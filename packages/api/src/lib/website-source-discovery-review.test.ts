import { describe, expect, it } from 'vitest'

import { projectWebsiteSourceDiscovery } from './website-source-discovery-review'

const observedAt = '2026-09-08T08:00:00.000Z'
const inventory = {
  policyVersion: 1,
  observedAt,
  omittedCount: 0,
  items: [
    {
      url: 'https://example.com/visitor-guide.pdf',
      parentUrl: null,
      depth: 0,
      observedAt,
      disposition: 'UNSUPPORTED_DOCUMENT',
    },
  ],
}
const project = (discoverySnapshot: unknown) =>
  projectWebsiteSourceDiscovery({
    receiptId: 'receipt-a',
    websiteUri: 'https://example.com/',
    discoverySnapshot,
  })

describe('website discovery review projection', () => {
  it('retains submitted-host discovery without inventing extracted facts or authority', () => {
    expect(project(inventory)).toEqual({
      receiptId: 'receipt-a',
      status: 'RECORDED',
      sourceHost: 'example.com',
      inventory,
    })
  })

  it('distinguishes a legacy missing inventory from malformed evidence', () => {
    expect(project(null)).toMatchObject({ status: 'NOT_RECORDED', inventory: null })
    expect(project({ ...inventory, privateNotes: 'not for projection' })).toMatchObject({
      status: 'INVALID',
      inventory: null,
    })
  })

  it.each(['url', 'parentUrl', 'duplicateOf'])(
    'rejects an out-of-scope %s instead of exposing it',
    (field) => {
      expect(
        project({
          ...inventory,
          items: [{ ...inventory.items[0], [field]: 'https://other.example/private' }],
        }),
      ).toMatchObject({ status: 'INVALID', inventory: null, sourceHost: null })
    },
  )

  it.each([
    'javascript:alert(1)',
    'https://user:secret@example.com/file.pdf',
    'https://example.com/file.pdf?token=secret',
    'https://example.com:4433/file.pdf',
  ])('withholds unsafe retained URLs: %s', (url) => {
    expect(project({ ...inventory, items: [{ ...inventory.items[0], url }] })).toMatchObject({
      status: 'INVALID',
      inventory: null,
    })
  })
})
