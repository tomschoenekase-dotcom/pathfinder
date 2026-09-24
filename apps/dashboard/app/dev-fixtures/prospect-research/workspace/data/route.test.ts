import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ detail: vi.fn(), reader: vi.fn() }))
vi.mock('@pathfinder/api/prospect-research-reader', () => ({
  createLocalProspectResearchReader: mocks.reader,
}))
vi.mock('@pathfinder/db', () => ({ localFirstSendRehearsalEnabled: vi.fn(() => true) }))

import * as route from './route'

function request(organizationId: string, headers: Record<string, string> = {}) {
  return new Request(
    `http://127.0.0.1:58618/dev-fixtures/prospect-research/workspace/data?organizationId=${encodeURIComponent(organizationId)}`,
    { headers: { host: '127.0.0.1:58618', ...headers } },
  )
}

describe('synthetic preparation workspace data boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
    mocks.reader.mockReturnValue({ detail: mocks.detail })
    mocks.detail.mockResolvedValue({
      id: 'SYN-CRM-FIRSTSEND-ORG-r007',
      canonicalName: 'Synthetic Harbor Museum',
      venues: [{ id: 'SYN-CRM-FIRSTSEND-VENUE-r007', name: 'Synthetic Harbor', archivedAt: null }],
      contacts: [{ email: 'must-not-leak@example.invalid' }],
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('projects only the explicit synthetic organization and venue identities', async () => {
    const response = await route.GET(request('SYN-CRM-FIRSTSEND-ORG-r007'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: 'SYN-CRM-FIRSTSEND-ORG-r007',
      canonicalName: 'Synthetic Harbor Museum',
      venues: [{ id: 'SYN-CRM-FIRSTSEND-VENUE-r007', name: 'Synthetic Harbor', archivedAt: null }],
    })
    expect(mocks.detail).toHaveBeenCalledWith({ organizationId: 'SYN-CRM-FIRSTSEND-ORG-r007' })
  })

  it('refuses real, cold, remote, and cross-origin IDs before the reader is created', async () => {
    for (const value of ['porg_1234567890abcdef12345678', 'SYN-CRM-FIRSTSEND-ORG-r', ''])
      expect((await route.GET(request(value))).status).toBe(404)
    expect(
      (
        await route.GET(
          request('SYN-CRM-FIRSTSEND-ORG-r007', { origin: 'https://elsewhere.invalid' }),
        )
      ).status,
    ).toBe(404)
    expect(mocks.reader).not.toHaveBeenCalled()
  })

  it('returns a bounded missing-fixture response only for an owner-confirmed missing record', async () => {
    mocks.detail.mockRejectedValue({ code: 'NOT_FOUND' })
    const response = await route.GET(request('SYN-CRM-FIRSTSEND-ORG-r999'))
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).toContain('Synthetic record is not present')
  })

  it('keeps a generic reader failure unavailable instead of misclassifying it as missing', async () => {
    mocks.detail.mockRejectedValue(new Error('unrelated database detail'))
    const response = await route.GET(request('SYN-CRM-FIRSTSEND-ORG-r999'))
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(body).toContain('Synthetic CRM record read is unavailable')
    expect(body).not.toContain('unrelated database detail')
  })
})
