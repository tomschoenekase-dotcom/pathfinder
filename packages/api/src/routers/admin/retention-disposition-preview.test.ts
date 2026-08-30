import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../../context'
import { router } from '../../core'

const { previewRetentionDispositionAction } = vi.hoisted(() => ({
  previewRetentionDispositionAction: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({ previewRetentionDispositionAction }))

import { adminRetentionDispositionPreviewRouter } from './retention-disposition-preview'

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: isPlatformAdmin ? 'platform-admin' : 'tenant-user',
      activeTenantId: 'session-tenant',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}

const testRouter = router({ admin: adminRetentionDispositionPreviewRouter })

describe('admin retention disposition preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    previewRetentionDispositionAction.mockResolvedValue({
      schemaVersion: 'torchiko-retention-disposition-preview-v1',
      mode: 'READ_ONLY_NO_EFFECT',
      tenantExists: true,
      blockers: ['UNRESOLVED_POLICY', 'NO_REVIEWED_EXECUTOR'],
      boundaries: { readyForExecution: false, destructiveActionAvailable: false },
    })
  })

  it('rejects a non-platform administrator before reading retention evidence', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.previewRetentionDisposition({
        tenantId: 'tenant-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(previewRetentionDispositionAction).not.toHaveBeenCalled()
  })

  it('returns a full-client, read-only preview without accepting policy or execution arguments', async () => {
    const result = await testRouter
      .createCaller(context())
      .admin.previewRetentionDisposition({ tenantId: ' tenant-1 ' })
    expect(previewRetentionDispositionAction).toHaveBeenCalledWith(
      { tenantId: 'tenant-1' },
      expect.anything(),
    )
    expect(result).toMatchObject({
      mode: 'READ_ONLY_NO_EFFECT',
      boundaries: { readyForExecution: false, destructiveActionAvailable: false },
    })
  })
})
