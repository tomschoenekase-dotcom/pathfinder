import { describe, expect, it } from 'vitest'

import { createPortalFixtureClient, FIXTURE_VENUE } from './fixture-client'

const options = { payment: 'paid', uploads: 'ok', send: 'ok', save: 'ok' } as const

describe('client portal fixture assistant preference', () => {
  it('bootstraps the Account preference and keeps a saved value across reads', async () => {
    const client = createPortalFixtureClient(options)

    const initial = await client.clientAssistant.bootstrap.query({})
    expect(initial).toMatchObject({
      available: true,
      selectedVenueId: FIXTURE_VENUE.id,
      preference: { enabled: true, minimized: false, revision: 0 },
      history: [],
    })

    const saved = await client.clientAssistant.setPreference.mutate({
      venueId: FIXTURE_VENUE.id,
      enabled: false,
      minimized: false,
      expectedRevision: 0,
    })
    expect(saved).toEqual({ enabled: false, minimized: false, revision: 1 })
    await expect(client.clientAssistant.bootstrap.query({})).resolves.toMatchObject({
      preference: { enabled: false, minimized: false, revision: 1 },
    })
  })
})
