import { describe, expect, it, vi } from 'vitest'

import { LIVE_DATA_LIMITS } from '@pathfinder/contracts/live-data'

import { fetchLiveDataJson, type LiveDataFetchDependencies } from './live-data-fetch'

const json = (value: unknown) => Buffer.from(JSON.stringify(value))

function deps(overrides: Partial<LiveDataFetchDependencies> = {}): LiveDataFetchDependencies {
  return {
    allowlist: ['feeds.example-sports.com', 'cdn.example-sports.com'],
    production: true,
    resolveHostname: vi.fn(async () => ['93.184.216.34']),
    request: vi.fn(async () => ({ status: 200, headers: {}, body: json({ ok: 1 }) })),
    ...overrides,
  }
}

describe('fetchLiveDataJson', () => {
  it('returns parsed JSON from an allowlisted public host and pins the validated address', async () => {
    const dependencies = deps()
    const outcome = await fetchLiveDataJson(
      'https://feeds.example-sports.com/v1/game',
      dependencies,
    )
    expect(outcome).toEqual({ ok: true, payload: { ok: 1 } })
    expect(dependencies.request).toHaveBeenCalledWith(
      expect.objectContaining({ address: '93.184.216.34', timeoutMs: 5_000, maxBytes: 65_536 }),
    )
  })

  it('refuses a host that is not allowlisted before any DNS or network work', async () => {
    const dependencies = deps()
    const outcome = await fetchLiveDataJson('https://evil.example.com/x', dependencies)
    expect(outcome).toMatchObject({ ok: false, errorCategory: 'host_not_allowed' })
    expect(dependencies.resolveHostname).not.toHaveBeenCalled()
    expect(dependencies.request).not.toHaveBeenCalled()
  })

  it('fails closed in production when no allowlist is configured', async () => {
    const dependencies = deps({ allowlist: [] })
    expect(
      await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies),
    ).toMatchObject({ ok: false, errorCategory: 'host_not_allowed' })
  })

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918', '10.1.2.3'],
    ['link-local metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
  ])('rejects a host name that resolves to %s space', async (_label, address) => {
    const dependencies = deps({ resolveHostname: vi.fn(async () => [address]) })
    const outcome = await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies)
    expect(outcome).toMatchObject({ ok: false, errorCategory: 'blocked_address', retryable: false })
    expect(dependencies.request).not.toHaveBeenCalled()
  })

  it('rejects a mixed DNS answer (rebinding) when any address is private', async () => {
    const dependencies = deps({ resolveHostname: vi.fn(async () => ['93.184.216.34', '10.0.0.5']) })
    expect(
      await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies),
    ).toMatchObject({ ok: false, errorCategory: 'blocked_address' })
  })

  it('classifies DNS failure as retryable', async () => {
    const dependencies = deps({
      resolveHostname: vi.fn(async () => {
        throw new Error('ENOTFOUND')
      }),
    })
    expect(await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies)).toEqual({
      ok: false,
      errorCategory: 'dns_failure',
      retryable: true,
    })
  })

  it('follows an allowlisted redirect but re-validates the new host', async () => {
    const resolveHostname = vi.fn(async () => ['93.184.216.34'])
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://cdn.example-sports.com/v2/game' },
        body: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: json({ moved: true }) })
    const outcome = await fetchLiveDataJson(
      'https://feeds.example-sports.com/v1/game',
      deps({ resolveHostname, request }),
    )
    expect(outcome).toEqual({ ok: true, payload: { moved: true } })
    expect(resolveHostname).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![0].url.hostname).toBe('cdn.example-sports.com')
  })

  it.each([
    ['private IP literal', 'https://10.0.0.1/admin', 'blocked_address'],
    ['cloud metadata literal', 'http://169.254.169.254/latest/meta-data', 'host_not_allowed'],
    ['non-allowlisted external host', 'https://evil.example.com/x', 'host_not_allowed'],
    ['internal name', 'https://metadata.internal/x', 'blocked_address'],
  ])('blocks a redirect to a %s', async (_label, location, category) => {
    const request = vi.fn().mockResolvedValueOnce({
      status: 301,
      headers: { location },
      body: Buffer.alloc(0),
    })
    const outcome = await fetchLiveDataJson(
      'https://feeds.example-sports.com/v1/game',
      deps({ request }),
    )
    expect(outcome).toMatchObject({ ok: false, errorCategory: category })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('blocks a redirect whose new host resolves to a private address', async () => {
    const resolveHostname = vi
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['192.168.0.9'])
    const request = vi.fn().mockResolvedValueOnce({
      status: 307,
      headers: { location: 'https://cdn.example-sports.com/x' },
      body: Buffer.alloc(0),
    })
    const outcome = await fetchLiveDataJson(
      'https://feeds.example-sports.com/v1/game',
      deps({ resolveHostname, request }),
    )
    expect(outcome).toMatchObject({ ok: false, errorCategory: 'blocked_address' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('bounds redirect chains', async () => {
    const request = vi.fn(async () => ({
      status: 302,
      headers: { location: 'https://feeds.example-sports.com/again' },
      body: Buffer.alloc(0),
    }))
    const outcome = await fetchLiveDataJson(
      'https://feeds.example-sports.com/v1/game',
      deps({ request }),
    )
    expect(outcome).toMatchObject({ ok: false, errorCategory: 'redirect_blocked' })
    expect(request).toHaveBeenCalledTimes(LIVE_DATA_LIMITS.maxRedirects + 1)
  })

  it('rejects an oversized payload', async () => {
    const dependencies = deps({
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: Buffer.alloc(LIVE_DATA_LIMITS.maxPayloadBytes + 1, 'a'),
      })),
    })
    expect(
      await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies),
    ).toMatchObject({ ok: false, errorCategory: 'payload_too_large' })
  })

  it('rejects non-JSON bodies', async () => {
    const dependencies = deps({
      request: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('<html>') })),
    })
    expect(
      await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies),
    ).toMatchObject({ ok: false, errorCategory: 'invalid_json' })
  })

  it('marks 5xx and 429 retryable but 4xx not', async () => {
    const outcomeFor = (status: number) =>
      fetchLiveDataJson(
        'https://feeds.example-sports.com/x',
        deps({ request: vi.fn(async () => ({ status, headers: {}, body: Buffer.alloc(0) })) }),
      )
    expect(await outcomeFor(503)).toEqual({
      ok: false,
      errorCategory: 'http_error',
      retryable: true,
    })
    expect(await outcomeFor(429)).toMatchObject({ retryable: true })
    expect(await outcomeFor(404)).toEqual({
      ok: false,
      errorCategory: 'http_error',
      retryable: false,
    })
  })

  it('maps unexpected transport errors to a retryable network_error', async () => {
    const dependencies = deps({
      request: vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    })
    expect(await fetchLiveDataJson('https://feeds.example-sports.com/x', dependencies)).toEqual({
      ok: false,
      errorCategory: 'network_error',
      retryable: true,
    })
  })
})
