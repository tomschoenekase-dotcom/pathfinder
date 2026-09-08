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
    ).rejects.toThrow(/private|non-public/iu)
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
    ).rejects.toThrow(/private|non-public/iu)
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
    expect(result.intermediate.discovery?.items).toEqual([
      expect.objectContaining({
        url: 'https://example.org/',
        parentUrl: null,
        depth: 0,
        disposition: 'ROBOTS_DENIED',
      }),
    ])
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
  it('retains known binary references without fetching them or starving useful text pages', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: url,
      })),
      extractPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? {
              links: ['/guide.pdf', '/tour.mp4', '/map.jpg', '/visit'],
              facts: [],
            }
          : { links: [], facts: [] },
      ),
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

    expect(deps.fetchPage).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.fetchPage).mock.calls.map(([input]) => input.url)).toEqual([
      'https://example.org/',
      'https://example.org/visit',
    ])
    expect(result.intermediate.discovery?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: 'https://example.org/guide.pdf',
          disposition: 'UNSUPPORTED_DOCUMENT',
          parentUrl: 'https://example.org/',
        }),
        expect.objectContaining({ disposition: 'UNSUPPORTED_VIDEO' }),
        expect.objectContaining({ disposition: 'UNSUPPORTED_IMAGE' }),
      ]),
    )
  })

  it('meters and retains unknown non-text responses while continuing independent text pages', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) =>
        url.endsWith('/download')
          ? {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
              body: new Uint8Array([1, 2, 3]),
            }
          : { status: 200, headers: { 'content-type': 'text/html' }, body: url },
      ),
      extractPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? { links: ['/download', '/visit'], facts: [] }
          : { links: [], facts: [] },
      ),
    })

    const result = await buildWebsiteIntakeProposal(
      request({
        bounds: WebsiteIntakeBounds.parse({
          allowedHosts: ['example.org'],
          maxPages: 3,
          maxDepth: 1,
        }),
      }),
      deps,
    )

    expect(deps.extractPage).toHaveBeenCalledTimes(2)
    expect(result.job).toMatchObject({ attemptedFetches: 3, fetchedPages: 2 })
    expect(result.intermediate.discovery?.items).toContainEqual(
      expect.objectContaining({
        url: 'https://example.org/download',
        disposition: 'UNSUPPORTED_DOCUMENT',
        contentType: 'application/pdf',
        byteSize: 3,
        exactByteHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    )
  })

  it('groups only exact received-byte duplicates and never labels them as corroboration', async () => {
    const binary = new Uint8Array([9, 8, 7])
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? {
              status: 200,
              headers: { 'content-type': 'text/html' },
              body: '<a href="/asset-a"><a href="/asset-b">',
            }
          : {
              status: 200,
              headers: { 'content-type': 'application/octet-stream' },
              body: binary,
            },
      ),
      extractPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? { links: ['/asset-a', '/asset-b'], facts: [] }
          : { links: [], facts: [] },
      ),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)
    const assetB = result.intermediate.discovery?.items.find((item) =>
      item.url.endsWith('/asset-b'),
    )

    expect(assetB).toMatchObject({
      disposition: 'UNSUPPORTED_OTHER',
      duplicateOf: 'https://example.org/asset-a',
    })
    expect(JSON.stringify(result.intermediate.discovery)).not.toMatch(
      /corroborat|official|verified/iu,
    )
  })

  it('never inventories unsafe references even when their extensions are known', async () => {
    const deps = dependencies({
      extractPage: vi.fn(async () => ({
        links: [
          'http://127.0.0.1/private.pdf',
          'https://example.org/private.pdf?token=secret',
          'https://other.example/video.mp4',
          '/safe-guide.pdf',
        ],
        facts: [],
      })),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)
    const serialized = JSON.stringify(result.intermediate.discovery)

    expect(serialized).toContain('https://example.org/safe-guide.pdf')
    expect(serialized).not.toMatch(/127\.0\.0\.1|secret|other\.example/u)
  })

  it('isolates overlong URL and MIME metadata while retaining a useful sibling page', async () => {
    const overlongDocument = `/${'x'.repeat(2_100)}.pdf`
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) =>
        url.endsWith('/asset')
          ? {
              status: 200,
              headers: { 'content-type': `application/${'x'.repeat(300)}` },
              body: new Uint8Array([1]),
            }
          : { status: 200, headers: { 'content-type': 'text/html' }, body: url },
      ),
      extractPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? { links: [overlongDocument, '/asset', '/visit'], facts: [] }
          : { links: [], facts: [] },
      ),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)

    expect(deps.fetchPage).toHaveBeenCalledTimes(3)
    expect(result.intermediate.pages.map((page) => page.url)).toEqual([
      'https://example.org/',
      'https://example.org/visit',
    ])
    expect(JSON.stringify(result.intermediate.discovery)).not.toContain('x'.repeat(2_100))
    expect(result.intermediate.discovery?.items).toContainEqual(
      expect.objectContaining({
        url: 'https://example.org/asset',
        disposition: 'UNSUPPORTED_OTHER',
      }),
    )
    expect(
      result.intermediate.discovery?.items.find((item) => item.url.endsWith('/asset')),
    ).not.toHaveProperty('contentType')
  })

  it('caps admitted references globally and reports omissions at the page budget', async () => {
    const deps = dependencies({
      extractPage: vi.fn(async ({ url }) => ({
        links: Array.from({ length: 500 }, (_item, index) =>
          url.endsWith('/') ? `/first-${index}` : `/nested-${index}`,
        ),
        facts: [],
      })),
    })

    const result = await buildWebsiteIntakeProposal(
      request({
        bounds: WebsiteIntakeBounds.parse({
          allowedHosts: ['example.org'],
          maxPages: 2,
          maxDepth: 2,
        }),
      }),
      deps,
    )

    expect(deps.fetchPage).toHaveBeenCalledTimes(2)
    expect(result.intermediate.discovery?.items).toHaveLength(1_000)
    expect(result.intermediate.discovery?.omittedCount).toBe(1)
    expect(
      result.intermediate.discovery?.items.filter((item) => item.disposition === 'PAGE_LIMIT'),
    ).toHaveLength(998)
  })

  it('applies the global reference cap to redirect targets', async () => {
    const rootLinks = Array.from({ length: 499 }, (_item, index) => `/root-${index}.pdf`)
    const childLinks = Array.from({ length: 498 }, (_item, index) => `/child-${index}.pdf`)
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) =>
        url.endsWith('/alias')
          ? { status: 302, headers: { location: '/redirected' }, body: '' }
          : { status: 200, headers: { 'content-type': 'text/html' }, body: url },
      ),
      extractPage: vi.fn(async ({ url }) => {
        if (url.endsWith('/')) return { links: [...rootLinks, '/page-2'], facts: [] }
        if (url.endsWith('/page-2')) return { links: [...childLinks, '/alias'], facts: [] }
        return { links: [], facts: [] }
      }),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)

    expect(deps.fetchPage).toHaveBeenCalledTimes(3)
    expect(result.intermediate.discovery?.items).toHaveLength(999)
    expect(result.intermediate.discovery?.omittedCount).toBe(1)
    expect(JSON.stringify(result.intermediate.discovery)).not.toContain('/redirected')
  })

  it('records a shared redirect target once with redirect provenance', async () => {
    const deps = dependencies({
      fetchPage: vi.fn(async ({ url }) => {
        if (url.endsWith('/alias-a') || url.endsWith('/alias-b')) {
          return { status: 302, headers: { location: '/final' }, body: '' }
        }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: url }
      }),
      extractPage: vi.fn(async ({ url }) =>
        url.endsWith('/')
          ? { links: ['/alias-a', '/alias-b'], facts: [] }
          : { links: [], facts: [] },
      ),
    })

    const result = await buildWebsiteIntakeProposal(request(), deps)
    const finalItems = result.intermediate.discovery?.items.filter(
      (item) => item.url === 'https://example.org/final',
    )

    expect(finalItems).toEqual([
      expect.objectContaining({
        parentUrl: 'https://example.org/alias-a',
        disposition: 'FETCHED_TEXT',
      }),
    ])
    expect(deps.fetchPage).toHaveBeenCalledTimes(4)
  })

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
    expect(result.intermediate.discovery?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://example.org/two', disposition: 'PAGE_LIMIT' }),
        expect.objectContaining({ url: 'https://example.org/deeper', disposition: 'DEPTH_LIMIT' }),
      ]),
    )
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
