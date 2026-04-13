import { describe, expect, it } from 'vitest'
import { TRPCError } from '@trpc/server'

import { requirePlatformAdmin, requireTenantRole } from './permissions'
import type { SessionContext } from './session'

function createSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    userId: 'user_1',
    activeTenantId: 'tenant_1',
    role: 'STAFF',
    isPlatformAdmin: false,
    ...overrides,
  }
}

describe('requireTenantRole', () => {
  it('allows STAFF access to STAFF routes', () => {
    const ctx = createSessionContext({ role: 'STAFF' })

    expect(() => requireTenantRole(ctx, 'STAFF')).not.toThrow()
  })

  it('rejects STAFF access to MANAGER routes', () => {
    const ctx = createSessionContext({ role: 'STAFF' })

    expect(() => requireTenantRole(ctx, 'MANAGER')).toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'FORBIDDEN',
      }),
    )
  })

  it('allows MANAGER access to STAFF routes', () => {
    const ctx = createSessionContext({ role: 'MANAGER' })

    expect(() => requireTenantRole(ctx, 'STAFF')).not.toThrow()
  })

  it('allows MANAGER access to MANAGER routes', () => {
    const ctx = createSessionContext({ role: 'MANAGER' })

    expect(() => requireTenantRole(ctx, 'MANAGER')).not.toThrow()
  })

  it('rejects MANAGER access to OWNER routes', () => {
    const ctx = createSessionContext({ role: 'MANAGER' })

    expect(() => requireTenantRole(ctx, 'OWNER')).toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'FORBIDDEN',
      }),
    )
  })

  it('allows OWNER access to MANAGER routes', () => {
    const ctx = createSessionContext({ role: 'OWNER' })

    expect(() => requireTenantRole(ctx, 'MANAGER')).not.toThrow()
  })

  it('rejects contexts with no active tenant', () => {
    const ctx = createSessionContext({
      activeTenantId: null,
      role: 'OWNER',
    })

    expect(() => requireTenantRole(ctx, 'STAFF')).toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'FORBIDDEN',
      }),
    )
  })
})

describe('requirePlatformAdmin', () => {
  it('allows platform admins', () => {
    const ctx = createSessionContext({ isPlatformAdmin: true })

    expect(() => requirePlatformAdmin(ctx)).not.toThrow()
  })

  it('rejects non-admins', () => {
    const ctx = createSessionContext({ isPlatformAdmin: false })

    expect(() => requirePlatformAdmin(ctx)).toThrowError(
      expect.objectContaining<Partial<TRPCError>>({
        code: 'FORBIDDEN',
      }),
    )
  })
})
