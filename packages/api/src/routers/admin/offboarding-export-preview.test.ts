import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminOffboardingExportPreviewRouter } from './offboarding-export-preview'

const venueFindMany = vi.fn()
const emptyFindMany = vi.fn().mockResolvedValue([])
const zeroCount = vi.fn().mockResolvedValue(0)
const db = {
  venue: { findMany: venueFindMany },
  place: { findMany: emptyFindMany, count: zeroCount },
  venueKnowledgeEntry: { findMany: emptyFindMany, count: zeroCount },
  contentVersion: { findMany: emptyFindMany, count: zeroCount },
  venuePackage: { findMany: emptyFindMany, count: zeroCount },
  contentModuleIdentity: { findMany: emptyFindMany, count: zeroCount },
  contentModuleRevision: { findMany: emptyFindMany, count: zeroCount },
  contentModuleEvidence: { findMany: emptyFindMany, count: zeroCount },
} as unknown as TRPCContext['db']
const testRouter = router({ admin: adminOffboardingExportPreviewRouter })
function context(isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'u1', activeTenantId: 'session-tenant', role: 'OWNER', isPlatformAdmin },
  }
}

describe('offboarding export manifest preview API', () => {
  it('rejects non-admin access before reads', async () => {
    venueFindMany.mockClear()
    await expect(
      testRouter
        .createCaller(context(false))
        .admin.previewOffboardingExportManifest({
          tenantId: 'tenant-target',
          venueIds: ['venue-1'],
        }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindMany).not.toHaveBeenCalled()
  })

  it('rejects a cross-tenant or missing selected venue', async () => {
    venueFindMany.mockResolvedValueOnce([])
    await expect(
      testRouter
        .createCaller(context())
        .admin.previewOffboardingExportManifest({
          tenantId: 'tenant-target',
          venueIds: ['venue-other'],
        }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(venueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-target', id: { in: ['venue-other'] } },
      }),
    )
  })

  it('returns bounded metadata only with explicit truncation evidence', async () => {
    venueFindMany.mockResolvedValueOnce([
      {
        id: 'venue-1',
        name: 'Museum',
        slug: 'museum',
        isActive: true,
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        updatedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .admin.previewOffboardingExportManifest({ tenantId: 'tenant-target', venueIds: ['venue-1'] })
    expect(result.privacyBoundary).toBe('METADATA_REFERENCES_ONLY')
    expect(result.truncation.packages).toEqual({
      returned: 0,
      available: 0,
      cap: 250,
      truncated: false,
    })
    for (const call of emptyFindMany.mock.calls) {
      const serialized = JSON.stringify(call[0])
      expect(serialized).not.toMatch(
        /"(payload|beforeState|afterState|body|content|supportMessages|messages|secret|asset)":/i,
      )
    }
    expect(
      emptyFindMany.mock.calls.some(([args]) =>
        JSON.stringify(args).includes('"audience":{"in":["PUBLIC","CLIENT"]}'),
      ),
    ).toBe(true)
  })
})
