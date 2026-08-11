import { describe, expect, it, vi } from 'vitest'

import { WebsiteIntakeBounds } from '@pathfinder/contracts/intake-engine'

import {
  buildWebsiteIntakeProposal,
  isPublicWebsiteAddress,
  type WebsiteIntakeDependencies,
} from './website-intake'

const PUBLIC_ADDRESS = '93.184.216.34'
const NOW = new Date('2026-08-11T20:00:00.000Z')

function request(overrides: Partial<Parameters<typeof buildWebsiteIntakeProposal>[0]> = {}) {
  return {
    tenantId: 'tenant_1',
    venueId: 'clxvenue00000000000000001',
    sourceId: 'source_1',
    startUrl: 'https://example.org/',
    bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'] }),
    userAgent: 'PathFinderIntake/1.0',
    ...overrides,
  }
}

function dependencies(
  overrides: Partial<WebsiteIntakeDependencies> = {},
): WebsiteIntakeDependencies {
  return {
    resolveHostname: vi.fn(async () => [PUBLIC_ADDRESS]),
    robots: { canFetch: vi.fn(async () => true) },
    fetchPage: vi.fn(async () => ({ status: 200, headers: {}, body: '<html></html>' })),
    extractPage: vi.fn(async () => ({ links: [], facts: [] })),
    now: () => NOW,
    ...overrides,
  }
}

describe('website intake URL and network policy', () => {
  it('rejects credentialed URLs before DNS or fetch', async () => {
    const deps = dependencies()

    await expect(
      buildWebsiteIntakeProposal(request({ startUrl: 'https://user:secret@example.org/' }), deps),
    ).rejects.toThrow('Credentialed URLs')
    expect(deps.resolveHostname).not.toHaveBeenCalled()
    expect(deps.fetchPage).not.toHaveBeenCalled()
  })

  it('revalidates redirects and rejects a redirect to private address', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async () => ({
        status: 302,
        headers: { location: 'http://127.0.0.1/latest/meta-data' },
        body: '',
      })),
    })

    await expect(
      buildWebsiteIntakeProposal(
        request({
          bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['example.org', '127.0.0.1'] }),
        }),
        deps,
      ),
    ).rejects.toThrow('non-public address')
    expect(deps.fetchPage).toHaveBeenCalledOnce()
  })

  it('rejects private, mapped, link-local, metadata-range, and ambiguous IPv6 addresses', async () => {
    expect(isPublicWebsiteAddress('::1')).toBe(false)
    expect(isPublicWebsiteAddress('fc00::1')).toBe(false)
    expect(isPublicWebsiteAddress('fe80::1')).toBe(false)
    expect(isPublicWebsiteAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicWebsiteAddress('64:ff9b::7f00:1')).toBe(false)
    expect(isPublicWebsiteAddress('2606:4700:4700::1111')).toBe(true)

    const deps = dependencies({ resolveHostname: vi.fn(async () => ['::1']) })
    await expect(
      buildWebsiteIntakeProposal(
        request({
          startUrl: 'https://[::1]/',
          bounds: WebsiteIntakeBounds.parse({ allowedHosts: ['[::1]'] }),
        }),
        deps,
      ),
    ).rejects.toThrow('non-public address')
    expect(deps.fetchPage).not.toHaveBeenCalled()
  })

  it('rejects mixed public and private DNS results rather than selecting the public answer', async () => {
    const deps = dependencies({
      resolveHostname: vi.fn(async () => [PUBLIC_ADDRESS, '169.254.169.254']),
    })

    await expect(buildWebsiteIntakeProposal(request(), deps)).rejects.toThrow('non-public address')
    expect(deps.fetchPage).not.toHaveBeenCalled()
  })

  it('rejects cross-host redirects even when the destination resolves publicly', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async () => ({
        status: 301,
        headers: { location: 'https://other.example/path' },
        body: '',
      })),
    })

    await expect(buildWebsiteIntakeProposal(request(), deps)).rejects.toThrow('exact allowlist')
    expect(deps.resolveHostname).toHaveBeenCalledOnce()
  })

  it('rejects an oversized body even if an injected transport violates its byte contract', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async () => ({ status: 200, headers: {}, body: 'x'.repeat(11) })),
    })

    await expect(
      buildWebsiteIntakeProposal(
        request({
          bounds: WebsiteIntakeBounds.parse({
            allowedHosts: ['example.org'],
            maxBytesPerPage: 10,
          }),
        }),
        deps,
      ),
    ).rejects.toThrow('byte limit')
  })

  it('requires robots approval through the injected policy before every fetch', async () => {
    const deps = dependencies({ robots: { canFetch: vi.fn(async () => false) } })

    const result = await buildWebsiteIntakeProposal(request(), deps)

    expect(deps.robots.canFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.org/',
        userAgent: 'PathFinderIntake/1.0',
        resolvedAddresses: [PUBLIC_ADDRESS],
      }),
    )
    expect(deps.fetchPage).not.toHaveBeenCalled()
    expect(result.job.fetchedPages).toBe(0)
  })

  it('enforces the wall-clock budget even when an injected dependency returns late', async () => {
    let tick = 0
    const deps = dependencies({ now: () => new Date(NOW.getTime() + tick++ * 10) })

    await expect(buildWebsiteIntakeProposal(request({ maxDurationMs: 5 }), deps)).rejects.toThrow(
      'time limit',
    )
    expect(deps.fetchPage).not.toHaveBeenCalled()
  })
})

describe('website intake proposal foundation', () => {
  it('deduplicates canonical URLs and ignores links outside the exact host allowlist', async () => {
    const fetched: string[] = []
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) => {
        fetched.push(url)
        return { status: 200, headers: {}, body: url }
      }),
      extractPage: vi.fn(async ({ url }) =>
        url === 'https://example.org/'
          ? {
              links: [
                '/about?b=2&a=1#team',
                'https://example.org/about?a=1&b=2',
                'https://other.example/private',
              ],
              facts: [],
            }
          : { links: [], facts: [] },
      ),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)

    expect(fetched).toEqual(['https://example.org/', 'https://example.org/about?a=1&b=2'])
    expect(result.job.fetchedPages).toBe(2)
    expect(result.job.attemptedFetches).toBe(2)
  })

  it('enforces page and depth bounds', async () => {
    const deps = dependencies({
      extractPage: vi.fn(async ({ url }) => ({
        links: url.endsWith('/') ? ['/one', '/two'] : ['/deeper'],
        facts: [],
      })),
    })

    const result = await buildWebsiteIntakeProposal(
      request({
        bounds: WebsiteIntakeBounds.parse({
          allowedHosts: ['example.org'],
          maxPages: 2,
          maxDepth: 1,
        }),
      }),
      deps,
    )

    expect(result.job.fetchedPages).toBe(2)
    expect(result.intermediate.pages.map((page) => page.depth)).toEqual([0, 1])
  })

  it('creates deterministic evidence citations and date-sensitive contradictions', async () => {
    const deps = dependencies({
      extractPage: vi.fn(async () => ({
        links: [],
        facts: [
          {
            fieldPath: 'venue.openingHours.monday',
            value: '9am–5pm through August 31',
            confidence: 0.9,
            locator: 'summer-hours',
            dateSensitive: true,
            effectiveDate: '2026-08-31',
          },
          {
            fieldPath: 'venue.openingHours.monday',
            value: '10am–4pm from September 1',
            confidence: 0.85,
            locator: 'autumn-hours',
            dateSensitive: true,
            effectiveDate: '2026-09-01',
          },
        ],
      })),
    })

    const first = await buildWebsiteIntakeProposal(request(), deps)
    const second = await buildWebsiteIntakeProposal(request(), deps)

    expect(first.intermediate.evidence).toHaveLength(2)
    expect(first.intermediate.citations[0]?.sourceUrl).toBe('https://example.org/')
    expect(first.intermediate.discrepancies).toEqual([
      expect.objectContaining({
        fieldPath: 'venue.openingHours.monday',
        reason: 'DATE_SENSITIVE',
      }),
    ])
    expect(second.job).toEqual(first.job)
    expect(second.proposal.runId).toBe(first.proposal.runId)
  })

  it('returns only a draft-compatible proposal and never invokes apply or publish behavior', async () => {
    const mapToVenuePackage = vi.fn(async () => ({
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        {
          title: 'Visitor hours',
          category: 'Hours',
          content: 'Open daily.',
          isEnabled: true,
        },
      ],
    }))
    const deps = dependencies({ mapToVenuePackage })

    const result = await buildWebsiteIntakeProposal(request(), deps)

    expect(mapToVenuePackage).toHaveBeenCalledOnce()
    expect(result.packageBinding.kind).toBe('VENUE_PACKAGE_DRAFT')
    expect(result.packageBinding.draftInput).toEqual(
      expect.objectContaining({ venueId: 'clxvenue00000000000000001' }),
    )
    expect(result.proposal.autoPublish).toBe(false)
    expect(result.execution).toEqual({
      autoPublish: false,
      autoApply: false,
      lifecycleCommands: [],
    })
    expect(result.nextAction).toBe('CREATE_DRAFT_FOR_REVIEW')
  })

  it('returns a typed intermediate when no safe package mapper is provided', async () => {
    const result = await buildWebsiteIntakeProposal(request(), dependencies())

    expect(result.packageBinding).toEqual({ kind: 'TYPED_INTERMEDIATE', draftInput: null })
    expect(result.proposal.packageDraftId).toBeUndefined()
  })
})
