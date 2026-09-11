import { beforeEach, describe, expect, it, vi } from 'vitest'

const assess = vi.hoisted(() => vi.fn())
vi.mock('./media-relation-route-eligibility', () => ({
  assessMediaRelationRouteEligibility: assess,
}))

import {
  MEDIA_ROUTE_RECEIPT_BYTES_LIMIT,
  MEDIA_ROUTE_STATE_BYTES_LIMIT,
  filterEligibleMediaRouteConnections,
} from './media-relation-route-loader'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const native = (id: string, mediaApplicationCount: number) => ({
  id,
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  fromLocationId: uuid(11),
  toLocationId: uuid(12),
  kind: 'DOOR' as const,
  bidirectional: true,
  accessible: true,
  directions: 'Use the door.',
  isActive: true,
  mediaApplicationCount,
})
function fixture(options: { meta?: unknown[]; stateBytes?: number } = {}) {
  const media = native(uuid(1), 1)
  const receipt = {
    connectionId: media.id,
    requestHash: 'a'.repeat(64),
    actorId: 'admin',
    inputSnapshot: {},
    revisionId: uuid(2),
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    projectId: 'project-a',
    sourceGeneration: uuid(3),
  }
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(
        options.meta ?? [{ connectionId: media.id, historyCount: 2, payloadBytes: 1024 }],
      )
      .mockResolvedValueOnce([receipt])
      .mockResolvedValueOnce([{ totalBytes: options.stateBytes ?? 1024 }])
      .mockResolvedValueOnce([{ ...receipt, currentState: { current: true } }]),
    mediaIngestionProject: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'project-a',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceObjectGeneration: uuid(3),
          uploadAttemptId: uuid(4),
        },
      ]),
    },
  }
  return {
    media,
    native: native(uuid(9), 0),
    tx,
    client: { $transaction: vi.fn((callback) => callback(tx)) },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  assess.mockReturnValue({ eligible: true, reason: 'ELIGIBLE' })
})
describe('filterEligibleMediaRouteConnections', () => {
  it('preserves native routes and includes only revalidated media routes', async () => {
    const { media, native: nativeRoute, tx, client } = fixture()
    await expect(
      filterEligibleMediaRouteConnections({
        client: client as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        connections: [media, nativeRoute],
      }),
    ).resolves.toEqual([media, nativeRoute])
    expect(tx.mediaIngestionProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a' }),
        take: 101,
      }),
    )
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
  })

  it('fails closed for withdrawn review while retaining unrelated native routes', async () => {
    const { media, native: nativeRoute, client } = fixture()
    assess.mockReturnValueOnce({ eligible: false, reason: 'REVIEW_NO_LONGER_ACCEPTED' })
    await expect(
      filterEligibleMediaRouteConnections({
        client: client as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        connections: [media, nativeRoute],
      }),
    ).resolves.toEqual([nativeRoute])
  })

  it.each([
    ['missing receipt', []],
    ['excess receipt history', [{ connectionId: uuid(1), historyCount: 101, payloadBytes: 2048 }]],
    [
      'receipt byte overflow',
      [
        {
          connectionId: uuid(1),
          historyCount: 1,
          payloadBytes: MEDIA_ROUTE_RECEIPT_BYTES_LIMIT + 1,
        },
      ],
    ],
  ])('fails closed for media-backed routes with %s', async (_label, meta) => {
    const { media, native: nativeRoute, client } = fixture({ meta })
    await expect(
      filterEligibleMediaRouteConnections({
        client: client as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        connections: [media, nativeRoute],
      }),
    ).resolves.toEqual([nativeRoute])
  })

  it('fails closed for media-backed routes when the aggregate current state exceeds its SQL budget', async () => {
    const {
      media,
      native: nativeRoute,
      client,
    } = fixture({
      stateBytes: MEDIA_ROUTE_STATE_BYTES_LIMIT + 1,
    })
    await expect(
      filterEligibleMediaRouteConnections({
        client: client as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        connections: [media, nativeRoute],
      }),
    ).resolves.toEqual([nativeRoute])
    expect(assess).not.toHaveBeenCalled()
  })
})
