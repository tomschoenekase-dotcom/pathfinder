import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  health: vi.fn(),
  add: vi.fn(),
  change: vi.fn(),
  duplicate: vi.fn(),
}))
vi.mock('@pathfinder/api/chicago-intelligence-local', () => ({
  createLocalChicagoIntelligenceCaller: mock.create,
}))
import { GET, POST } from './route'
const host = '127.0.0.1:58618'
function request(body: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://${host}/dev-fixtures/prospect-research/chicago/data`, {
    method: 'POST',
    headers: { host, origin: `http://${host}`, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  })
}
describe('Chicago fixture HTTP boundary', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
    mock.create.mockReturnValue(mock)
    mock.health.mockResolvedValue({ rankingVersion: 'test' })
  })
  it('rejects missing/cross-origin mutation requests before constructing caller', async () => {
    for (const origin of ['', 'https://external.example'])
      expect((await POST(request({ operation: 'add', input: {} }, { origin }))).status).toBe(404)
    expect(mock.create).not.toHaveBeenCalled()
  })
  it('rejects unsupported operations and oversized bodies', async () => {
    expect((await POST(request({ operation: 'sendEmail', input: {} }))).status).toBe(400)
    expect(
      (await POST(request({ operation: 'add', input: { huge: 'x'.repeat(32769) } }))).status,
    ).toBe(413)
    expect(mock.add).not.toHaveBeenCalled()
  })
  it('runs only schema-admitted read operations', async () => {
    const accepted = new Request(
      `http://${host}/dev-fixtures/prospect-research/chicago/data?operation=health`,
      { headers: { host } },
    )
    expect((await GET(accepted)).status).toBe(200)
    expect(mock.health).toHaveBeenCalledWith({})
    expect(
      (await GET(new Request(`http://${host}/?operation=change`, { headers: { host } }))).status,
    ).toBe(400)
  })
  it('keeps production and forwarded-host requests outside the adapter', async () => {
    expect((await POST(request({}, { 'x-forwarded-host': 'remote.example' }))).status).toBe(404)
    vi.stubEnv('NODE_ENV', 'production')
    expect(
      (await GET(new Request(`http://${host}/?operation=health`, { headers: { host } }))).status,
    ).toBe(404)
    expect(mock.create).not.toHaveBeenCalled()
  })
})
