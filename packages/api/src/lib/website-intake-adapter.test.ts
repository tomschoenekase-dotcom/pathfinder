import { describe, expect, it, vi } from 'vitest'

import { WebsiteIntakeBounds } from '@pathfinder/contracts/intake-engine'

import { createWebsiteIntakeSourceAdapter } from './website-intake-adapter'

describe('website intake orchestration adapter', () => {
  it('translates injected website extraction into the shared adapter contract', async () => {
    const fetchPage = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: '<p>Open daily</p>',
    }))
    const adapter = createWebsiteIntakeSourceAdapter({
      bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'], maxPages: 1 }),
      userAgent: 'PathFinderIntake/1.0',
      dependencies: () => ({
        resolveHostname: vi.fn(async () => ['93.184.216.34']),
        robots: { canFetch: vi.fn(async () => true) },
        fetchPage,
        extractPage: vi.fn(async () => ({
          links: [],
          facts: [
            {
              fieldPath: 'venue.hours',
              value: 'Open daily',
              confidence: 0.9,
              dateSensitive: false,
            },
          ],
        })),
        now: () => new Date('2026-08-11T20:00:00.000Z'),
      }),
    })

    const result = await adapter.extract(
      {
        id: 'source_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        kind: 'WEBSITE',
        displayName: 'Venue website',
        uri: 'https://example.org/',
        capturedAt: '2026-08-11T20:00:00.000Z',
      },
      { signal: undefined, remainingCostUnits: 10, remainingTimeMs: 1_000 },
    )

    expect(result).toEqual(
      expect.objectContaining({
        status: 'EXTRACTED',
        sourceId: 'source_1',
        costUnits: 2,
        candidate: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
      }),
    )
    expect(result.claims).toEqual([
      expect.objectContaining({
        fieldPath: 'venue.hours',
        value: 'Open daily',
        evidenceId: expect.stringMatching(/^evidence_/u),
      }),
    ])
    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ redirectMode: 'MANUAL', maxBytes: 2_000_000 }),
    )
  })
})
