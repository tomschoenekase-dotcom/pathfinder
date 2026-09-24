import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@pathfinder/api/prospect-sales-workflow', () => ({
  getNativeSalesWorkflow: mocks.read,
}))
vi.mock('@pathfinder/db', () => ({ localFirstSendRehearsalEnabled: vi.fn(() => true) }))

import * as route from './route'

const venueId = 'SYN-CRM-FIRSTSEND-VENUE-r007'
function get(venue = venueId, headers: Record<string, string> = {}) {
  return new Request(
    `http://127.0.0.1:58618/dev-fixtures/prospect-research/workspace/sales?venueId=${encodeURIComponent(venue)}`,
    { headers: { host: '127.0.0.1:58618', ...headers } },
  )
}
describe('synthetic preparation workspace sales boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED', '1')
    vi.stubEnv('TORCHIKO_VISUAL_FIXTURES_ENABLED', '1')
    mocks.read.mockResolvedValue({ venueId, SEND_AUTHORIZED: false, senderAvailable: false })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('reads only the named synthetic venue through the existing no-send owner', async () => {
    expect((await route.GET(get())).status).toBe(200)
    expect(mocks.read).toHaveBeenCalledWith(venueId)
  })

  it('fails closed for normal IDs and remote origins before the workflow is read', async () => {
    expect((await route.GET(get('venue-live'))).status).toBe(404)
    expect((await route.GET(get(venueId, { origin: 'https://elsewhere.invalid' }))).status).toBe(
      404,
    )
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
