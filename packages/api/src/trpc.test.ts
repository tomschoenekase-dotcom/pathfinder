import { describe, expect, it } from 'vitest'
import { TRPCError } from '@trpc/server'

import { router } from './core'
import { adminProcedure, protectedProcedure, tenantProcedure } from './trpc'
import type { TRPCContext } from './context'

const baseContext = {
  db: {} as TRPCContext['db'],
  headers: new Headers(),
} satisfies Omit<TRPCContext, 'session'>

describe('tRPC base procedures', () => {
  it('protectedProcedure throws UNAUTHORIZED for anonymous sessions', async () => {
    const testRouter = router({
      me: protectedProcedure.query(() => 'ok'),
    })

    const caller = testRouter.createCaller({
      ...baseContext,
      session: {
        userId: null,
        activeTenantId: null,
        role: null,
        isPlatformAdmin: false,
      },
    })

    await expect(caller.me()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'UNAUTHORIZED',
      }),
    )
  })

  it('tenantProcedure throws UNAUTHORIZED for missing activeTenantId', async () => {
    const testRouter = router({
      tenantOnly: tenantProcedure.query(() => 'ok'),
    })

    const caller = testRouter.createCaller({
      ...baseContext,
      session: {
        userId: 'user_1',
        activeTenantId: null,
        role: null,
        isPlatformAdmin: false,
      },
    })

    await expect(caller.tenantOnly()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'UNAUTHORIZED',
      }),
    )
  })

  it('adminProcedure throws FORBIDDEN for non-admin sessions', async () => {
    const testRouter = router({
      adminOnly: adminProcedure.query(() => 'ok'),
    })

    const caller = testRouter.createCaller({
      ...baseContext,
      session: {
        userId: 'user_1',
        activeTenantId: 'tenant_1',
        role: 'OWNER',
        isPlatformAdmin: false,
      },
    })

    await expect(caller.adminOnly()).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'FORBIDDEN',
      }),
    )
  })
})
