import { describe, expect, it } from 'vitest'

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAiWorkloadConfigurationRouter } from './ai-workload-configuration'

const app = router({ admin: adminAiWorkloadConfigurationRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {
      venue: {
        findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
          where.id === 'venue_missing' ? null : { id: where.id },
      },
    } as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin AI workload configuration read', () => {
  it('requires platform-admin authorization', async () => {
    await expect(
      app.createCaller(context(false)).admin.getVenueAiWorkloadConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('keeps the response scoped to the exact requested tenant and venue', async () => {
    const result = await app
      .createCaller(context(true))
      .admin.getVenueAiWorkloadConfiguration({ tenantId: 'tenant_1', venueId: 'venue_7' })

    expect(result.scope).toEqual({ tenantId: 'tenant_1', venueId: 'venue_7' })
    expect(result.workloads).toHaveLength(10)
    expect(result.workloads.every((workload) => workload.effectiveSource === 'PLATFORM')).toBe(true)
    expect(result.layers.filter((layer) => layer.availability === 'UNAVAILABLE')).toHaveLength(3)
  })

  it('rejects a venue that is not in the exact tenant and venue scope', async () => {
    await expect(
      app.createCaller(context(true)).admin.getVenueAiWorkloadConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_missing',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns read-only defaults without secret-shaped or fabricated override data', async () => {
    const result = await app
      .createCaller(context(true))
      .admin.getVenueAiWorkloadConfiguration({ tenantId: 'tenant_1', venueId: 'venue_1' })
    const serialized = JSON.stringify(result)

    expect(result.readOnly).toBe(true)
    expect(result.workloads.every((workload) => workload.fallback.enabled === false)).toBe(true)
    expect(result.workloads.every((workload) => workload.unsafeChangesEnabled === false)).toBe(true)
    expect(serialized).not.toMatch(/apiKey|credential|secret|endpoint|baseUrl/iu)
  })

  it('rejects extra input fields rather than accepting override data', async () => {
    await expect(
      app.createCaller(context(true)).admin.getVenueAiWorkloadConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        overrides: [],
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
