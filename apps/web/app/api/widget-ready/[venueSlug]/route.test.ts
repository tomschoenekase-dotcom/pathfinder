import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), getPublicVenue: vi.fn() }))
vi.mock('@pathfinder/db', () => ({ resolveCachedVenueDistribution: mocks.resolve }))
vi.mock('@pathfinder/ui/theme', () => ({
  getChatPalette: () => ({ accent: '#3570a8', bg: '#0d1116', isDark: true }),
  isHexColor: (value: unknown) => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value),
}))
vi.mock('../../../../lib/public-venue', () => ({ getPublicVenue: mocks.getPublicVenue }))

import { GET } from './route'

const admitted = {
  venueId: 'venue-1',
  tenantId: 'tenant-1',
  venueActive: true,
  website: {
    effective: true,
    framed: true,
    reason: null,
    frameReason: null,
    origins: ['https://venue.example'],
  },
  app: { effective: false, reason: 'SURFACE_DISABLED' },
  revision: 3,
}

function request(slug = 'museum', version?: '2', headers?: HeadersInit) {
  const suffix = version ? '?v=2' : ''
  return GET(
    new Request(
      `https://guide.example/api/widget-ready/${slug}${suffix}`,
      headers ? { headers } : {},
    ),
    { params: Promise.resolve({ venueSlug: slug }) },
  )
}

describe('widget fail-invisible readiness probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(admitted)
    mocks.getPublicVenue.mockResolvedValue({
      id: 'venue-1',
      name: 'Museum of Long Names That Need Truncation',
      aiGuideName: null,
      chatTheme: 'midnight',
      chatAccentColor: '#0b5cff',
    })
  })

  it('keeps the legacy bodyless 204 contract for callers without v=2', async () => {
    const response = await request('museum', undefined, { Origin: 'https://venue.example' })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('x-pathfinder-widget-ready')).toBe('1')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.getPublicVenue).not.toHaveBeenCalled()
  })

  it('returns a word-bounded label and sanitized accent, theme, and background for v2', async () => {
    const response = await request('museum', '2')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      v: 2,
      label: 'Ask Museum of Long Names That Need…',
      accent: '#0b5cff',
      theme: 'dark',
      background: '#0d1116',
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-pathfinder-widget-ready')).toBeNull()
  })

  it('prefers a configured AI guide name for the public launcher label', async () => {
    mocks.getPublicVenue.mockResolvedValueOnce({
      id: 'venue-1',
      name: 'City Museum',
      aiGuideName: 'CITY',
      chatTheme: 'midnight',
      chatAccentColor: '#0b5cff',
    })
    const response = await request('museum', '2')
    expect(await response.json()).toMatchObject({ label: 'Ask CITY' })
  })

  it('narrows the probe to an admitted Origin and allows missing Origin', async () => {
    expect((await request('museum', '2', { Origin: 'https://unapproved.example' })).status).toBe(
      404,
    )
    expect((await request('museum', '2')).status).toBe(200)
    expect((await request('museum', '2', { Origin: 'https://venue.example' })).status).toBe(200)
  })

  it.each([
    ['inactive venue', { ...admitted, venueActive: false }],
    [
      'disabled website',
      {
        ...admitted,
        website: {
          effective: false,
          framed: false,
          reason: 'SURFACE_DISABLED',
          frameReason: 'NO_ORIGINS',
          origins: [],
        },
      },
    ],
  ])('fails closed for %s', async (_label, distribution) => {
    mocks.resolve.mockResolvedValueOnce(distribution)
    expect((await request('museum', '2')).status).toBe(404)
  })

  it('returns 503 without leaking internal errors', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('database detail'))
    const response = await request('museum', '2')
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects malformed slugs before the public resolver', async () => {
    expect((await request('../museum', '2')).status).toBe(404)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
})
