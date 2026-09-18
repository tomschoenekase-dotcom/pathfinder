/* @vitest-environment jsdom */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  listAgentRoutines: vi.fn(),
  listAgentIdentities: vi.fn(),
}))

vi.mock('../../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: async () => ({ admin: mocks }),
}))
vi.mock('../../../../../../../../../components/admin/AgentRoutinesView', () => ({
  AgentRoutinesView: ({ routines, identities }: { routines: unknown[]; identities: unknown[] }) => (
    <p>{`loaded:${routines.length}:${identities.length}`}</p>
  ),
}))

import AgentRoutinesPage from './page'

describe('AgentRoutinesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listAgentRoutines.mockResolvedValue([])
    mocks.listAgentIdentities.mockResolvedValue({ items: [{ id: 'identity-1' }], nextCursor: null })
  })

  it('loads routines and existing identities for the exact venue', async () => {
    const page = await AgentRoutinesPage({
      params: Promise.resolve({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    })

    expect(mocks.listAgentRoutines).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(mocks.listAgentIdentities).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 100,
    })
    expect(renderToStaticMarkup(page)).toContain('loaded:0:1')
  })

  it('reports a read failure without implying any routine action occurred', async () => {
    mocks.listAgentRoutines.mockRejectedValue(new Error('unavailable'))
    const page = await AgentRoutinesPage({
      params: Promise.resolve({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    })

    const markup = renderToStaticMarkup(page)
    expect(markup).toContain('Routine definitions could not be loaded')
    expect(markup).toContain('No routine was enabled, disabled, created, or run.')
  })
})
