import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@pathfinder/api/prospect-geography-local', () => ({
  createLocalProspectGeographyClient: mocks.create,
}))

import { GET, POST } from './route'

const host = '127.0.0.1:58618'
const path = `http://${host}/dev-fixtures/prospect-research/territories/data`

describe('county geography fixture HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('rejects production and forwarded hosts before constructing a caller', async () => {
    const request = () => new Request(`${path}?operation=territories`, { headers: { host } })
    vi.stubEnv('NODE_ENV', 'production')
    expect((await GET(request())).status).toBe(404)
    vi.stubEnv('NODE_ENV', 'development')
    expect(
      (
        await GET(
          new Request(`${path}?operation=territories`, {
            headers: { host, 'x-forwarded-host': 'external.example' },
          }),
        )
      ).status,
    ).toBe(404)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects cross-origin writes before constructing a caller', async () => {
    const response = await POST(
      new Request(path, {
        method: 'POST',
        headers: { host, origin: 'https://external.example', 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'propose', input: {} }),
      }),
    )
    expect(response.status).toBe(404)
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
