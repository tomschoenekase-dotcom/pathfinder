import { describe, expect, it, vi } from 'vitest'

import { SourceConnectionConfigSchema } from '@pathfinder/contracts/source-connections'

import { fetchSourceConnection, type SourceConnectionHttpResponse } from './source-connection-fetch'

const sourceUrl = 'https://venue.example.com/program'
const redirectUrl = 'https://venue.example.com/feed'
const config = SourceConnectionConfigSchema.parse({
  version: 1,
  sourceUrl,
  allowedUrls: [sourceUrl, redirectUrl],
  timezone: 'UTC',
  mappings: [
    {
      type: 'json_feed',
      kind: 'description',
      itemsPointer: '/items',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      dateFormat: 'iso',
    },
  ],
  refreshIntervalSeconds: 900,
  freshnessSeconds: 86_400,
  validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'review_required',
})

const body = Buffer.from('{"items":[]}')
function response(
  status: number,
  headers: Record<string, string> = {},
  bytes = body,
): SourceConnectionHttpResponse {
  return { status, headers, body: bytes }
}

describe('approved source fetch', () => {
  it('pins a public resolved IP, uses conditional headers and counts a 304 without extending content validity', async () => {
    const request = vi.fn(async () => response(304, { etag: '"revision-2"' }, Buffer.alloc(0)))
    const result = await fetchSourceConnection(
      config,
      { etag: '"revision-1"' },
      {
        resolveHostname: async () => ['93.184.216.34'],
        request,
      },
    )
    expect(result).toMatchObject({ status: 'not_modified', requestCount: 1, bytesTransferred: 0 })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '93.184.216.34',
        validators: { etag: '"revision-1"' },
      }),
    )
    expect('body' in result).toBe(false)
  })

  it('rechecks an exact approved redirect and returns only the final bounded payload', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: redirectUrl }, Buffer.alloc(3)))
      .mockResolvedValueOnce(response(200, { 'content-type': 'application/feed+json' }, body))
    const result = await fetchSourceConnection(
      config,
      {},
      { resolveHostname: async () => ['93.184.216.34'], request },
    )
    expect(result).toMatchObject({
      status: 'fetched',
      finalUrl: redirectUrl,
      requestCount: 2,
      bytesTransferred: body.length + 3,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('blocks DNS rebinding and unapproved redirects before a second request', async () => {
    const request = vi.fn(async () => response(200, { 'content-type': 'application/feed+json' }))
    expect(
      await fetchSourceConnection(
        config,
        {},
        {
          resolveHostname: async () => ['93.184.216.34', '127.0.0.1'],
          request,
        },
      ),
    ).toMatchObject({ status: 'failed', errorCategory: 'blocked_address', requestCount: 0 })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce(response(302, { location: 'https://other.example.com/private' }))
    expect(
      await fetchSourceConnection(
        config,
        {},
        { resolveHostname: async () => ['93.184.216.34'], request },
      ),
    ).toMatchObject({ status: 'failed', errorCategory: 'redirect_blocked', requestCount: 1 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries a transient response once, accounts for both requests, then fails closed', async () => {
    const request = vi.fn(async () => response(503, {}, Buffer.alloc(4)))
    expect(
      await fetchSourceConnection(
        config,
        {},
        { resolveHostname: async () => ['93.184.216.34'], request },
      ),
    ).toMatchObject({
      status: 'failed',
      errorCategory: 'http_error',
      retryable: true,
      requestCount: 2,
      bytesTransferred: 8,
    })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reserves budget separately for each redirect or retry and stops before a denied hop', async () => {
    const beforeRequest = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const request = vi.fn(async () => response(302, { location: redirectUrl }))
    expect(
      await fetchSourceConnection(
        config,
        {},
        {
          resolveHostname: async () => ['93.184.216.34'],
          beforeRequest,
          request,
        },
      ),
    ).toMatchObject({
      status: 'failed',
      errorCategory: 'budget_exhausted',
      requestCount: 1,
      bytesTransferred: body.length,
    })
    expect(beforeRequest).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('refuses large, compressed, wrong-type and unsolicited 304 responses', async () => {
    for (const sample of [
      response(200, { 'content-type': 'application/feed+json' }, Buffer.alloc(1_000_001)),
      response(200, { 'content-type': 'application/feed+json', 'content-encoding': 'gzip' }),
      response(200, { 'content-type': 'text/html' }),
      response(304),
    ]) {
      const result = await fetchSourceConnection(
        config,
        {},
        { resolveHostname: async () => ['93.184.216.34'], request: async () => sample },
      )
      expect(result.status).toBe('failed')
    }
  })

  it('refuses stale deadline before an HTTP request and invalid conditional headers', async () => {
    let calls = 0
    const now = () => {
      calls += 1
      return calls === 1 ? 0 : 21_000
    }
    const request = vi.fn(async () => response(200, { 'content-type': 'application/feed+json' }))
    expect(
      await fetchSourceConnection(
        config,
        {},
        { now, resolveHostname: async () => ['93.184.216.34'], request },
      ),
    ).toMatchObject({ status: 'failed', errorCategory: 'timeout', requestCount: 0 })
    expect(request).not.toHaveBeenCalled()
    expect(
      await fetchSourceConnection(
        config,
        { etag: 'bad\r\nheader' },
        { resolveHostname: async () => ['93.184.216.34'], request },
      ),
    ).toMatchObject({ status: 'failed', errorCategory: 'config_invalid', requestCount: 0 })
  })

  it('re-resolves every retry/hop and refuses a rebound private address', async () => {
    const resolveHostname = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['::ffff:127.0.0.1'])
    const request = vi.fn(async () => response(503))
    expect(await fetchSourceConnection(config, {}, { resolveHostname, request })).toMatchObject({
      status: 'failed',
      errorCategory: 'blocked_address',
      requestCount: 1,
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(resolveHostname).toHaveBeenCalledTimes(2)
  })

  it('times out DNS and a slow trickling response at the shared deadline, aborting HTTP', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(async () => response(200, { 'content-type': 'application/json' }))
      const dns = fetchSourceConnection(
        config,
        {},
        { resolveHostname: () => new Promise(() => {}), request },
      )
      await vi.advanceTimersByTimeAsync(20_001)
      expect(await dns).toMatchObject({
        status: 'failed',
        errorCategory: 'timeout',
        requestCount: 0,
      })
      expect(request).not.toHaveBeenCalled()
      let signal: AbortSignal | undefined
      const slow = fetchSourceConnection(
        config,
        {},
        {
          resolveHostname: async () => ['93.184.216.34'],
          request: async (input) => {
            signal = input.signal
            return new Promise(() => {})
          },
        },
      )
      await vi.advanceTimersByTimeAsync(20_001)
      expect(await slow).toMatchObject({
        status: 'failed',
        errorCategory: 'timeout',
        requestCount: 1,
      })
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start an HTTP request after a slow durable budget reservation', async () => {
    let clock = 0
    const request = vi.fn(async () => response(200, { 'content-type': 'application/json' }))
    expect(
      await fetchSourceConnection(
        config,
        {},
        {
          now: () => clock,
          resolveHostname: async () => ['93.184.216.34'],
          beforeRequest: async () => {
            clock = 20_001
            return true
          },
          request,
        },
      ),
    ).toMatchObject({ status: 'failed', errorCategory: 'timeout', requestCount: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses encoded path aliases and header-control redirects without a second request', async () => {
    for (const location of [
      '/program%2fextra',
      '/program%252fextra',
      '/program\\extra',
      '/feed\r\n',
    ]) {
      const request = vi.fn(async () => response(302, { location }))
      expect(
        await fetchSourceConnection(
          config,
          {},
          { resolveHostname: async () => ['93.184.216.34'], request },
        ),
      ).toMatchObject({ status: 'failed', errorCategory: 'redirect_blocked', requestCount: 1 })
      expect(request).toHaveBeenCalledTimes(1)
    }
  })
})
