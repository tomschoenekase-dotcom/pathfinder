import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  createWebsiteIntakeRuntimeDependencies,
  extractWebsitePage,
  robotsAllows,
} from './website-intake-runtime'

describe('website intake runtime', () => {
  it('returns bounded non-text bytes intact and rejects oversized loopback responses', async () => {
    const pdfBody = Buffer.from([0x25, 0x50, 0x44, 0x46])
    const server = createServer((request, response) => {
      if (request.url === '/oversized') {
        response.writeHead(200, { 'content-type': 'application/pdf' })
        response.end(Buffer.alloc(9, 1))
        return
      }
      response.writeHead(200, { 'content-type': 'application/pdf' })
      response.end(pdfBody)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const { port } = server.address() as AddressInfo
      const runtime = createWebsiteIntakeRuntimeDependencies({ userAgent: 'TorchikoBuilder/1.0' })
      const baseRequest = {
        resolvedAddresses: ['127.0.0.1'],
        redirectMode: 'MANUAL' as const,
        maxBytes: 8,
        timeoutMs: 1_000,
      }

      await expect(
        runtime.fetchPage({
          ...baseRequest,
          url: `http://source.example:${port}/document.pdf`,
        }),
      ).resolves.toMatchObject({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: pdfBody,
      })
      await expect(
        runtime.fetchPage({
          ...baseRequest,
          url: `http://source.example:${port}/oversized`,
        }),
      ).rejects.toThrow('byte limit')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

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
    expect(result.extractionProfile).toBe('static-html-v1')
  })

  it('extracts readable body text with entities, block boundaries, and footer details', () => {
    const result = extractWebsitePage({
      url: 'https://example.org/',
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Not body copy</title></head><body>
        <main><h1>Cafe\u0301 &amp; Hall</h1><p>Weddings <strong>and events</strong>.</p>
        <div hidden>Hidden offer</div><p aria-hidden="TRUE">Hidden directions</p>
        <script>Visible-looking script text</script><style>.x { content: 'no'; }</style>
        <template>Template text</template><noscript>Fallback text</noscript></main>
        <footer><p>123 Main St.</p><p>Call 555-0100</p></footer>
      </body></html>`,
    })

    expect(result.readableText).toBe(
      'Café & Hall\nWeddings and events.\n123 Main St.\nCall 555-0100',
    )
    expect(result.extractionProfile).toBe('static-html-v1')
  })

  it('keeps plain text literal and does not derive HTML facts or links', () => {
    const result = extractWebsitePage({
      url: 'https://example.org/menu.txt',
      contentType: 'text/plain; charset=UTF-8',
      body: '  Use <b>literal</b> &amp; entities.\r\n\r\nCall  555-0100  ',
    })

    expect(result).toEqual({
      links: [],
      facts: [],
      readableText: 'Use <b>literal</b> &amp; entities.\n\nCall 555-0100',
      extractionProfile: 'plain-text-v1',
    })
  })

  it('handles deeply nested HTML without recursive traversal', () => {
    const depth = 20_000
    const result = extractWebsitePage({
      url: 'https://example.org/',
      contentType: 'text/html',
      body: `${'<div>'.repeat(depth)}Deep venue details${'</div>'.repeat(depth)}`,
    })

    expect(result.readableText).toBe('Deep venue details')
  })
})
