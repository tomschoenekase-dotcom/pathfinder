import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({
  db: {},
  resolveCachedVenueDistribution: resolve,
}))

import { GET } from './route'

const INTERNAL_POLICY_TOKEN_HEADER = 'x-torchiko-internal-policy-token'

describe('internal embed frame policy route', () => {
  const originalToken = process.env.INTERNAL_POLICY_TOKEN
  const token = 'test-internal-policy-token-with-more-than-32-bytes'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.INTERNAL_POLICY_TOKEN = token
  })

  afterAll(() => {
    if (originalToken === undefined) delete process.env.INTERNAL_POLICY_TOKEN
    else process.env.INTERNAL_POLICY_TOKEN = originalToken
  })

  it('returns active origins only when website distribution is effective', async () => {
    resolve.mockResolvedValue({ website: { effective: true, origins: ['https://museum.example'] } })
    const response = await GET(
      new Request('https://web.example', { headers: { [INTERNAL_POLICY_TOKEN_HEADER]: token } }),
      { params: Promise.resolve({ venueSlug: 'museum' }) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ origins: ['https://museum.example'] })
    expect(resolve).toHaveBeenCalledWith({ venueSlug: 'museum' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('fails closed for invalid slugs and resolver errors', async () => {
    const request = () =>
      new Request('https://web.example', { headers: { [INTERNAL_POLICY_TOKEN_HEADER]: token } })
    const invalid = await GET(request(), {
      params: Promise.resolve({ venueSlug: 'museum%2Fother' }),
    })
    expect(await invalid.json()).toEqual({ origins: [] })
    expect(resolve).not.toHaveBeenCalled()

    resolve.mockRejectedValue(new Error('database unavailable'))
    const failed = await GET(request(), { params: Promise.resolve({ venueSlug: 'museum' }) })
    expect(await failed.json()).toEqual({ origins: [] })
  })

  it('returns empty-body 404 for missing, unset, and incorrect internal tokens before resolving', async () => {
    const params = { params: Promise.resolve({ venueSlug: 'museum' }) }
    for (const headers of [
      {},
      { [INTERNAL_POLICY_TOKEN_HEADER]: 'wrong-secret' },
      { [INTERNAL_POLICY_TOKEN_HEADER]: `${token}x` },
    ]) {
      const response = await GET(new Request('https://web.example', { headers }), params)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
    }
    delete process.env.INTERNAL_POLICY_TOKEN
    const unset = await GET(
      new Request('https://web.example', { headers: { [INTERNAL_POLICY_TOKEN_HEADER]: token } }),
      params,
    )
    expect(unset.status).toBe(404)
    expect(await unset.text()).toBe('')
    expect(resolve).not.toHaveBeenCalled()
  })
})
