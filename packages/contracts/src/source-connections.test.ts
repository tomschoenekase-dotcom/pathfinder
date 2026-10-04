import { describe, expect, it } from 'vitest'

import { SourceConnectionConfigSchema, isApprovedSourceUrl } from './source-connections'
import { sourceConnectionConfigHash, sourceConnectionSnapshotHash } from './source-connections-node'

const sourceUrl = 'https://venue.example.com/program'
const raw = {
  version: 1,
  sourceUrl,
  allowedUrls: [sourceUrl, 'https://venue.example.com/menu'],
  timezone: 'America/Chicago',
  refreshIntervalSeconds: 900,
  freshnessSeconds: 3600,
  validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'review_required',
  mappings: [
    {
      type: 'html',
      kind: 'showtime',
      recordSelector: 'article.show',
      id: { selector: 'span.id' },
      title: { selector: 'h2.title' },
      text: { selector: 'p.detail' },
      pageDate: { selector: 'h1.date' },
      startDate: { selector: 'span.day' },
      showtime: { selector: 'time.start' },
      showtimeEnd: { selector: 'time.end' },
      dateFormat: 'english_month_day',
    },
  ],
} as const

describe('source connection approval boundary', () => {
  it('requires canonical exact HTTPS URLs and refuses an unapproved path', () => {
    const config = SourceConnectionConfigSchema.parse(raw)
    expect(isApprovedSourceUrl(config, sourceUrl)).toBe(true)
    expect(isApprovedSourceUrl(config, 'https://venue.example.com/program?next=1')).toBe(false)
    expect(isApprovedSourceUrl(config, 'https://venue.example.com/other')).toBe(false)
    expect(isApprovedSourceUrl(config, 'http://venue.example.com/program')).toBe(false)
    expect(
      SourceConnectionConfigSchema.safeParse({
        ...raw,
        allowedUrls: [sourceUrl, 'http://venue.example.com/menu'],
      }).success,
    ).toBe(false)
  })

  it('caps dated freshness and requires an explicit year anchor for yearless dates', () => {
    expect(
      SourceConnectionConfigSchema.safeParse({ ...raw, freshnessSeconds: 86_401 }).success,
    ).toBe(false)
    expect(
      SourceConnectionConfigSchema.safeParse({
        ...raw,
        mappings: [{ ...raw.mappings[0], pageDate: undefined }],
      }).success,
    ).toBe(false)
    expect(
      SourceConnectionConfigSchema.safeParse({ ...raw, mappings: Array(9).fill(raw.mappings[0]) })
        .success,
    ).toBe(false)
  })

  it('refuses fragments, aliased encoded paths, internal addresses and invalid season boundaries', () => {
    for (const url of [
      `${sourceUrl}#fragment`,
      'https://venue.example.com/a%2fb',
      'https://venue.example.com/a%5Cb',
      'https://venue.example.com/a%252fb',
      'https://venue.example.com/a%00b',
      'https://venue.example.com./program',
      'https://127.0.0.1/program',
      'https://venue.local/program',
      'https://venue.example.com/program?api_token=private',
    ]) {
      expect(
        SourceConnectionConfigSchema.safeParse({ ...raw, sourceUrl: url, allowedUrls: [url] })
          .success,
        url,
      ).toBe(false)
    }
    expect(
      SourceConnectionConfigSchema.safeParse({
        ...raw,
        mappings: [{ ...raw.mappings[0], fixedEndDate: '2026-02-30' }],
      }).success,
    ).toBe(false)
  })

  it('invalidates approval on config changes while ignoring the approval receipt itself', () => {
    const config = SourceConnectionConfigSchema.parse(raw)
    const hash = sourceConnectionConfigHash(config)
    const approved = SourceConnectionConfigSchema.parse({
      ...config,
      approval: {
        approvedConfigHash: hash,
        approvedPreviewHash: 'a'.repeat(64),
        approvedAt: '2026-10-03T12:00:00.000Z',
        approvedBy: 'operator-1',
      },
    })
    expect(sourceConnectionConfigHash(approved)).toBe(hash)
    expect(sourceConnectionConfigHash({ ...approved, allowedUrls: [sourceUrl] })).not.toBe(hash)
    expect(sourceConnectionSnapshotHash([{ id: 'a', text: 'one' }])).toBe(
      sourceConnectionSnapshotHash([{ text: 'one', id: 'a' }]),
    )
  })
})
