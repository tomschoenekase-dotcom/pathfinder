import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ orchestrate: vi.fn() }))
vi.mock('../venue-package', () => ({
  createVenuePackageDraftService: mocks.orchestrate,
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminSupportReviewedDraftRouter } from './support-reviewed-drafts'

const caller = (isPlatformAdmin = true) =>
  router({ admin: adminSupportReviewedDraftRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  })

const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  supportRequestId: 'support_1',
  expectedVersion: 4,
  draftKey: '11111111-1111-4111-8111-111111111111',
  payload: {
    schemaVersion: 1 as const,
    places: [],
    knowledgeEntries: [
      { title: 'Hours', category: 'FAQ', content: 'Current hours.', isEnabled: true },
    ],
  },
}

describe('admin support reviewed-DRAFT adapter', () => {
  it('uses exact support scope and a server-owned finalizer', async () => {
    mocks.orchestrate.mockResolvedValue({ value: { id: 'package_1' }, attachment: {} })
    await caller().admin.createAndLinkSupportReviewedVenuePackageDraft(input)
    expect(mocks.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: input.tenantId,
        input: expect.objectContaining({ venueId: input.venueId, payload: input.payload }),
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
        db: expect.anything(),
        finalizer: expect.any(Function),
      }),
    )
  })

  it('rejects non-admin callers before orchestration', async () => {
    await expect(
      caller(false).admin.createAndLinkSupportReviewedVenuePackageDraft(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
