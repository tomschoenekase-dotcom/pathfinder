import { describe, expect, it } from 'vitest'

import {
  createWebsiteIntakeRuntimeDependencies,
  extractWebsitePage,
  robotsAllows,
} from './website-intake-runtime'

describe('website intake runtime', () => {
  it('rejects an already-cancelled fetch before opening a network request', async () => {
    const controller = new AbortController()
    controller.abort()
    const runtime = createWebsiteIntakeRuntimeDependencies({ userAgent: 'TorchikoBuilder/1.0' })

    await expect(
      runtime.fetchPage({
        url: 'http://example.invalid/',
        resolvedAddresses: ['127.0.0.1'],
        redirectMode: 'MANUAL',
        maxBytes: 1_024,
        timeoutMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Website intake was cancelled')
  })

  it('uses the most specific robots group and longest matching rule', () => {
    const robots = `
User-agent: *
Disallow: /private

User-agent: TorchikoBuilder
Disallow: /admin
Allow: /admin/public$
`
    expect(robotsAllows(robots, 'https://example.org/private', 'TorchikoBuilder/1.0')).toBe(true)
    expect(robotsAllows(robots, 'https://example.org/admin', 'TorchikoBuilder/1.0')).toBe(false)
    expect(robotsAllows(robots, 'https://example.org/admin/public', 'TorchikoBuilder/1.0')).toBe(
      true,
    )
    expect(
      robotsAllows(robots, 'https://example.org/admin/public/more', 'TorchikoBuilder/1.0'),
    ).toBe(false)
  })

  it('extracts deterministic cited facts and ignores malformed optional JSON-LD', () => {
    const result = extractWebsitePage({
      url: 'https://example.org/',
      body: `
        <html><head>
          <title>Example &amp; Hall</title>
          <meta name="description" content="A welcoming venue">
          <script type="application/ld+json">{"name":"Example Hall","telephone":"555-0100","openingHours":["Mo-Fr 09:00-17:00"]}</script>
          <script type="application/ld+json">{not json}</script>
        </head><body><a href="/visit">Visit</a><a href="https://other.example/">Other</a></body></html>
      `,
    })

    expect(result.links).toEqual(['/visit', 'https://other.example/'])
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: 'venue.name',
          value: 'Example Hall',
          locator: 'json-ld',
        }),
        expect.objectContaining({ fieldPath: 'venue.phone', value: '555-0100' }),
        expect.objectContaining({ fieldPath: 'venue.hours', dateSensitive: true }),
        expect.objectContaining({ fieldPath: 'venue.pageTitle', value: 'Example & Hall' }),
        expect.objectContaining({ fieldPath: 'venue.description', value: 'A welcoming venue' }),
      ]),
    )
  })
})
