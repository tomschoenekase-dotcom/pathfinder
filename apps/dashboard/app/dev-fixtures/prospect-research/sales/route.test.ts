import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ read: vi.fn(), action: vi.fn() }))
vi.mock('@pathfinder/api/prospect-sales-workflow', () => ({
  getNativeSalesWorkflow: mocks.read,
  applyNativeSalesAction: mocks.action,
}))
import * as route from './route'

const input = {
  action: 'prepare',
  input: { venueId: 'venue', expectedSnapshotHash: 'a'.repeat(64) },
}
function request(body: unknown = input, extra: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:58618/dev-fixtures/prospect-research/sales', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      host: '127.0.0.1:58618',
      origin: 'http://127.0.0.1:58618',
      'content-type': 'application/json',
      'x-torchiko-no-send': '1',
      ...extra,
    },
  })
}
describe('explicit local no-send mutation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_SALES_ENABLED', '1')
    mocks.read.mockResolvedValue({ SEND_AUTHORIZED: false, senderAvailable: false })
    mocks.action.mockResolvedValue({ SEND_AUTHORIZED: false, senderAvailable: false })
  })
  afterEach(() => vi.unstubAllEnvs())
  it('allows only explicit same-origin local preparation without send authority', async () => {
    const response = await route.POST(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(response.headers.has('access-control-allow-origin')).toBe(false)
    expect(mocks.action).toHaveBeenCalledWith(input, {
      type: 'HUMAN',
      role: 'PLATFORM_ADMIN',
      id: 'local:no-send-operator',
    })
    expect(Object.keys(route).sort()).toEqual(['GET', 'POST', 'dynamic'])
  })
  it.each([
    { origin: '' },
    { origin: 'https://evil.invalid' },
    { host: 'remote.invalid' },
    { 'x-forwarded-host': 'remote.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    { 'x-torchiko-no-send': '' },
    { 'content-type': 'text/plain' },
  ])('refuses origin/host/CSRF/content-type attack before service access: %j', async (headers) => {
    expect((await route.POST(request(input, headers))).status).toBe(404)
    expect(mocks.action).not.toHaveBeenCalled()
  })
  it('refuses production and absent sales opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect((await route.POST(request())).status).toBe(404)
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_SALES_ENABLED', '')
    expect((await route.POST(request())).status).toBe(404)
    expect(mocks.action).not.toHaveBeenCalled()
  })
  it('rejects sender actions, authority injection and oversized bodies', async () => {
    expect((await route.POST(request({ action: 'send', input: {} }))).status).toBe(400)
    expect((await route.POST(request({ ...input, actor: { id: 'Tom' } }))).status).toBe(400)
    expect((await route.POST(request('x'.repeat(64001)))).status).toBe(413)
    expect(mocks.action).not.toHaveBeenCalled()
  })
  it('does not expose private database errors', async () => {
    mocks.action.mockRejectedValue(new Error('private-database-password-example'))
    const response = await route.POST(request())
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('private-database-password-example')
  })
})
