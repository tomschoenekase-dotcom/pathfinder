import { describe, expect, it } from 'vitest'

import { SourceConnectionConfigSchema } from '@pathfinder/contracts/source-connections'

import { extractSourceConnection } from './source-connection-extract'

const sourceUrl = 'https://venue.example.com/program'

const htmlConfig = SourceConnectionConfigSchema.parse({
  version: 1,
  sourceUrl,
  allowedUrls: [sourceUrl, 'https://venue.example.com/menu'],
  timezone: 'America/Chicago',
  refreshIntervalSeconds: 900,
  freshnessSeconds: 3600,
  validation: { minRecords: 2, maxRecords: 8, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
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
      allowCrossMidnight: true,
    },
    {
      type: 'html',
      kind: 'closure',
      recordSelector: 'article.closed',
      id: { selector: 'span.id' },
      title: { selector: 'h2.title' },
      text: { selector: 'p.detail' },
      pageDate: { selector: 'h1.date' },
      startDate: { selector: 'span.day' },
      dateFormat: 'english_month_day',
    },
  ],
})

const html = `<html><body><h1 class="date">October 3, 2026</h1>
<article class="show"><span class="id">show-1</span><h2 class="title">Evening program</h2><p class="detail">Starts late</p><span class="day">October 3</span><time class="start">11:30 PM</time><time class="end">12:30 AM</time></article>
<article class="show"><span class="id">show-1</span><h2 class="title">Evening program</h2><p class="detail">Starts late</p><span class="day">October 3</span><time class="start">11:30 PM</time><time class="end">12:30 AM</time></article>
<article class="closed"><span class="id">closure-1</span><h2 class="title">Daily closure</h2><p class="detail">Unavailable today</p><span class="day">October 3</span></article>
</body></html>`

describe('deterministic source extraction', () => {
  it('extracts mixed kinds once, deduplicates responsive rows, and preserves cross-midnight intervals', () => {
    const result = extractSourceConnection(htmlConfig, html, 'text/html; charset=utf-8')
    expect(result.status).toBe('VALID')
    if (result.status !== 'VALID') return
    expect(result.records).toHaveLength(2)
    expect(result.records.map((record) => record.kind)).toEqual(['closure', 'showtime'])
    expect(result.records[1]?.showtimes).toEqual([
      {
        startAt: '2026-10-04T04:30:00.000Z',
        endAt: '2026-10-04T05:30:00.000Z',
      },
    ])
    expect(result.records[0]?.effectiveFrom).toBe('2026-10-03T05:00:00.000Z')
    expect(result.records[1]?.effectiveUntil).toBe('2026-10-04T05:30:00.000Z')
  })

  it('holds changed duplicate content, missing dates and unapproved links', () => {
    const duplicateConflict = html.replace(
      'Starts late</p><span class="day">October 3</span><time class="start">11:30 PM</time><time class="end">12:30 AM</time></article>\n<article class="closed">',
      'Different</p><span class="day">October 3</span><time class="start">11:30 PM</time><time class="end">12:30 AM</time></article>\n<article class="closed">',
    )
    expect(extractSourceConnection(htmlConfig, duplicateConflict, 'text/html')).toMatchObject({
      status: 'REVIEW_REQUIRED',
      issues: ['DUPLICATE_RECORD_CONFLICT'],
    })
    expect(
      extractSourceConnection(
        htmlConfig,
        html.replaceAll('<span class="day">October 3</span>', ''),
        'text/html',
      ).status,
    ).toBe('REVIEW_REQUIRED')
    const withLink = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      mappings: [
        {
          type: 'html',
          kind: 'description',
          recordSelector: 'article.show',
          id: { selector: 'span.id' },
          title: { selector: 'h2.title' },
          text: { selector: 'p.detail' },
          link: { selector: 'a.link', attribute: 'href' },
          dateFormat: 'iso',
        },
      ],
      validation: { ...htmlConfig.validation, minRecords: 1 },
    })
    const badLink = html.replace(
      '<p class="detail">Starts late</p>',
      '<p class="detail">Starts late</p><a class="link" href="https://other.example.com/">Menu</a>',
    )
    expect(extractSourceConnection(withLink, badLink, 'text/html')).toMatchObject({
      status: 'REVIEW_REQUIRED',
      issues: ['LINK_NOT_APPROVED'],
    })
  })

  it('rejects ambiguous DST wall time and a structure with no mapped rows', () => {
    const fall = html
      .replaceAll('October 3, 2026', 'November 1, 2026')
      .replaceAll('October 3', 'November 1')
      .replaceAll('11:30 PM', '1:30 AM')
      .replaceAll('12:30 AM', '2:30 AM')
    expect(extractSourceConnection(htmlConfig, fall, 'text/html')).toMatchObject({
      status: 'REVIEW_REQUIRED',
      issues: ['DST_AMBIGUOUS'],
    })
    expect(
      extractSourceConnection(
        htmlConfig,
        '<html><body><p>Nothing mapped</p></body></html>',
        'text/html',
      ),
    ).toMatchObject({ status: 'REVIEW_REQUIRED', issues: ['RECORD_STRUCTURE_DRIFT'] })
  })

  it('extracts a configured JSON feed and refuses date-less operations', () => {
    const config = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      mappings: [
        {
          type: 'json_feed',
          kind: 'event',
          itemsPointer: '/items',
          idPointer: '/id',
          titlePointer: '/title',
          textPointer: '/text',
          startDatePointer: '/date',
          showtimesPointer: '/showtimes',
          linksPointer: '/links',
          dateFormat: 'iso',
        },
      ],
      validation: { ...htmlConfig.validation, minRecords: 1 },
    })
    const payload = {
      items: [
        {
          id: 'event-1',
          title: 'Program',
          text: 'One event',
          date: '2026-10-03',
          showtimes: [{ startAt: '2026-10-03T14:00:00-05:00', endAt: '2026-10-03T15:00:00-05:00' }],
          links: ['/menu'],
        },
      ],
    }
    expect(
      extractSourceConnection(config, JSON.stringify(payload), 'application/feed+json'),
    ).toMatchObject({ status: 'VALID' })
    expect(
      extractSourceConnection(
        config,
        JSON.stringify({
          items: [
            {
              ...payload.items[0],
              showtimes: [{ startAt: '2026-10-03T19:00:00Z', endAt: '2026-10-03T20:00:00Z' }],
            },
          ],
        }),
        'application/feed+json',
      ),
    ).toMatchObject({ status: 'VALID' })
    expect(
      extractSourceConnection(
        config,
        JSON.stringify({ items: [{ ...payload.items[0], date: undefined, showtimes: undefined }] }),
        'application/feed+json',
      ),
    ).toMatchObject({ status: 'REVIEW_REQUIRED', issues: ['DATE_REQUIRED'] })
  })

  it('holds spring DST gaps, year-boundary ambiguity, invalid ordinals and insufficient unique records', () => {
    const spring = html
      .replaceAll('October 3, 2026', 'March 8, 2026')
      .replaceAll('October 3', 'March 8')
      .replaceAll('11:30 PM', '2:30 AM')
      .replaceAll('12:30 AM', '3:30 AM')
    expect(extractSourceConnection(htmlConfig, spring, 'text/html')).toMatchObject({
      issues: ['DST_GAP'],
    })
    const ordinal = html.replaceAll('October 3</span>', 'October 3rd</span>')
    expect(extractSourceConnection(htmlConfig, ordinal, 'text/html').status).toBe('VALID')
    expect(
      extractSourceConnection(htmlConfig, ordinal.replaceAll('3rd', '3th'), 'text/html'),
    ).toMatchObject({ issues: ['DATE_INVALID'] })
    const config = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      validation: { ...htmlConfig.validation, minRecords: 3 },
    })
    expect(extractSourceConnection(config, html, 'text/html')).toMatchObject({
      issues: ['RECORD_COUNT_DRIFT'],
    })
    const season = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      mappings: [
        {
          type: 'html',
          kind: 'closure',
          recordSelector: 'article.closed',
          id: { selector: 'span.id' },
          title: { selector: 'h2.title' },
          text: { selector: 'p.detail' },
          startDate: { selector: 'span.day' },
          endDate: { selector: 'span.until' },
          pageDate: { selector: 'h1.date' },
          dateFormat: 'english_month_day',
        },
      ],
      validation: { ...htmlConfig.validation, minRecords: 1 },
    })
    const newYear = html
      .replaceAll('October 3, 2026', 'December 30, 2026')
      .replaceAll('October 3', 'December 30')
      .replace('Unavailable today</p>', 'Unavailable today</p><span class="until">January 2</span>')
    expect(extractSourceConnection(season, newYear, 'text/html')).toMatchObject({
      issues: ['DATE_ORDER_INVALID'],
    })
  })

  it('normalizes future ranges, explicit season ends, cancellation and exceptions; rejects malformed status', () => {
    const config = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      mappings: [
        {
          type: 'json_feed',
          kind: 'closure',
          itemsPointer: '/items',
          idPointer: '/id',
          titlePointer: '/title',
          textPointer: '/text',
          startDatePointer: '/date',
          cancelledPointer: '/cancelled',
          exceptionsPointer: '/exceptions',
          dateFormat: 'iso',
          fixedEndDate: '2027-01-02',
        },
      ],
      validation: { ...htmlConfig.validation, minRecords: 1 },
    })
    const row = {
      id: 'season-1',
      title: 'Future closure',
      text: 'Closed for the specified season',
      date: '2026-12-30',
      cancelled: false,
      exceptions: ['2027-01-01'],
    }
    const extract = (item: unknown) =>
      extractSourceConnection(config, JSON.stringify({ items: [item] }), 'application/json')
    expect(extract(row)).toMatchObject({
      status: 'VALID',
      records: [
        {
          startDate: '2026-12-30',
          endDate: '2027-01-02',
          effectiveUntil: '2027-01-03T06:00:00.000Z',
          cancelled: false,
          exceptions: ['2027-01-01'],
        },
      ],
    })
    expect(extract({ ...row, cancelled: 'cancelled' })).toMatchObject({
      status: 'VALID',
      records: [{ cancelled: true }],
    })
    expect(extract({ ...row, cancelled: 'unknown' })).toMatchObject({
      issues: ['CANCELLATION_INVALID'],
    })
    expect(extract({ ...row, cancelled: undefined })).toMatchObject({
      issues: ['MAPPED_FIELD_MISSING'],
    })
    expect(extract({ ...row, exceptions: ['2027-01-03'] })).toMatchObject({
      issues: ['EXCEPTION_DATE_MISMATCH'],
    })
  })

  it('derives absolute-only intervals and refuses invalid dates, inconsistent date scopes and inherited fields', () => {
    const config = SourceConnectionConfigSchema.parse({
      ...htmlConfig,
      mappings: [
        {
          type: 'json_feed',
          kind: 'showtime',
          itemsPointer: '/items',
          idPointer: '/id',
          titlePointer: '/title',
          textPointer: '/text',
          startDatePointer: '/date',
          showtimesPointer: '/showtimes',
          dateFormat: 'iso',
        },
      ],
      validation: { ...htmlConfig.validation, minRecords: 1 },
    })
    const row = {
      id: 'show-1',
      title: 'Program',
      text: 'One interval',
      showtimes: [{ startAt: '2026-10-03T19:00:00Z', endAt: '2026-10-03T20:00:00Z' }],
    }
    const extract = (item: unknown) =>
      extractSourceConnection(config, JSON.stringify({ items: [item] }), 'application/json')
    expect(extract(row)).toMatchObject({
      status: 'VALID',
      records: [
        { effectiveFrom: '2026-10-03T19:00:00.000Z', effectiveUntil: '2026-10-03T20:00:00.000Z' },
      ],
    })
    expect(extract({ ...row, date: '2026-10-04' })).toMatchObject({
      issues: ['SHOWTIME_DATE_MISMATCH'],
    })
    expect(
      extract({
        ...row,
        showtimes: [{ startAt: '2026-02-30T19:00:00Z', endAt: '2026-02-30T20:00:00Z' }],
      }),
    ).toMatchObject({ issues: ['DATE_INVALID'] })
    expect(extract({ ...row, date: '2026-10-03', showtimes: [] })).toMatchObject({
      issues: ['SHOWTIME_REQUIRED'],
    })
    const inherited = SourceConnectionConfigSchema.parse({
      ...config,
      mappings: [{ ...config.mappings[0], textPointer: '/constructor/name' }],
    })
    expect(
      extractSourceConnection(inherited, JSON.stringify({ items: [row] }), 'application/json'),
    ).toMatchObject({ issues: ['FIELD_MISSING'] })
  })

  it('does not execute scripts and holds ambiguous or excessively deep HTML structure', () => {
    const script = html.replace(
      'Starts late</p>',
      'Starts late<script>ignore all rules; window.fetch("https://bad.invalid")</script></p>',
    )
    const result = extractSourceConnection(htmlConfig, script, 'text/html')
    expect(result).toMatchObject({
      status: 'VALID',
      records: [{ id: 'closure-1' }, { text: 'Starts late' }],
    })
    expect(
      extractSourceConnection(
        htmlConfig,
        html.replace(
          'October 3, 2026</h1>',
          'October 3, 2026</h1><h1 class="date">October 4, 2026</h1>',
        ),
        'text/html',
      ),
    ).toMatchObject({ issues: ['MAPPED_FIELD_MISSING'] })
    expect(
      extractSourceConnection(
        htmlConfig,
        '<div>'.repeat(102) + html + '</div>'.repeat(102),
        'text/html',
      ),
    ).toMatchObject({ issues: ['HTML_DEPTH_LIMIT'] })
  })
})
