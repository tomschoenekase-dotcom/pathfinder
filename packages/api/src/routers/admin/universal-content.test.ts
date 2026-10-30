import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminUniversalContentRouter } from './universal-content'

const venueFindFirst = vi.fn()
const placeFindFirst = vi.fn()
const placeFindMany = vi.fn()
const identityFindMany = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  place: { findFirst: placeFindFirst, findMany: placeFindMany },
  contentModuleIdentity: { findMany: identityFindMany },
} as unknown as TRPCContext['db']

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'admin', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

const testRouter = router({ content: adminUniversalContentRouter })
const originalGeneralizedContentFlag = process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED

describe('admin universal content reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-1' })
    identityFindMany.mockResolvedValue([])
    delete process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED
  })

  afterEach(() => {
    if (originalGeneralizedContentFlag === undefined) {
      delete process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED
    } else {
      process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED = originalGeneralizedContentFlag
    }
  })

  it('blocks non-admin callers before database access', async () => {
    await expect(
      testRouter
        .createCaller(context(false))
        .content.listUniversalContent({ tenantId: 't1', venueId: 'v1' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a venue outside the exact tenant scope', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      testRouter
        .createCaller(context())
        .content.listUniversalContent({ tenantId: 'tenant-a', venueId: 'venue-b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-b', tenantId: 'tenant-a' },
      select: { id: true },
    })
    expect(identityFindMany).not.toHaveBeenCalled()
  })

  it('pins the module query to tenant, venue, and a strict kind with bounded selects', async () => {
    await testRouter
      .createCaller(context())
      .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'POLICY' })
    expect(identityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', venueId: 'v1', kind: 'POLICY' },
        take: 51,
        select: expect.objectContaining({ id: true, kind: true, revisions: expect.any(Object) }),
      }),
    )
    expect(identityFindMany.mock.calls[0]?.[0]?.select).not.toHaveProperty('tenant')
  })

  it('accepts ITEM as a bounded filter and selects only its safe typed fields', async () => {
    const result = await testRouter
      .createCaller(context())
      .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'ITEM' })
    const query = identityFindMany.mock.calls[0]?.[0]
    expect(query.where).toEqual({ tenantId: 't1', venueId: 'v1', kind: 'ITEM' })
    expect(query.select.revisions.select.item).toEqual({
      select: { name: true, description: true, placeId: true, itemType: true },
    })
    expect(JSON.stringify(query.select)).not.toContain('internalNotes')
    expect(result.itemDisposition).toEqual({
      guestPublication: 'DISABLED_BY_CAPABILITY',
      nativeCoreV1Materialization: 'UNSUPPORTED_REQUIRES_WITHDRAWAL',
    })
  })

  it('exposes the stored declaration when reviewing an operational fact revision', async () => {
    await testRouter
      .createCaller(context())
      .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'OPERATIONAL_FACT' })
    expect(identityFindMany.mock.calls[0]?.[0].select.revisions.select.operationalFact).toEqual({
      select: {
        label: true,
        value: true,
        expiresAt: true,
        applicabilityScope: true,
        applicabilitySubjectModuleIds: true,
        applicabilityPlaceIds: true,
      },
    })
  })

  it('derives ITEM guest support from the server capability and keeps explicit publication', async () => {
    process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED = 'true'
    const result = await testRouter
      .createCaller(context())
      .content.listUniversalContent({ tenantId: 't1', venueId: 'v1', kind: 'ITEM' })
    expect(result.authoringEnabled).toBe(true)
    expect(result.itemDisposition).toEqual({
      guestPublication: 'SUPPORTED_ONLY_AFTER_EXPLICIT_PUBLICATION',
      nativeCoreV1Materialization: 'UNSUPPORTED_REQUIRES_WITHDRAWAL',
    })
  })

  it('rejects unknown module kinds before database access', async () => {
    await expect(
      testRouter.createCaller(context()).content.listUniversalContent({
        tenantId: 't1',
        venueId: 'v1',
        kind: 'PLACE' as 'SERVICE',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('validates a scoped human draft while explicitly previewing no publication', async () => {
    const result = await testRouter.createCaller(context()).content.previewUniversalContent({
      tenantId: 't1',
      venueId: 'v1',
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: { kind: 'SERVICE', name: 'Coat check' },
      },
    })
    expect(result).toMatchObject({
      valid: true,
      authoringEnabled: false,
      preview: {
        audience: 'PUBLIC',
        guestVisible: false,
        clientVisible: false,
        requiresExplicitPublication: true,
      },
    })
  })

  it.each(['valid', 'missing', 'wrong-kind', 'foreign-tenant', 'foreign-venue', 'foreign-place'])(
    'checks %s fact applicability targets before declaring a preview valid',
    async (scenario) => {
      const subject = {
        id: 'subject-1',
        tenantId: scenario === 'foreign-tenant' ? 't2' : 't1',
        venueId: scenario === 'foreign-venue' ? 'v2' : 'v1',
        kind: scenario === 'wrong-kind' ? 'POLICY' : 'SERVICE',
      }
      identityFindMany.mockImplementation(async ({ where }) =>
        scenario !== 'missing' &&
        where.tenantId === subject.tenantId &&
        where.venueId === subject.venueId &&
        where.id.in.includes(subject.id) &&
        where.kind.in.includes(subject.kind)
          ? [{ id: subject.id }]
          : [],
      )
      placeFindMany.mockImplementation(async ({ where }) =>
        where.tenantId === 't1' &&
        where.venueId === (scenario === 'foreign-place' ? 'v2' : 'v1') &&
        where.id.in.includes('place-1')
          ? [{ id: 'place-1' }]
          : [],
      )
      const result = testRouter.createCaller(context()).content.previewUniversalContent({
        tenantId: 't1',
        venueId: 'v1',
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'OPERATIONAL_FACT',
            label: 'Entry',
            value: 'North door',
            applicability: {
              scope: 'SUBJECTS',
              subjectModuleIds: ['subject-1'],
              placeIds: ['place-1'],
            },
          },
        },
      })
      if (scenario === 'valid') await expect(result).resolves.toMatchObject({ valid: true })
      else await expect(result).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      expect(identityFindMany).toHaveBeenCalledWith({
        where: {
          tenantId: 't1',
          venueId: 'v1',
          id: { in: ['subject-1'] },
          kind: { in: ['SERVICE', 'ITEM', 'EVENT'] },
        },
        select: { id: true },
      })
      expect(placeFindMany).toHaveBeenCalledWith({
        where: {
          tenantId: 't1',
          venueId: 'v1',
          id: { in: ['place-1'] },
        },
        select: { id: true },
      })
    },
  )

  it('validates ITEM authoring while keeping guest publication explicit', async () => {
    placeFindFirst.mockResolvedValue({ id: 'place-1' })
    const result = await testRouter.createCaller(context()).content.previewUniversalContent({
      tenantId: 't1',
      venueId: 'v1',
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: {
          kind: 'ITEM',
          name: 'Apollo guidance computer',
          placeId: 'place-1',
          itemType: 'artifact',
        },
      },
    })
    expect(result).toMatchObject({
      valid: true,
      preview: { guestVisible: false, requiresExplicitPublication: true },
    })
  })

  it('rejects a cross-scope ITEM Place before presenting a valid preview', async () => {
    placeFindFirst.mockResolvedValue(null)
    await expect(
      testRouter.createCaller(context()).content.previewUniversalContent({
        tenantId: 't1',
        venueId: 'v1',
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
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(placeFindFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-place', tenantId: 't1', venueId: 'v1' },
      select: { id: true },
    })
  })

  it('keeps generalized content mutations default-off before any transaction starts', async () => {
    await expect(
      testRouter.createCaller(context()).content.createUniversalContent({
        tenantId: 't1',
        venueId: 'v1',
        moduleId: '137c3504-8e5a-4f43-9271-dc51e4e47dad',
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: { kind: 'OPERATIONAL_FACT', label: 'Entry', value: 'North door' },
        },
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('blocks non-admin authors before evaluating the feature flag or scope', async () => {
    await expect(
      testRouter.createCaller(context(false)).content.createUniversalContent({
        tenantId: 't1',
        venueId: 'v1',
        moduleId: '137c3504-8e5a-4f43-9271-dc51e4e47dad',
        draft: {
          audience: 'OPERATOR',
          evidence: [],
          payload: { kind: 'OPERATIONAL_FACT', label: 'Entry', value: 'North door' },
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })
})

describe('admin universal content publication adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GENERALIZED_CONTENT_CAPABILITIES_ENABLED = 'true'
  })

  it('keeps explicit publication behind admin auth and the server capability flag', async () => {
    await expect(
      testRouter.createCaller(context(false)).content.publishUniversalContent({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        moduleId: 'module-1',
        revisionId: 'revision-1',
        expectedLatestVersion: 1,
        requestId: '35a7173c-b42b-485b-8885-81355585489e',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
