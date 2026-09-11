import { describe, expect, it } from 'vitest'

import {
  IntakeProposal,
  IntakeSource,
  WebsiteIntakeBounds,
  WebsiteSourceDiscovery,
} from './intake-engine'

describe('intake engine contracts', () => {
  it('keeps website intake bounded and draft-only', () => {
    const bounds = WebsiteIntakeBounds.parse({ allowedHosts: ['example.org'] })
    expect(bounds.maxPages).toBe(25)
    expect(bounds.respectRobots).toBe(true)
    expect(bounds.publishMode).toBe('DRAFT_ONLY')
    expect(WebsiteIntakeBounds.safeParse({ ...bounds, maxPages: 101 }).success).toBe(false)
  })

  it('never represents an intake proposal as auto-published', () => {
    expect(
      IntakeProposal.safeParse({
        runId: 'run-1',
        status: 'AWAITING_REVIEW',
        sourceIds: ['source-1'],
        autoPublish: true,
      }).success,
    ).toBe(false)
  })

  it('does not allow interview recording to be enabled without the owner policy decision', () => {
    expect(
      IntakeSource.safeParse({
        id: 'source-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        kind: 'INTERVIEW',
        displayName: 'Operations interview',
        capturedAt: '2026-08-11T19:00:00.000Z',
        consentToRecord: true,
      }).success,
    ).toBe(false)
  })

  it('retains only bounded, structured discovery inventory without page content', () => {
    const discovery = WebsiteSourceDiscovery.parse({
      policyVersion: 1,
      observedAt: '2026-09-08T14:00:00.000Z',
      omittedCount: 3,
      items: [
        {
          url: 'https://example.org/visitor-guide.pdf',
          parentUrl: 'https://example.org/',
          depth: 1,
          observedAt: '2026-09-08T14:00:00.000Z',
          disposition: 'UNSUPPORTED_DOCUMENT',
          contentType: 'application/pdf',
          byteSize: 120,
          exactByteHash: 'a'.repeat(64),
        },
      ],
    })
    expect(discovery.items[0]?.disposition).toBe('UNSUPPORTED_DOCUMENT')
    expect(
      WebsiteSourceDiscovery.safeParse({
        ...discovery,
        items: [{ ...discovery.items[0], content: 'raw page content' }],
      }).success,
    ).toBe(false)
  })

  it('rejects unsafe URLs and duplicate claims without matching received bytes', () => {
    const item = {
      url: 'https://example.org/about',
      parentUrl: null,
      depth: 0,
      observedAt: '2026-09-08T14:00:00.000Z',
      disposition: 'FETCHED_TEXT',
    }
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt: item.observedAt,
        omittedCount: 0,
        items: [{ ...item, url: 'ftp://example.org/about' }],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt: item.observedAt,
        omittedCount: 0,
        items: [{ ...item, duplicateOf: 'https://example.org/other' }],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt: item.observedAt,
        omittedCount: 0,
        items: [
          {
            ...item,
            url: 'https://example.org/about?access_token=private',
            byteSize: 1,
            exactByteHash: 'a'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt: item.observedAt,
        omittedCount: 0,
        items: [
          {
            ...item,
            url: 'http://example.org:443/about',
            byteSize: 1,
            exactByteHash: 'a'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt: item.observedAt,
        omittedCount: 0,
        items: [
          {
            ...item,
            url: 'https://[::ffff:7f00:1]/about',
            byteSize: 1,
            exactByteHash: 'a'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('requires unique discovery URLs and a prior received exact-byte match for duplicates', () => {
    const observedAt = '2026-09-08T14:00:00.000Z'
    const fetched = {
      url: 'https://example.org/about',
      parentUrl: null,
      depth: 0,
      observedAt,
      disposition: 'FETCHED_TEXT' as const,
      byteSize: 1,
      exactByteHash: 'a'.repeat(64),
    }
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt,
        omittedCount: 0,
        items: [fetched, { ...fetched }],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt,
        omittedCount: 0,
        items: [
          fetched,
          {
            ...fetched,
            url: 'https://example.org/about-copy',
            duplicateOf: fetched.url,
            exactByteHash: 'b'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      WebsiteSourceDiscovery.safeParse({
        policyVersion: 1,
        observedAt,
        omittedCount: 0,
        items: [
          {
            ...fetched,
            disposition: 'UNSUPPORTED_DOCUMENT',
          },
          {
            ...fetched,
            url: 'https://example.org/about-copy.pdf',
            disposition: 'UNSUPPORTED_DOCUMENT',
            duplicateOf: fetched.url,
          },
        ],
      }).success,
    ).toBe(true)
  })
})
