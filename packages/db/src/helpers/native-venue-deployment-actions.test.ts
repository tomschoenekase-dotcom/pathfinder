import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
/* eslint-disable @typescript-eslint/no-explicit-any -- lifecycle mocks exercise heterogeneous Prisma delegates. */

import {
  approveNativeVenueDeploymentAction,
  applyNativeVenueDeploymentAction,
  createNativeVenueDeploymentAction,
  NativeVenueDeploymentError,
  nativeVenueDeploymentTestHooks,
  projectNativeVenueStateAction,
  revertNativeVenueDeploymentAction,
} from './native-venue-deployment-actions'

function client(overrides: Record<string, unknown> = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    venue: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'venue-1',
        tenantId: 'tenant-1',
        name: 'Venue',
        slug: 'venue',
        description: null,
        guideNotes: null,
        aiGuideNotes: null,
        aiFeaturedPlaceId: null,
        aiTone: 'FRIENDLY',
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        aiGuideName: null,
        chatTheme: 'default',
        chatAccentColor: null,
        chatFont: 'jakarta',
        chatLogoUrl: null,
        chatBannerUrl: null,
        category: null,
        guideMode: 'location_aware',
        defaultCenterLat: null,
        defaultCenterLng: null,
        geoBoundary: null,
        isActive: true,
      }),
    },
    place: { findMany: vi.fn().mockResolvedValue([]) },
    venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
    contentModulePublication: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  }
  return { tx, db: { $transaction: vi.fn((fn) => fn(tx)) } }
}

describe('native venue deployment actions', () => {
  it('projects a complete bounded empty native state under the venue lock', async () => {
    const { db, tx } = client()
    const result = await projectNativeVenueStateAction(db, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(result.state.venue.name).toBe('Venue')
    expect(result.universe).toEqual({
      activePlaceIds: [],
      enabledKnowledgeEntryIds: [],
      publishedGeneralizedHeads: [],
    })
    expect(result.stateHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(tx.$executeRaw).toHaveBeenCalledOnce()
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    )
  })

  it('fails closed when the exact venue scope does not exist', async () => {
    const { db } = client({ venue: { findFirst: vi.fn().mockResolvedValue(null) } })
    await expect(
      projectNativeVenueStateAction(db, { tenantId: 'tenant-1', venueId: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<NativeVenueDeploymentError>)
  })

  it('fails closed when published native heads exceed the profile bound', async () => {
    const { db } = client({
      $queryRaw: vi
        .fn()
        .mockResolvedValue(Array.from({ length: 1_001 }, (_, index) => ({ id: `p-${index}` }))),
    })
    await expect(
      projectNativeVenueStateAction(db, { tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<NativeVenueDeploymentError>)
  })

  it('fails closed when universal ITEM is published because NATIVE_CORE_V1 stays empty-items', async () => {
    const { db } = client({
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'publication-item-1' }]),
      contentModulePublication: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'publication-item-1',
            moduleId: 'item-1',
            moduleKind: 'ITEM',
            revisionId: 'item-r1',
            action: 'PUBLISH',
            revision: { version: 1, audience: 'PUBLIC', evidence: [], item: {} },
          },
        ]),
      },
    })
    await expect(
      projectNativeVenueStateAction(db, { tenantId: 'tenant-1', venueId: 'venue-1' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Published ITEM content is outside NATIVE_CORE_V1.',
    } satisfies Partial<NativeVenueDeploymentError>)
  })

  it('approves with exact CAS and a durable produced snapshot', async () => {
    const now = new Date('2026-08-12T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const tx = {
      $executeRaw: vi.fn(),
      nativeVenueDeploymentCommand: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      nativeVenueDeploymentRelease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const db = { $transaction: vi.fn((fn) => fn(tx)) }
    const input = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedUpdatedAt: now.toISOString(),
      actor: { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'admin-1' },
    }
    const result = await approveNativeVenueDeploymentAction(input, db)
    expect(result).toMatchObject({ status: 'APPROVED', updatedAt: now.toISOString() })
    expect(tx.nativeVenueDeploymentRelease.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'DRAFT',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
        }),
      }),
    )
    expect(tx.nativeVenueDeploymentCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdAt: now, producedStatus: 'APPROVED' }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('returns exact command evidence on replay without new writes', async () => {
    const updatedAt = '2026-08-12T12:00:00.000Z'
    vi.useFakeTimers()
    vi.setSystemTime(new Date(updatedAt))
    const input = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      releaseId: '11111111-1111-4111-8111-111111111111',
      commandId: '22222222-2222-4222-8222-222222222222',
      expectedUpdatedAt: updatedAt,
      actor: { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'admin-1' },
    }
    const first = {
      $executeRaw: vi.fn(),
      nativeVenueDeploymentCommand: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      nativeVenueDeploymentRelease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    }
    await approveNativeVenueDeploymentAction(input, { $transaction: vi.fn((fn) => fn(first)) })
    const receipt = first.nativeVenueDeploymentCommand.create.mock.calls[0]?.[0].data
    const replay = {
      $executeRaw: vi.fn(),
      nativeVenueDeploymentCommand: { findFirst: vi.fn().mockResolvedValue(receipt) },
      nativeVenueDeploymentRelease: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    await expect(
      approveNativeVenueDeploymentAction(input, { $transaction: vi.fn((fn) => fn(replay)) }),
    ).resolves.toEqual(receipt.producedSnapshot)
    expect(replay.nativeVenueDeploymentRelease.updateMany).not.toHaveBeenCalled()
    expect(replay.auditLog.create).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('rejects blank human actor evidence before opening a transaction', async () => {
    const db = { $transaction: vi.fn() }
    await expect(
      createNativeVenueDeploymentAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          manifest: {},
          actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: ' ' },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('retries a bounded serialization loser and converges through the canonical action', async () => {
    const now = new Date('2026-08-12T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const tx = {
      $executeRaw: vi.fn(),
      nativeVenueDeploymentCommand: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      nativeVenueDeploymentRelease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn() },
    }
    const db = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce({ code: 'P2034' })
        .mockImplementation((fn) => fn(tx)),
    }
    await expect(
      approveNativeVenueDeploymentAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          releaseId: '11111111-1111-4111-8111-111111111111',
          commandId: '22222222-2222-4222-8222-222222222222',
          expectedUpdatedAt: now.toISOString(),
          actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
        },
        db,
      ),
    ).resolves.toMatchObject({ status: 'APPROVED' })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('applies an exact zero-effect plan and advances the native head atomically', async () => {
    const { db, tx } = client()
    const projected = await projectNativeVenueStateAction(db, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    const now = new Date('2026-08-12T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    Object.assign(tx, {
      nativeVenueDeploymentCommand: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
      nativeVenueDeploymentRelease: {
        findFirst: vi.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          artifactId: '11111111-1111-4111-8111-111111111111',
          manifestHash: 'a'.repeat(64),
          baseStateHash: projected.stateHash,
          desiredStateHash: projected.stateHash,
          replacementUniverse: projected.universe,
          plan: {
            before: projected.state,
            desired: projected.state,
            priorHead: {
              releaseId: 'prior-release',
              artifactId: 'prior-artifact',
              manifestHash: 'b'.repeat(64),
              stateHash: projected.stateHash,
              revision: 7,
              updatedAt: now.toISOString(),
            },
            hiddenPlaces: {},
            hiddenKnowledge: {},
            effects: [],
          },
        }),
        update: vi.fn(),
      },
      nativeVenueDeploymentEffect: { create: vi.fn() },
      nativeVenueDeploymentHead: {
        upsert: vi.fn().mockResolvedValue({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          releaseId: '11111111-1111-4111-8111-111111111111',
          artifactId: '11111111-1111-4111-8111-111111111111',
          manifestHash: 'a'.repeat(64),
          stateHash: projected.stateHash,
          revision: 8,
          updatedAt: now,
        }),
      },
      auditLog: { create: vi.fn() },
    })
    const lifecycleTx = tx as typeof tx & {
      nativeVenueDeploymentEffect: { create: ReturnType<typeof vi.fn> }
      nativeVenueDeploymentHead: { upsert: ReturnType<typeof vi.fn> }
    }
    const result = await applyNativeVenueDeploymentAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId: '11111111-1111-4111-8111-111111111111',
        commandId: '22222222-2222-4222-8222-222222222222',
        expectedUpdatedAt: now.toISOString(),
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
      },
      db,
    )
    expect(result).toMatchObject({ status: 'APPLIED', effectCount: 0, head: { revision: 8 } })
    expect(lifecycleTx.nativeVenueDeploymentEffect.create).not.toHaveBeenCalled()
    expect(lifecycleTx.nativeVenueDeploymentHead.upsert).toHaveBeenCalledOnce()
    expect(lifecycleTx.nativeVenueDeploymentHead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          releaseId: '11111111-1111-4111-8111-111111111111',
          revision: 8,
        }),
      }),
    )
    vi.useRealTimers()
  })

  it('reverts only the current exact head and removes a first native head', async () => {
    const { db, tx } = client()
    const projected = await projectNativeVenueStateAction(db, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    const now = new Date('2026-08-12T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const releaseId = '11111111-1111-4111-8111-111111111111'
    Object.assign(tx, {
      nativeVenueDeploymentCommand: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ producedSnapshot: { appliedUniverse: projected.universe } }),
        create: vi.fn(),
      },
      nativeVenueDeploymentRelease: {
        findFirst: vi.fn().mockResolvedValue({
          id: releaseId,
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          artifactId: releaseId,
          manifestHash: 'a'.repeat(64),
          baseStateHash: projected.stateHash,
          desiredStateHash: projected.stateHash,
          plan: {
            before: projected.state,
            desired: projected.state,
            priorHead: null,
            hiddenPlaces: {},
            hiddenKnowledge: {},
            effects: [],
          },
        }),
        update: vi.fn(),
      },
      nativeVenueDeploymentEffect: { findMany: vi.fn().mockResolvedValue([]) },
      nativeVenueDeploymentHead: {
        findFirst: vi.fn().mockResolvedValue({
          releaseId,
          artifactId: releaseId,
          stateHash: projected.stateHash,
          revision: 1,
        }),
        delete: vi.fn(),
        update: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    })
    const lifecycleTx = tx as typeof tx & {
      nativeVenueDeploymentHead: {
        delete: ReturnType<typeof vi.fn>
        update: ReturnType<typeof vi.fn>
      }
    }
    const result = await revertNativeVenueDeploymentAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId,
        commandId: '22222222-2222-4222-8222-222222222222',
        expectedUpdatedAt: now.toISOString(),
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
      },
      db,
    )
    expect(result).toMatchObject({
      status: 'REVERTED',
      restoredStateHash: projected.stateHash,
      head: null,
    })
    expect(lifecycleTx.nativeVenueDeploymentHead.delete).toHaveBeenCalledOnce()
    expect(lifecycleTx.nativeVenueDeploymentHead.update).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('plans distinct immutable revision and publication effects with hidden-state restoration', () => {
    const venue = {
      name: 'Venue',
      slug: 'venue',
      description: null,
      guideNotes: null,
      aiGuideNotes: null,
      aiFeaturedPlaceId: null,
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      category: null,
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      geoBoundary: null,
      isActive: true,
    }
    const fact = {
      moduleId: 'module-1',
      kind: 'OPERATIONAL_FACT' as const,
      version: 1,
      revisionId: 'revision-1',
      audience: 'PUBLIC' as const,
      effectiveFrom: null,
      effectiveUntil: null,
      evidence: [],
      payload: { kind: 'OPERATIONAL_FACT' as const, label: 'Open', value: 'Yes', expiresAt: null },
      publication: { status: 'PUBLISHED' as const, revisionId: 'revision-1' },
    }
    const before = { venue, places: [], knowledgeEntries: [], generalizedModules: [] }
    const desired = {
      venue: { ...venue, aiFeaturedPlaceId: 'place-1' },
      places: [
        {
          id: 'place-1',
          name: 'Cafe',
          type: 'CAFE',
          itemType: null,
          shortDescription: null,
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 1,
          areaName: null,
          hours: null,
          photoUrl: null,
          isActive: true as const,
          sourceType: 'HUMAN',
          authorship: 'ADMIN',
          sourceName: null,
          sourceUrl: null,
          importedAt: null,
          humanConfirmedAt: null,
          humanConfirmedBy: null,
          lastReviewedAt: null,
          lastReviewedBy: null,
          sourcePackageId: null,
        },
      ],
      knowledgeEntries: [],
      generalizedModules: [fact],
    }
    const hidden = { 'place-1': { id: 'place-1', isActive: false, name: 'Old' } }
    const effects = nativeVenueDeploymentTestHooks.plannedEffects(
      'venue-1',
      before,
      desired,
      hidden,
      {},
    )
    expect(
      effects.map(({ effectOrder, kind, targetId }) => ({ effectOrder, kind, targetId })),
    ).toEqual([
      { effectOrder: 1, kind: 'VENUE', targetId: 'venue-1' },
      { effectOrder: 2, kind: 'PLACE', targetId: 'place-1' },
      { effectOrder: 3, kind: 'GENERALIZED_MODULE', targetId: 'module-1' },
      { effectOrder: 4, kind: 'GENERALIZED_PUBLICATION', targetId: 'module-1' },
    ])
    expect(effects[1]?.beforeState).toEqual({
      present: true,
      value: { runtimeVisible: false, row: hidden['place-1'] },
    })
    expect(effects[3]?.afterState).toMatchObject({
      present: true,
      value: { revisionId: 'revision-1' },
    })
  })

  it('revert ignores immutable module effects and writes exactly one inverse publication lineage', async () => {
    const { db, tx } = client()
    const projected = await projectNativeVenueStateAction(db, {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    const now = new Date('2026-08-12T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const releaseId = '11111111-1111-4111-8111-111111111111'
    const module = { moduleId: 'module-1', kind: 'OPERATIONAL_FACT', revisionId: 'revision-1' }
    const moduleEffect: any = {
      id: '33333333-3333-4333-8333-333333333333',
      effectOrder: 1,
      kind: 'GENERALIZED_MODULE',
      targetId: 'module-1',
      beforeState: { present: false, value: null },
      afterState: { present: true, value: module },
    }
    const publicationEffect = {
      ...moduleEffect,
      id: '44444444-4444-4444-8444-444444444444',
      effectOrder: 2,
      kind: 'GENERALIZED_PUBLICATION',
    }
    const hash = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex')
    for (const effect of [moduleEffect, publicationEffect])
      Object.assign(effect, {
        beforeHash: hash(effect.beforeState),
        afterHash: hash(effect.afterState),
      })
    const plan = {
      before: projected.state,
      desired: projected.state,
      priorHead: null,
      hiddenPlaces: {},
      hiddenKnowledge: {},
      effects: [moduleEffect, publicationEffect].map(
        ({ effectOrder, kind, targetId, beforeHash, afterHash, beforeState, afterState }) => ({
          effectOrder,
          kind,
          targetId,
          beforeHash,
          afterHash,
          beforeState,
          afterState,
        }),
      ),
    }
    Object.assign(tx, {
      nativeVenueDeploymentCommand: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ producedSnapshot: { appliedUniverse: projected.universe } }),
        create: vi.fn(),
      },
      nativeVenueDeploymentRelease: {
        findFirst: vi.fn().mockResolvedValue({
          id: releaseId,
          artifactId: releaseId,
          manifestHash: 'a'.repeat(64),
          baseStateHash: projected.stateHash,
          desiredStateHash: projected.stateHash,
          appliedCommandId: 'apply',
          plan,
        }),
        update: vi.fn(),
      },
      nativeVenueDeploymentEffect: {
        findMany: vi.fn().mockResolvedValue([publicationEffect, moduleEffect]),
      },
      nativeVenueDeploymentHead: {
        findFirst: vi.fn().mockResolvedValue({
          releaseId,
          artifactId: releaseId,
          stateHash: projected.stateHash,
          revision: 1,
        }),
        delete: vi.fn(),
        update: vi.fn(),
      },
      contentModulePublication: {
        ...tx.contentModulePublication,
        create: vi.fn().mockResolvedValue({ id: 'inverse-1' }),
      },
      nativeVenueDeploymentPublicationLineage: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    })
    await revertNativeVenueDeploymentAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId,
        commandId: '22222222-2222-4222-8222-222222222222',
        expectedUpdatedAt: now.toISOString(),
        actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: 'admin-1' },
      },
      db,
    )
    expect((tx as any).contentModulePublication.create).toHaveBeenCalledOnce()
    expect((tx as any).nativeVenueDeploymentPublicationLineage.create).toHaveBeenCalledOnce()
    expect(
      (tx as any).nativeVenueDeploymentCommand.create.mock.invocationCallOrder[0],
    ).toBeLessThan((tx as any).nativeVenueDeploymentHead.delete.mock.invocationCallOrder[0])
    vi.useRealTimers()
  })

  it('materializes nonzero generalized effects with identities before revisions and exact publication lineage', async () => {
    const venue = {
      name: 'Venue',
      slug: 'venue',
      description: null,
      guideNotes: null,
      aiGuideNotes: null,
      aiFeaturedPlaceId: null,
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      category: null,
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      geoBoundary: null,
      isActive: true,
    }
    const endpoint = (id: string) => ({
      moduleId: id,
      kind: 'OPERATIONAL_FACT' as const,
      version: 1,
      revisionId: `${id}-revision`,
      audience: 'PUBLIC' as const,
      effectiveFrom: null,
      effectiveUntil: null,
      evidence: [],
      payload: { kind: 'OPERATIONAL_FACT' as const, label: id, value: 'yes', expiresAt: null },
      publication: { status: 'PUBLISHED' as const, revisionId: `${id}-revision` },
    })
    const relationship = {
      moduleId: 'a-relationship',
      kind: 'RELATIONSHIP' as const,
      version: 1,
      revisionId: 'relationship-revision',
      audience: 'PUBLIC' as const,
      effectiveFrom: null,
      effectiveUntil: null,
      evidence: [],
      payload: {
        kind: 'RELATIONSHIP' as const,
        fromModuleId: 'z-one',
        toModuleId: 'z-two',
        relationshipType: 'RELATED',
        description: null,
      },
      publication: { status: 'PUBLISHED' as const, revisionId: 'relationship-revision' },
    }
    const before = { venue, places: [], knowledgeEntries: [], generalizedModules: [] }
    const desired = {
      venue,
      places: [],
      knowledgeEntries: [],
      generalizedModules: [relationship, endpoint('z-one'), endpoint('z-two')],
    }
    const effects = nativeVenueDeploymentTestHooks.plannedEffects(
      'venue-1',
      before,
      desired,
      {},
      {},
    )
    const calls: string[] = []
    let effectIndex = 0
    let publicationIndex = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = {
      contentModuleIdentity: {
        upsert: vi.fn(async ({ create }) => {
          calls.push(`identity:${create.id}`)
        }),
      },
      contentModuleRevision: {
        create: vi.fn(async ({ data }) => {
          calls.push(`revision:${data.moduleId}`)
        }),
      },
      contentModuleEvidence: { createMany: vi.fn() },
      relationshipContent: { create: vi.fn() },
      operationalFactContent: { create: vi.fn() },
      nativeVenueDeploymentEffect: {
        create: vi.fn(async () => ({ id: `effect-${++effectIndex}` })),
      },
      contentModulePublication: {
        create: vi.fn(async ({ data }) => ({ id: `publication-${++publicationIndex}`, ...data })),
      },
      nativeVenueDeploymentPublicationLineage: { create: vi.fn() },
    }
    const count = await nativeVenueDeploymentTestHooks.applyVisibleState(
      tx,
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        releaseId: '11111111-1111-4111-8111-111111111111',
        plan: { before, desired, priorHead: null, hiddenPlaces: {}, hiddenKnowledge: {}, effects },
      },
      before,
      desired,
      'admin-1',
    )
    expect(count).toBe(6)
    expect(tx.nativeVenueDeploymentPublicationLineage.create).toHaveBeenCalledTimes(3)
    expect(calls.slice(0, 3)).toEqual([
      'identity:a-relationship',
      'identity:z-one',
      'identity:z-two',
    ])
    expect(calls.indexOf('revision:a-relationship')).toBeGreaterThan(2)
    expect(
      tx.nativeVenueDeploymentEffect.create.mock.calls.map(
        (call: unknown[]) => (call[0] as { data: { kind: string } }).data.kind,
      ),
    ).toEqual([
      'GENERALIZED_MODULE',
      'GENERALIZED_PUBLICATION',
      'GENERALIZED_MODULE',
      'GENERALIZED_PUBLICATION',
      'GENERALIZED_MODULE',
      'GENERALIZED_PUBLICATION',
    ])
  })
})
