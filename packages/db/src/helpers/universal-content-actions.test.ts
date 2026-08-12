import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('./audit', () => ({ writeAuditLogStrict: audit }))

import {
  addUniversalContentRevisionAction,
  buildUniversalContentPreview,
  createUniversalContentAction,
  retireUniversalContentAction,
} from './universal-content-actions'

const tx = {
  venue: { findFirst: vi.fn() },
  place: { findFirst: vi.fn() },
  contentModuleIdentity: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  contentModuleRevision: { create: vi.fn() },
  contentModuleEvidence: { createMany: vi.fn() },
  itemContent: { create: vi.fn() },
  serviceContent: { create: vi.fn() },
  policyContent: { create: vi.fn() },
  eventContent: { create: vi.fn() },
  operationalFactContent: { create: vi.fn() },
  relationshipContent: { create: vi.fn() },
  auditLog: { create: vi.fn() },
}
const client = { $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)) }
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const evidence = [
  {
    sourceId: 'staff-interview-8',
    locator: 'answer:12',
    capturedAt: '2026-08-11T15:00:00.000Z',
    excerptHash: 'a'.repeat(64),
  },
]

describe('universal content domain actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tx.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    tx.contentModuleIdentity.create.mockResolvedValue({ id: 'module-1' })
    tx.contentModuleRevision.create.mockResolvedValue({ id: 'revision-1' })
    tx.contentModuleEvidence.createMany.mockResolvedValue({ count: 1 })
    tx.serviceContent.create.mockResolvedValue({ revisionId: 'revision-1' })
    tx.itemContent.create.mockResolvedValue({ revisionId: 'revision-1' })
    audit.mockResolvedValue(undefined)
  })

  it('creates one stable identity and first immutable typed revision with strict audit', async () => {
    const result = await createUniversalContentAction({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: '4e3bd2b3-73b4-40a2-8791-6cce8fcf2a49',
      actor,
      draft: {
        audience: 'OPERATOR',
        evidence,
        payload: { kind: 'SERVICE', name: 'Coat check', availability: 'Weekends' },
      },
    })

    expect(tx.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      select: { id: true },
    })
    expect(tx.contentModuleIdentity.create).toHaveBeenCalledWith({
      data: {
        id: '4e3bd2b3-73b4-40a2-8791-6cce8fcf2a49',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        kind: 'SERVICE',
      },
      select: { id: true },
    })
    expect(tx.contentModuleRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ moduleId: 'module-1', version: 1, createdBy: 'admin-1' }),
      }),
    )
    expect(tx.serviceContent.create).toHaveBeenCalledOnce()
    expect(tx.contentModuleEvidence.createMany).toHaveBeenCalledOnce()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'universal_content.created',
        afterState: expect.objectContaining({
          source: 'HUMAN_OPERATOR',
          publication: 'NOT_PUBLISHED',
        }),
      }),
      tx,
    )
    expect(result).toMatchObject({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
      preview: { guestVisible: false, clientVisible: false, requiresExplicitPublication: true },
    })
  })

  it('turns a repeated durable creation key into a conflict instead of a second identity', async () => {
    client.$transaction.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      createUniversalContentAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: '4e3bd2b3-73b4-40a2-8791-6cce8fcf2a49',
        actor,
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: { kind: 'SERVICE', name: 'Coat check' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('refresh before retrying'),
    })
  })

  it('fails the action when the strict in-transaction audit cannot be written', async () => {
    audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      createUniversalContentAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: '7aac469a-3274-41bd-b397-c23620723162',
        actor,
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: { kind: 'SERVICE', name: 'Coat check' },
        },
      }),
    ).rejects.toThrow('audit unavailable')
  })

  it('rejects stale latest-version CAS before writing a revision or audit', async () => {
    tx.contentModuleIdentity.findFirst.mockResolvedValue({
      id: 'module-1',
      kind: 'POLICY',
      revisions: [{ version: 4 }],
    })
    await expect(
      addUniversalContentRevisionAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        expectedLatestVersion: 3,
        actor,
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: [] },
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('persists policy, event, and relationship payloads only in their typed tables', async () => {
    tx.contentModuleIdentity.findMany.mockResolvedValue([
      { id: 'endpoint-a' },
      { id: 'endpoint-b' },
    ])
    const cases: Array<[GeneralizedContentPayload, string]> = [
      [
        { kind: 'POLICY', title: 'Bags', rule: 'Small bags only.', appliesTo: ['visitors'] },
        '137c3504-8e5a-4f43-9271-dc51e4e47dad',
      ],
      [
        {
          kind: 'EVENT',
          name: 'Late opening',
          startsAt: '2026-08-12T15:00:00.000Z',
          endsAt: '2026-08-12T16:00:00.000Z',
        },
        '7aac469a-3274-41bd-b397-c23620723162',
      ],
      [
        {
          kind: 'RELATIONSHIP',
          fromModuleId: 'endpoint-a',
          toModuleId: 'endpoint-b',
          relationshipType: 'NEAR',
        },
        '3bfcf5db-f1bb-49bd-b1cc-e4aca0fc7bfa',
      ],
    ]
    for (const [payload, moduleId] of cases) {
      await createUniversalContentAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId,
        actor,
        draft: { audience: 'OPERATOR', evidence: [], payload },
      })
    }
    expect(tx.policyContent.create).toHaveBeenCalledOnce()
    expect(tx.eventContent.create).toHaveBeenCalledOnce()
    expect(tx.relationshipContent.create).toHaveBeenCalledOnce()
  })

  it('creates a typed ITEM revision only after exact-scoped optional Place validation', async () => {
    tx.place.findFirst.mockResolvedValue({ id: 'place-1' })
    const result = await createUniversalContentAction({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: '46be4d80-c74d-4f31-83b5-f5ffdf470748',
      actor,
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: {
          kind: 'ITEM',
          name: 'Apollo guidance computer',
          description: 'A preserved flight computer.',
          placeId: 'place-1',
          itemType: 'artifact',
        },
      },
    })

    expect(tx.place.findFirst).toHaveBeenCalledWith({
      where: { id: 'place-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      select: { id: true },
    })
    expect(tx.itemContent.create).toHaveBeenCalledWith({
      data: {
        revisionId: 'revision-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        name: 'Apollo guidance computer',
        description: 'A preserved flight computer.',
        placeId: 'place-1',
        itemType: 'artifact',
      },
    })
    expect(result.kind).toBe('ITEM')
  })

  it('rejects an ITEM Place outside exact scope before revision or audit writes', async () => {
    tx.place.findFirst.mockResolvedValue(null)
    await expect(
      createUniversalContentAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: '46be4d80-c74d-4f31-83b5-f5ffdf470748',
        actor,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'ITEM',
            name: 'Apollo guidance computer',
            placeId: 'foreign-place',
            itemType: 'artifact',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(tx.itemContent.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('rejects relationship endpoints unless both belong to the exact tenant and venue', async () => {
    tx.contentModuleIdentity.findMany.mockResolvedValue([{ id: 'module-a' }])
    await expect(
      createUniversalContentAction({
        db: client as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: '3bfcf5db-f1bb-49bd-b1cc-e4aca0fc7bfa',
        actor,
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: {
            kind: 'RELATIONSHIP',
            fromModuleId: 'module-a',
            toModuleId: 'foreign-module',
            relationshipType: 'NEAR',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.contentModuleIdentity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
      }),
    )
    expect(tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('retires by appending a copied typed revision and never mutating or deleting history', async () => {
    tx.contentModuleIdentity.findFirst.mockResolvedValue({
      id: 'module-1',
      kind: 'OPERATIONAL_FACT',
      revisions: [
        {
          version: 2,
          audience: 'OPERATOR',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          service: null,
          policy: null,
          event: null,
          operationalFact: { label: 'Entrance', value: 'North door', expiresAt: null },
          relationship: null,
        },
      ],
    })
    tx.operationalFactContent.create.mockResolvedValue({ revisionId: 'revision-1' })

    const result = await retireUniversalContentAction({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: 'module-1',
      expectedLatestVersion: 2,
      effectiveUntil: '2026-12-01T00:00:00.000Z',
      evidence: [],
      actor,
    })

    expect(result.version).toBe(3)
    expect(tx.contentModuleRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 3,
          effectiveUntil: new Date('2026-12-01T00:00:00.000Z'),
        }),
      }),
    )
    expect(tx.operationalFactContent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ label: 'Entrance' }) }),
    )
    expect(tx.contentModuleIdentity).not.toHaveProperty('update')
    expect(tx.contentModuleRevision).not.toHaveProperty('update')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'universal_content.retired' }),
      tx,
    )
  })

  it('retires ITEM by copying its exact typed payload into a new immutable revision', async () => {
    tx.place.findFirst.mockResolvedValue({ id: 'place-1' })
    tx.contentModuleIdentity.findFirst.mockResolvedValue({
      id: 'item-1',
      kind: 'ITEM',
      revisions: [
        {
          version: 4,
          audience: 'PUBLIC',
          effectiveFrom: null,
          item: {
            name: 'Apollo guidance computer',
            description: 'A preserved flight computer.',
            placeId: 'place-1',
            itemType: 'artifact',
          },
          service: null,
          policy: null,
          event: null,
          operationalFact: null,
          relationship: null,
        },
      ],
    })

    await retireUniversalContentAction({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      moduleId: 'item-1',
      expectedLatestVersion: 4,
      effectiveUntil: '2026-12-01T00:00:00.000Z',
      evidence: [],
      actor,
    })

    expect(tx.itemContent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Apollo guidance computer',
        description: 'A preserved flight computer.',
        placeId: 'place-1',
        itemType: 'artifact',
      }),
    })
  })

  it('previews lifecycle while keeping every audience unpublished', () => {
    expect(
      buildUniversalContentPreview(
        {
          audience: 'PUBLIC',
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveUntil: null,
        },
        new Date('2026-08-11T00:00:00.000Z'),
      ),
    ).toEqual({
      lifecycle: 'SCHEDULED',
      audience: 'PUBLIC',
      guestVisible: false,
      clientVisible: false,
      requiresExplicitPublication: true,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveUntil: null,
    })
  })
})
