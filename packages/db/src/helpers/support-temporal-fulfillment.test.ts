import { describe, expect, it, vi } from 'vitest'

const lock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('./content-version-context', () => ({ lockContentVersionEntity: lock }))

import {
  readSupportTemporalFulfillment,
  supportTemporalFulfillmentDigest,
} from './support-temporal-fulfillment'

const scope = { tenantId: 'tenant_1', venueId: 'venue_1', supportRequestId: 'request_1' }
const asOf = new Date('2026-09-10T12:00:00.000Z')
const dates = {
  updatedAt: new Date('2026-09-10T11:00:00.000Z'),
  publishedAt: new Date('2026-09-10T10:00:00.000Z'),
  startsAt: new Date('2026-09-10T09:00:00.000Z'),
  expiresAt: new Date('2026-09-10T13:00:00.000Z'),
}

function source(status = 'APPROVED') {
  return {
    id: 'proposal_1',
    status,
    supportRequestId: 'request_1',
    supportRequestVersion: 4,
    producedByConflictResolution: null,
  }
}
function update(overrides: Record<string, unknown> = {}) {
  return {
    id: 'update_1',
    placeId: null,
    place: null,
    updateType: 'GENERAL_NOTICE',
    severity: 'INFO',
    priority: 'NORMAL',
    title: 'Hours',
    body: 'Open daily.',
    redirectTo: null,
    ...dates,
    ...overrides,
  }
}
function reader(overrides: Record<string, unknown> = {}) {
  lock.mockClear()
  return {
    knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([source()]) },
    supportRequestAuditEvent: { findUnique: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
    knowledgeProposalOperationalUpdateHandoff: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'handoff_1', proposalId: 'proposal_1', operationalUpdateId: 'update_1' },
        ])
        .mockResolvedValueOnce([
          { id: 'handoff_1', proposalId: 'proposal_1', operationalUpdateId: 'update_1' },
        ]),
    },
    operationalUpdate: { findMany: vi.fn().mockResolvedValue([update()]) },
    $executeRaw: vi.fn(),
    ...overrides,
  }
}

describe('support temporal fulfillment', () => {
  it('returns no receipt when no scoped source proposal exists', async () => {
    const db = reader({ knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) } })
    await expect(
      readSupportTemporalFulfillment(db as never, { ...scope, asOf }),
    ).resolves.toMatchObject({ receipts: [] })
    expect(db.knowledgeProposalOperationalUpdateHandoff.findMany).not.toHaveBeenCalled()
  })

  it('proves a live update in the exact bounded guest query and locks its entity', async () => {
    const db = reader()
    const value = await readSupportTemporalFulfillment(db as never, { ...scope, asOf })
    expect(value.receipts).toEqual([
      expect.objectContaining({ handoffId: 'handoff_1', operationalUpdateId: 'update_1' }),
    ])
    expect(lock).toHaveBeenCalledWith(db, {
      tenantId: 'tenant_1',
      entityType: 'OPERATIONAL_UPDATE',
      entityId: 'update_1',
    })
    expect(db.operationalUpdate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PUBLISHED',
          isActive: true,
          startsAt: { lte: asOf },
          expiresAt: { gt: asOf },
        }),
        orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }, { id: 'asc' }],
        take: 20,
      }),
    )
  })

  it.each(['expired', 'scheduled', 'private', 'top-20 omitted'] as const)(
    'rejects a %s update that is absent from the guest-visible bounded result',
    async () => {
      const db = reader({ operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) } })
      await expect(readSupportTemporalFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
        'not currently guest observable',
      )
    },
  )

  it('still checks a rejected source when it owns a temporal handoff', async () => {
    const db = reader({
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([source('REJECTED')]) },
      operationalUpdate: { findMany: vi.fn().mockResolvedValue([]) },
    })
    await expect(readSupportTemporalFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      'not currently guest observable',
    )
  })

  it('rejects a handoff inserted after the locked identity snapshot', async () => {
    const db = reader({
      knowledgeProposalOperationalUpdateHandoff: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'handoff_1', proposalId: 'proposal_1', operationalUpdateId: 'update_1' },
          ])
          .mockResolvedValueOnce([
            { id: 'handoff_1', proposalId: 'proposal_1', operationalUpdateId: 'update_1' },
            { id: 'handoff_2', proposalId: 'proposal_1', operationalUpdateId: 'update_2' },
          ]),
      },
    })
    await expect(readSupportTemporalFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      'Temporal receipt set changed while acquiring verification locks',
    )
  })

  it('uses sorted operational IDs for locks and ignores verification time in the digest', async () => {
    const db = reader({
      knowledgeProposalOperationalUpdateHandoff: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            { id: 'handoff_a', proposalId: 'proposal_1', operationalUpdateId: 'update_b' },
            { id: 'handoff_b', proposalId: 'proposal_1', operationalUpdateId: 'update_a' },
          ])
          .mockResolvedValueOnce([
            { id: 'handoff_a', proposalId: 'proposal_1', operationalUpdateId: 'update_b' },
            { id: 'handoff_b', proposalId: 'proposal_1', operationalUpdateId: 'update_a' },
          ]),
      },
      operationalUpdate: {
        findMany: vi
          .fn()
          .mockResolvedValue([update({ id: 'update_a' }), update({ id: 'update_b' })]),
      },
    })
    const value = await readSupportTemporalFulfillment(db as never, { ...scope, asOf })
    expect(lock.mock.calls.map(([, value]) => value.entityId)).toEqual(['update_a', 'update_b'])
    const identity = { contractVersion: value.contractVersion, receipts: value.receipts }
    expect(supportTemporalFulfillmentDigest(identity)).toBe(value.digest)
  })

  it('changes receipt evidence when the observed update drifts', async () => {
    const first = await readSupportTemporalFulfillment(reader() as never, { ...scope, asOf })
    const second = await readSupportTemporalFulfillment(
      reader({
        operationalUpdate: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              update({ body: 'Changed.', updatedAt: new Date('2026-09-10T11:01:00.000Z') }),
            ]),
        },
      }) as never,
      { ...scope, asOf },
    )
    expect(second.digest).not.toBe(first.digest)
  })

  it('binds a guest-visible place to the exact public venue scope', async () => {
    const db = reader({
      operationalUpdate: {
        findMany: vi.fn().mockResolvedValue([
          update({
            placeId: 'place_1',
            place: {
              id: 'place_1',
              tenantId: 'tenant_1',
              venueId: 'venue_1',
              name: 'North Hall',
              visibility: 'PRIVATE',
            },
          }),
        ]),
      },
    })
    await expect(readSupportTemporalFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      'not in the exact public guest scope',
    )
  })

  it('changes receipt evidence when a linked public place name drifts', async () => {
    const publicPlace = {
      id: 'place_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      visibility: 'PUBLIC',
    }
    const first = await readSupportTemporalFulfillment(
      reader({
        operationalUpdate: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              update({ placeId: 'place_1', place: { ...publicPlace, name: 'North Hall' } }),
            ]),
        },
      }) as never,
      { ...scope, asOf },
    )
    const second = await readSupportTemporalFulfillment(
      reader({
        operationalUpdate: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              update({ placeId: 'place_1', place: { ...publicPlace, name: 'South Hall' } }),
            ]),
        },
      }) as never,
      { ...scope, asOf },
    )
    expect(second.digest).not.toBe(first.digest)
  })
})
