import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import superjson from 'superjson'

const mocks = vi.hoisted(() => ({ list: vi.fn(), reader: vi.fn() }))
vi.mock('@pathfinder/api/prospect-research-reader', () => ({
  createLocalProspectResearchReader: mocks.reader,
}))
import * as route from './route'

describe('local CRM GET acceptance adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
    mocks.reader.mockReturnValue({ list: mocks.list })
    mocks.list.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 })
  })
  afterEach(() => vi.unstubAllEnvs())
  const request = (input = '{}', extra: Record<string, string> = {}) =>
    new Request(
      `http://127.0.0.1:58618/dev-fixtures/prospect-research/data?input=${encodeURIComponent(input)}`,
      {
        headers: { host: '127.0.0.1:58618', ...extra },
      },
    )
  it('returns only bounded native read data with no-store headers', async () => {
    const result = await route.GET(request('{"limit":50,"search":"Museum"}'))
    expect(result.status).toBe(200)
    expect(result.headers.get('Cache-Control')).toBe('no-store, private')
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(superjson.parse(await result.text())).toEqual({
      items: [],
      nextCursor: null,
      totalCount: 0,
    })
    expect(mocks.list).toHaveBeenCalledWith({ limit: 50, search: 'Museum' })
    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic'])
  })
  it('production and missing opt-in fail before creating any reader', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect((await route.GET(request())).status).toBe(404)
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '')
    expect((await route.GET(request())).status).toBe(404)
    expect(mocks.reader).not.toHaveBeenCalled()
  })
  it('cross-origin and remote-host requests fail before database access', async () => {
    for (const headers of [
      { origin: 'https://other.example' },
      { host: 'remote.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-forwarded-host': 'remote.example' },
    ]) {
      expect((await route.GET(request('{}', headers as Record<string, string>))).status).toBe(404)
    }
    expect(mocks.reader).not.toHaveBeenCalled()
  })
  it('oversized, malformed and native-invalid read input never exposes internal errors', async () => {
    expect((await route.GET(request('x'.repeat(4001)))).status).toBe(400)
    expect(mocks.reader).not.toHaveBeenCalled()
    expect((await route.GET(request('not json'))).status).toBe(400)
    mocks.list.mockRejectedValue(new Error('private database details'))
    const result = await route.GET(request('{"tenantId":"unauthorized"}'))
    expect(result.status).toBe(400)
    expect(await result.text()).not.toContain('private database details')
  })
})
