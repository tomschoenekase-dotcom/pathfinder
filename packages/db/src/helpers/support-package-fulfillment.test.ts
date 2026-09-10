import { describe, expect, it, vi } from 'vitest'

import {
  readSupportPackageFulfillment,
  assertSupportFulfillmentEffectiveAt,
  sameSupportPackageFulfillment,
  supportPackageFulfillmentDigest,
} from './support-package-fulfillment'

const scope = { tenantId: 'tenant_1', venueId: 'venue_1', supportRequestId: 'request_1' }

describe('support package fulfillment evidence', () => {
  it('represents package-free completion with a deterministic exact digest', async () => {
    const reader = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) },
      supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const first = await readSupportPackageFulfillment(reader as never, scope)
    const second = await readSupportPackageFulfillment(reader as never, scope)
    expect(first).toMatchObject({
      contractVersion: 4,
      linkedPackageCount: 0,
      packages: [],
      guestObservability: {
        configuredPath: 'NOT_APPLICABLE',
        reason: 'NO_LINKED_PACKAGES',
        effects: [],
      },
    })
    expect(reader.$executeRaw.mock.calls[0]?.[1]).toBe(
      'pathfinder:support-request:tenant_1:request_1',
    )
    expect(reader.$executeRaw.mock.calls[1]?.slice(1)).toEqual(['tenant_1', 'venue_1'])
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(sameSupportPackageFulfillment(first, second)).toBe(true)
    expect(reader.supportPackageHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ supersessionAsPrior: { is: null } }),
      }),
    )
  })

  it('freezes complete APPLIED identity and rejects any non-applied package', async () => {
    const applyVersionId = '11111111-1111-4111-8111-111111111111'
    const itemKey = '22222222-2222-4222-8222-222222222222'
    const beforeState = { name: 'Old venue name' }
    const afterState = { name: 'Current venue name' }
    const applied = {
      id: 'handoff_1',
      venuePackageId: 'package_1',
      requestVersion: 6,
      venuePackage: {
        status: 'APPLIED',
        payloadHash: 'a'.repeat(64),
        appliedAt: new Date('2026-08-24T20:00:00.000Z'),
        appliedBy: 'agent_1',
        appliedCommandKey: '11111111-1111-4111-8111-111111111111',
        updatedAt: new Date('2026-08-24T20:00:01.000Z'),
        schemaVersion: 3,
        appliedEntities: {
          schemaVersion: 3,
          rollbackContractVersion: 2,
          postApplyDigest: 'b'.repeat(64),
          effects: [
            {
              itemKey,
              entityType: 'VENUE',
              entityId: 'venue_1',
              operation: 'UPDATE',
              applyVersionId,
              snapshotSchemaVersion: 1,
              beforeState,
              afterState,
            },
          ],
        },
      },
    }
    const reader = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) },
      supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([applied]) },
      contentVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: applyVersionId,
            venuePackageId: 'package_1',
            entityType: 'VENUE',
            entityId: 'venue_1',
            operation: 'UPDATE',
            beforeState,
            afterState,
          },
        ]),
      },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1', ...afterState }) },
      place: { findMany: vi.fn().mockResolvedValue([]) },
      venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const fulfillment = await readSupportPackageFulfillment(reader as never, scope)
    expect(fulfillment).toMatchObject({
      contractVersion: 4,
      linkedPackageCount: 1,
      packages: [
        {
          handoffId: 'handoff_1',
          packageId: 'package_1',
          status: 'APPLIED',
          appliedBy: 'agent_1',
        },
      ],
      guestObservability: {
        configuredPath: 'LEGACY',
        effects: [
          {
            packageId: 'package_1',
            applyVersionId,
            entityType: 'VENUE',
            readPath: 'LIVE_VENUE',
          },
        ],
      },
    })
    if (fulfillment.contractVersion !== 4) throw new Error('Expected observable fulfillment')
    const laterVerification = {
      ...fulfillment,
      guestObservability: {
        ...fulfillment.guestObservability,
        verifiedAt: '2030-01-01T00:00:00.000Z',
      },
    }
    laterVerification.contentFulfillment = {
      ...fulfillment.contentFulfillment,
      verifiedAt: '2030-01-01T00:00:00.000Z',
    }
    expect(sameSupportPackageFulfillment(fulfillment, laterVerification)).toBe(true)
    expect(
      sameSupportPackageFulfillment(
        {
          contractVersion: 1,
          linkedPackageCount: 1,
          packages: fulfillment.packages,
          digest: fulfillment.digest,
        },
        fulfillment,
      ),
    ).toBe(false)

    reader.supportPackageHandoff.findMany.mockResolvedValueOnce([
      {
        ...applied,
        venuePackage: {
          ...applied.venuePackage,
          status: 'APPROVED',
          appliedAt: null,
          appliedBy: null,
          appliedCommandKey: null,
        },
      },
    ])
    await expect(readSupportPackageFulfillment(reader as never, scope)).rejects.toThrow(
      'Linked venue package package_1 is not fully applied.',
    )
  })

  it('holds an applied legacy package without supported observable apply evidence', async () => {
    const reader = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) },
      supportPackageHandoff: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'handoff_1',
            venuePackageId: 'package_1',
            requestVersion: 6,
            venuePackage: {
              status: 'APPLIED',
              payloadHash: 'a'.repeat(64),
              appliedAt: new Date('2026-08-24T20:00:00.000Z'),
              appliedBy: 'agent_1',
              appliedCommandKey: '11111111-1111-4111-8111-111111111111',
              updatedAt: new Date('2026-08-24T20:00:01.000Z'),
              schemaVersion: 2,
              appliedEntities: {},
            },
          },
        ]),
      },
    }
    await expect(readSupportPackageFulfillment(reader as never, scope)).rejects.toThrow(
      'schema version 2 does not record immutable applyVersionId, itemKey, and package-action bindings',
    )
  })
})

describe('support completion content approval identity', () => {
  it('does not accept legacy package-free approval for a content receipt and binds content drift', async () => {
    const empty = await readSupportPackageFulfillment(
      {
        $executeRaw: vi.fn().mockResolvedValue(0),
        supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([]) },
        knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      scope,
    )
    if (empty.contractVersion !== 4) throw new Error('Expected current fulfillment')
    const receipt = {
      receiptKind: 'UNIVERSAL' as const,
      receiptId: 'receipt',
      proposalId: 'proposal',
      sourceProposalId: 'proposal',
      sourceRequestVersion: 2,
      moduleId: 'module',
      revisionId: 'revision',
      publicationId: 'publication',
      projectionId: 'projection',
      observedStateHash: 'a'.repeat(64),
    }
    const filled = {
      ...empty,
      contentFulfillment: {
        ...empty.contentFulfillment,
        receipts: [receipt],
        guestRead: { path: 'LEGACY' as const, releaseId: null, nativeStateHash: null },
      },
    }
    const digestOf = (value: typeof filled) =>
      supportPackageFulfillmentDigest({
        contractVersion: value.contractVersion,
        linkedPackageCount: value.linkedPackageCount,
        packages: value.packages,
        guestObservability: value.guestObservability,
        contentFulfillment: value.contentFulfillment,
        temporalFulfillment: value.temporalFulfillment,
      })
    filled.digest = digestOf(filled)
    const legacy = {
      contractVersion: 1 as const,
      linkedPackageCount: 0,
      packages: [],
      digest: 'b'.repeat(64),
    }
    expect(sameSupportPackageFulfillment(legacy, empty)).toBe(true)
    expect(sameSupportPackageFulfillment(legacy, filled)).toBe(false)
    expect(sameSupportPackageFulfillment(filled, legacy)).toBe(false)
    expect(sameSupportPackageFulfillment(empty, filled)).toBe(false)
    const drifted = {
      ...filled,
      contentFulfillment: {
        ...filled.contentFulfillment,
        receipts: [{ ...receipt, observedStateHash: 'c'.repeat(64) }],
      },
    }
    expect(sameSupportPackageFulfillment(filled, drifted)).toBe(false)
    expect(digestOf(drifted)).not.toBe(filled.digest)
    expect(
      digestOf({
        ...filled,
        contentFulfillment: {
          ...filled.contentFulfillment,
          verifiedAt: '2030-01-01T00:00:00.000Z',
        },
      }),
    ).toBe(filled.digest)
  })
})

describe('temporal approval identity', () => {
  it('binds temporal receipts and preserves verification-time stability without legacy bypass', async () => {
    const empty = await readSupportPackageFulfillment(
      {
        $executeRaw: vi.fn().mockResolvedValue(0),
        supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([]) },
        knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      scope,
    )
    if (empty.contractVersion !== 4) throw new Error('Expected current fulfillment')
    const current = {
      ...empty,
      temporalFulfillment: {
        ...empty.temporalFulfillment,
        receipts: [
          {
            handoffId: 'handoff',
            proposalId: 'proposal',
            sourceProposalId: 'source',
            sourceRequestVersion: 1,
            operationalUpdateId: 'update',
            updatedAt: '2026-09-10T12:00:00.000Z',
            publishedAt: '2026-09-10T12:00:00.000Z',
            startsAt: '2026-09-10T12:00:00.000Z',
            expiresAt: '2026-09-10T13:00:00.000Z',
            observedStateHash: 'a'.repeat(64),
          },
        ],
      },
    }
    const digestOf = (value: typeof current) =>
      supportPackageFulfillmentDigest({
        contractVersion: 4,
        linkedPackageCount: value.linkedPackageCount,
        packages: value.packages,
        guestObservability: value.guestObservability,
        contentFulfillment: value.contentFulfillment,
        temporalFulfillment: value.temporalFulfillment,
      })
    current.digest = digestOf(current)
    expect(() =>
      assertSupportFulfillmentEffectiveAt(current, new Date('2026-09-10T12:59:59.000Z')),
    ).not.toThrow()
    expect(() =>
      assertSupportFulfillmentEffectiveAt(current, new Date('2026-09-10T13:00:00.000Z')),
    ).toThrow('no longer currently effective')

    const later = {
      ...current,
      temporalFulfillment: {
        ...current.temporalFulfillment,
        verifiedAt: '2026-09-10T12:40:00.000Z',
      },
    }
    expect(digestOf(later)).toBe(current.digest)
    expect(sameSupportPackageFulfillment(current, later)).toBe(true)
    expect(
      sameSupportPackageFulfillment(
        { contractVersion: 1, linkedPackageCount: 0, packages: [], digest: 'b'.repeat(64) },
        current,
      ),
    ).toBe(false)
    const changed = {
      ...current,
      temporalFulfillment: {
        ...current.temporalFulfillment,
        receipts: [
          { ...current.temporalFulfillment.receipts[0]!, observedStateHash: 'c'.repeat(64) },
        ],
      },
    }
    expect(digestOf(changed)).not.toBe(current.digest)
    expect(sameSupportPackageFulfillment(current, changed)).toBe(false)
  })
})
