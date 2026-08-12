import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: { listLegacyContent: mocks.list } }),
}))
vi.mock('../../../../../../../../components/admin/LegacyContentManager', () => ({
  LegacyContentManager: ({ tenantId, venueId }: { tenantId: string; venueId: string }) => (
    <div>{`manager:${tenantId}:${venueId}`}</div>
  ),
}))

import CompatibilityContentPage from './page'

describe('CompatibilityContentPage', () => {
  it('loads and labels the exact internal client workspace scope', async () => {
    mocks.list.mockResolvedValue({
      scope: {
        tenant: { id: 'tenant_1', name: 'Museum Group' },
        venue: { id: 'venue_1', name: 'North Museum', slug: 'north-museum' },
      },
      places: [],
      knowledgeEntries: [],
    })
    const page = await CompatibilityContentPage({
      params: Promise.resolve({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    })
    const html = renderToStaticMarkup(page)
    expect(mocks.list).toHaveBeenCalledWith({ tenantId: 'tenant_1', venueId: 'venue_1' })
    expect(html).toContain('Internal compatibility tools')
    expect(html).toContain('Client portal users cannot access these controls')
    expect(html).toContain('manager:tenant_1:venue_1')
  })
})
