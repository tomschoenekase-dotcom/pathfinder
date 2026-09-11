import { beforeEach, describe, expect, it, vi } from 'vitest'

const { review } = vi.hoisted(() => ({ review: vi.fn() }))
vi.mock('../../lib/intake-source-mapping-review', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/intake-source-mapping-review')>()),
  reviewIntakeSourceMappingForV1: review,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminIntakeSourceMappingReviewRouter } from './intake-source-mapping-review'

const app = router({ admin: adminIntakeSourceMappingReviewRouter })
const input = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceRunId: 'source-a',
  expectedSourceInputHash: 'a'.repeat(64),
  rationale: 'Only public arrival guidance is selected.',
  kind: 'OPTIONAL_NOTES_SELECTION' as const,
  consentToPublicUse: true as const,
  ranges: [{ start: 0, end: 12 }],
  title: 'Arrival',
  category: 'visitor-guide',
}
function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin-a',
      activeTenantId: 'session-tenant',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}

describe('source mapping review authority', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    review.mockResolvedValue({ reviewId: input.operationId, published: false })
  })

  it('denies tenant owners before reading or projecting private source evidence', async () => {
    await expect(
      app.createCaller(context(false)).admin.reviewIntakeSourceMapping(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(review).not.toHaveBeenCalled()
  })

  it('derives the reviewer from the session and preserves exact explicit source scope', async () => {
    await app.createCaller(context(true)).admin.reviewIntakeSourceMapping(input)
    expect(review).toHaveBeenCalledWith({
      db: expect.anything(),
      command: { ...input, reviewedBy: 'admin-a' },
    })
  })

  it('rejects injected reviewer identity or missing public-use consent', async () => {
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.reviewIntakeSourceMapping({ ...input, reviewedBy: 'other-admin' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.admin.reviewIntakeSourceMapping({ ...input, consentToPublicUse: false } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(review).not.toHaveBeenCalled()
  })

  it('does not expose private source text or infrastructure details from an unexpected failure', async () => {
    review.mockRejectedValueOnce(new Error('private source body or database URL'))
    await expect(
      app.createCaller(context(true)).admin.reviewIntakeSourceMapping(input),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'The source mapping could not be saved. Refresh its evidence and review the selection.',
    })
  })
})
