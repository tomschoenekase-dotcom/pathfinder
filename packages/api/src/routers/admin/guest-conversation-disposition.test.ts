import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
  GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION,
} from '@pathfinder/config/guest-conversation-disposition-policy'

import type { TRPCContext } from '../../context'
import { router } from '../../core'

const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }))
vi.mock('@pathfinder/db', async () => {
  const authority = await vi.importActual<typeof import('@pathfinder/db')>('@pathfinder/db')
  return {
    authorizeGuestConversationDispositionAction: authorize,
    GuestConversationDispositionAuthorizationInput:
      authority.GuestConversationDispositionAuthorizationInput,
    GuestConversationDispositionAuthorityError:
      authority.GuestConversationDispositionAuthorityError,
  }
})

import { adminGuestConversationDispositionRouter } from './guest-conversation-disposition'

const testRouter = router({ admin: adminGuestConversationDispositionRouter })
function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'current-admin',
      activeTenantId: 'session-tenant',
      role: 'OWNER',
      isPlatformAdmin,
    },
  }
}
function input() {
  return {
    request: {
      version: 'guest-conversation-disposition-v1' as const,
      operationId: '10000000-0000-4000-8000-000000000001',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      sessionId: 'session-a',
      expectedPolicyVersion: GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION,
      expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
      basis: { kind: 'RETENTION_EXPIRY' as const },
    },
    assessment: {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      sessionId: 'session-a',
      caseReference: 'case-a',
      holdStatus: 'NO_KNOWN_HOLD' as const,
      linkage: { kind: 'RETENTION_EXPIRY' as const },
    },
  }
}

describe('guest disposition admin authorization HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authorize.mockResolvedValue({ state: 'AUTHORIZED', replayed: false })
  })
  it('rejects guests and tenant owners before authority action', async () => {
    const anonymous = context()
    anonymous.session = { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false }
    await expect(
      testRouter.createCaller(anonymous).admin.authorizeGuestConversationDisposition(input()),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    await expect(
      testRouter.createCaller(context(false)).admin.authorizeGuestConversationDisposition(input()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(authorize).not.toHaveBeenCalled()
  })
  it('uses the current authenticated admin and returns authorization only', async () => {
    const ctx = context()
    const result = await testRouter
      .createCaller(ctx)
      .admin.authorizeGuestConversationDisposition(input())
    expect(authorize).toHaveBeenCalledWith(
      input(),
      { userId: 'current-admin', isPlatformAdmin: true },
      ctx.db,
    )
    expect(result).toEqual({ state: 'AUTHORIZED', replayed: false })
    expect(Object.keys(testRouter._def.procedures)).toEqual([
      'admin.authorizeGuestConversationDisposition',
    ])
  })
  it.each([
    { approvedBy: 'attacker' },
    { cutoff: '2099-01-01T00:00:00.000Z' },
    { actor: { userId: 'attacker' } },
    { delete: true },
  ])('rejects untrusted execution/authority fields %j', async (extra) => {
    await expect(
      testRouter
        .createCaller(context())
        .admin.authorizeGuestConversationDisposition({ ...input(), ...extra }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(authorize).not.toHaveBeenCalled()
  })
  it('requires a scoped case assessment', async () => {
    const { request } = input()
    await expect(
      testRouter
        .createCaller(context())
        .admin.authorizeGuestConversationDisposition({ request } as ReturnType<typeof input>),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(authorize).not.toHaveBeenCalled()
  })
})
