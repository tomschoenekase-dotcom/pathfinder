import { TRPCError } from '@trpc/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', () => ({
  db: {},
  withTenantIsolationBypass: async <T>(fn: () => Promise<T>) => fn(),
  writeAuditLog: vi.fn(),
}))

vi.mock('@pathfinder/jobs', () => ({
  enqueueMediaIngestion: vi.fn(),
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { mediaIngestionRouter } from './media-ingestion'

const testRouter = router({ mediaIngestion: mediaIngestionRouter })

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'user_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('media ingestion router', () => {
  it('rejects all access for non-platform admins', async () => {
    const caller = testRouter.createCaller(context(false))
    await expect(
      caller.mediaIngestion.list({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
  })

  it('rejects archives larger than 5 GB before touching storage', async () => {
    const caller = testRouter.createCaller(context(true))
    await expect(
      caller.mediaIngestion.beginUpload({
        tenantId: 'tenant_1',
        projectId: 'project_1',
        filename: 'visit.zip',
        bytes: 5 * 1024 * 1024 * 1024 + 1,
        contentType: 'application/zip',
      }),
    ).rejects.toThrow()
  })
})
