import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createContext: vi.fn(async (input: unknown) => {
    void input
    return {}
  }),
  enabled: vi.fn(),
  getBySlug: vi.fn(),
  availability: vi.fn(),
}))

vi.mock('@pathfinder/api', () => ({
  appRouter: {
    createCaller: () => ({
      venue: { getBySlug: mocks.getBySlug },
      widget: { availability: mocks.availability },
    }),
  },
  createTRPCContext: mocks.createContext,
}))

vi.mock('@pathfinder/config/feature-flags', () => ({
  isEmbedPreviewEnabled: mocks.enabled,
}))

import { GET } from './route'

function request(slug = 'museum', headers?: HeadersInit) {
  return GET(
    new Request(`https://guide.example/api/widget-ready/${slug}`, headers ? { headers } : {}),
    {
      params: Promise.resolve({ venueSlug: slug }),
    },
  )
}

describe('widget fail-invisible readiness probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled.mockReturnValue(true)
    mocks.getBySlug.mockResolvedValue({ id: 'venue-1' })
    mocks.availability.mockResolvedValue({ enabled: true })
  })

  it('returns only a non-cacheable public readiness bit for an available venue', async () => {
    const response = await request('museum', {
      Origin: 'https://venue.example',
      Referer: 'https://venue.example/page',
    })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'X-PathFinder-Revision, X-PathFinder-Widget-Ready',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(response.headers.get('x-pathfinder-widget-ready')).toBe('1')
    expect(response.headers.get('x-pathfinder-revision')).toEqual(expect.any(String))
    expect([...response.headers.keys()].sort()).toEqual([
      'access-control-allow-origin',
      'access-control-expose-headers',
      'cache-control',
      'cross-origin-resource-policy',
      'x-content-type-options',
      'x-pathfinder-revision',
      'x-pathfinder-widget-ready',
    ])
    expect(mocks.availability).toHaveBeenCalledWith({ venueSlug: 'museum' })
    const contextInput = mocks.createContext.mock.calls[0]?.[0] as { req: Request }
    const contextRequest = contextInput.req
    expect(contextRequest.headers.get('origin')).toBeNull()
    expect(contextRequest.headers.get('referer')).toBeNull()
  })

  it('fails closed before context or venue lookup when the preview is disabled', async () => {
    mocks.enabled.mockReturnValue(false)

    const response = await request()

    expect(response.status).toBe(404)
    expect(mocks.createContext).not.toHaveBeenCalled()
    expect(mocks.getBySlug).not.toHaveBeenCalled()
  })

  it.each(['Museum', '../museum', 'museum?admin=1', 'a'.repeat(201)])(
    'rejects malformed slug authority before context creation: %s',
    async (slug) => {
      const response = await request(slug)

      expect(response.status).toBe(404)
      expect(mocks.createContext).not.toHaveBeenCalled()
      expect(mocks.getBySlug).not.toHaveBeenCalled()
    },
  )

  it.each([
    [{ code: 'NOT_FOUND' }, 404],
    [{ code: 'SERVICE_UNAVAILABLE' }, 503],
    [new Error('unexpected internal failure'), 503],
  ] as const)('returns a bodyless failure for %o', async (error, status) => {
    mocks.availability.mockRejectedValue(error)

    const response = await request('missing')

    expect(response.status).toBe(status)
    expect(await response.text()).toBe('')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-pathfinder-widget-ready')).toBeNull()
  })

  it('contains context-construction failures in the same bodyless unavailable response', async () => {
    mocks.createContext.mockRejectedValueOnce(new Error('context unavailable'))

    const response = await request()

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('')
    expect(response.headers.get('x-pathfinder-widget-ready')).toBeNull()
    expect(mocks.getBySlug).not.toHaveBeenCalled()
  })
})
