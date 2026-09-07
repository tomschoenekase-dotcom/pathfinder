import { describe, expect, it, vi } from 'vitest'
vi.mock('@pathfinder/db', () => ({
  db: {},
  lockVenueContentMutation: vi.fn(),
  writeAuditLogStrict: vi.fn(),
}))
import { applyMediaRelationDraft } from './media-relation-application-service'
import { mediaIntakeHash } from './media-intake-snapshot'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const input = {
  tenantId: 'tenant',
  venueId: 'venue',
  projectId: 'project',
  sourceGeneration: uuid(1),
  revisionId: uuid(2),
  relationId: 'door',
  relationReviewRequestId: uuid(3),
  requestId: uuid(4),
  expectedMediaUpdatedAt: '2026-09-07T09:00:00.000Z',
  fromLocationId: uuid(5),
  fromLocationUpdatedAt: '2026-09-07T09:00:00.000Z',
  toLocationId: uuid(6),
  toLocationUpdatedAt: '2026-09-07T09:00:00.000Z',
  rationale: 'Verified both mapped anchors and path.',
}
function fixture() {
  const receipt = {
    id: uuid(7),
    connectionId: input.requestId,
    actorId: 'admin',
    requestHash: mediaIntakeHash({ input, actorId: 'admin' }),
    inputSnapshot: { input, actorId: 'admin' },
  }
  const tx = { $executeRaw: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([receipt]) }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    $queryRaw: vi.fn().mockResolvedValue([receipt]),
  }
  return { receipt, tx, client }
}
describe('route application receipt replay', () => {
  it('returns the immutable original outcome before reading changed media or active routes', async () => {
    const { client, tx } = fixture()
    await expect(
      applyMediaRelationDraft({ client: client as never, input, actorId: 'admin' }),
    ).resolves.toMatchObject({
      connectionId: input.requestId,
      replayed: true,
      createdAs: 'INACTIVE_DRAFT',
    })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })
  it('rejects changed actors and changed inputs behind the same request identity', async () => {
    const { client } = fixture()
    await expect(
      applyMediaRelationDraft({ client: client as never, input, actorId: 'other' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      applyMediaRelationDraft({
        client: client as never,
        input: { ...input, toLocationId: uuid(8) },
        actorId: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('rejects a receipt redirected to another canonical connection', async () => {
    const { client, receipt } = fixture()
    receipt.connectionId = uuid(8)
    await expect(
      applyMediaRelationDraft({ client: client as never, input, actorId: 'admin' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('rejects blank actor identities before any database operation', async () => {
    const { client } = fixture()
    await expect(
      applyMediaRelationDraft({ client: client as never, input, actorId: ' \t' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
