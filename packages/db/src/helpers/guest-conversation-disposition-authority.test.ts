import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
  GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION,
} from '@pathfinder/config/guest-conversation-disposition-policy'

const { persist } = vi.hoisted(() => ({ persist: vi.fn() }))
vi.mock('./guest-conversation-disposition', () => ({
  recordGuestConversationDispositionAuthorization: persist,
}))

import {
  authorizeGuestConversationDispositionAction as authorize,
  GuestConversationDispositionAuthorizationInput,
} from './guest-conversation-disposition-authority'

const actor = { userId: 'platform-admin', isPlatformAdmin: true }
function input() {
  return GuestConversationDispositionAuthorizationInput.parse({
    request: {
      version: 'guest-conversation-disposition-v1',
      operationId: '10000000-0000-4000-8000-000000000001',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      sessionId: 'session-a',
      expectedPolicyVersion: GUEST_CONVERSATION_DISPOSITION_POLICY_VERSION,
      expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
      basis: {
        kind: 'SUPPORT_REQUEST',
        supportRequestId: 'support-a',
        expectedSupportRequestVersion: 3,
      },
    },
    assessment: {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      sessionId: 'session-a',
      caseReference: 'case-a',
      holdStatus: 'NO_KNOWN_HOLD',
      linkage: {
        kind: 'SUPPORT_REQUEST',
        supportRequestId: 'support-a',
        reviewedRequesterUserId: 'requester-a',
      },
    },
  })
}
function fixture() {
  const order: string[] = []
  const support = {
    status: 'OPEN',
    version: 3,
    createdByKind: 'CLIENT',
    requesterUserId: 'requester-a',
    requesterMembership: { status: 'ACTIVE' },
    participants: [] as Array<{
      userId: string
      revokedAt: Date | null
      membership: { status: string }
    }>,
  }
  const tx = {
    $executeRaw: vi.fn(async () => {
      order.push('lock')
      return 1
    }),
    supportRequest: {
      findFirst: vi.fn<(query: unknown) => Promise<typeof support | null>>(async () => {
        order.push('support')
        return support as typeof support | null
      }),
    },
    visitorSession: {
      findFirst: vi.fn(async () => ({ id: 'session-a' }) as { id: string } | null),
    },
  }
  const client = { $transaction: vi.fn(async (run: (value: typeof tx) => unknown) => run(tx)) }
  return {
    order,
    support,
    tx,
    client: client as unknown as NonNullable<Parameters<typeof authorize>[2]>,
  }
}

describe('authenticated scoped guest disposition authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persist.mockResolvedValue({
      operationId: input().request.operationId,
      state: 'AUTHORIZED',
      replayed: false,
    })
  })
  it('locks before ACL/version resolution and records authority without guest content reads', async () => {
    const f = fixture()
    expect(await authorize(input(), actor, f.client)).toMatchObject({ state: 'AUTHORIZED' })
    expect(f.order).toEqual(['lock', 'support'])
    expect(f.tx.visitorSession.findFirst).toHaveBeenCalledWith({
      where: { id: 'session-a', tenantId: 'tenant-a', venueId: 'venue-a' },
      select: { id: true },
    })
    const [record, tx] = persist.mock.calls[0]!
    expect(tx).toBe(f.tx)
    expect(record.authority).toMatchObject({
      actorId: 'platform-admin',
      actorRole: 'PLATFORM_ADMIN',
      retentionDays: 365,
      holdAssessment: {
        status: 'NO_KNOWN_HOLD',
        referenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      basis: {
        supportRequestId: 'support-a',
        supportRequestVersion: 3,
        reviewedRequesterUserId: 'requester-a',
      },
    })
    expect(JSON.stringify(record)).not.toContain('case-a')
    expect(record).not.toHaveProperty('cutoff')
  })
  it('refuses a non-admin before database work', async () => {
    const f = fixture()
    await expect(
      authorize(input(), { ...actor, isPlatformAdmin: false }, f.client),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_RESOLVED' })
    expect(f.client.$transaction).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
  it.each(['expectedPolicyVersion', 'expectedPolicySha256'] as const)(
    'refuses stale %s before persistence',
    async (key) => {
      const i = input()
      i.request[key] = key === 'expectedPolicyVersion' ? 'old-policy' : '0'.repeat(64)
      await expect(authorize(i, actor, fixture().client)).rejects.toMatchObject({
        code: 'POLICY_NOT_RESOLVED',
      })
      expect(persist).not.toHaveBeenCalled()
    },
  )
  it.each(['tenantId', 'venueId', 'sessionId'] as const)(
    'refuses foreign assessment %s',
    async (key) => {
      const i = input()
      i.assessment[key] = 'foreign'
      await expect(authorize(i, actor, fixture().client)).rejects.toMatchObject({
        code: 'AUTHORITY_NOT_RESOLVED',
      })
      expect(persist).not.toHaveBeenCalled()
    },
  )
  it('requires exact existing session scope', async () => {
    const f = fixture()
    f.tx.visitorSession.findFirst.mockResolvedValue(null)
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'SCOPE_NOT_FOUND',
    })
    expect(persist).not.toHaveBeenCalled()
  })
  it('requires exact existing support scope and matching linkage', async () => {
    const f = fixture()
    f.tx.supportRequest.findFirst.mockResolvedValue(null)
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_RESOLVED',
    })
    expect(f.tx.supportRequest.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'support-a', tenantId: 'tenant-a', venueId: 'venue-a' },
    })
    const i = input()
    if (i.assessment.linkage.kind === 'SUPPORT_REQUEST')
      i.assessment.linkage.supportRequestId = 'foreign'
    await expect(authorize(i, actor, fixture().client)).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_RESOLVED',
    })
    expect(persist).not.toHaveBeenCalled()
  })
  it('refuses stale SupportRequest version', async () => {
    const f = fixture()
    f.support.version++
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'SUPPORT_REQUEST_CHANGED',
    })
    expect(persist).not.toHaveBeenCalled()
  })
  it.each(['DRAFT', 'CANCELLED'])('refuses %s support status', async (status) => {
    const f = fixture()
    f.support.status = status
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_RESOLVED',
    })
    expect(persist).not.toHaveBeenCalled()
  })
  it.each(['AGENT', 'SYSTEM'])(
    'refuses %s provenance despite an active requester',
    async (kind) => {
      const f = fixture()
      f.support.createdByKind = kind
      await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
        code: 'AUTHORITY_NOT_RESOLVED',
      })
      expect(persist).not.toHaveBeenCalled()
    },
  )
  it('uses existing ACL for active explicit participants and refuses revoked membership', async () => {
    const f = fixture()
    f.support.createdByKind = 'OPERATOR'
    f.support.requesterUserId = 'other'
    f.support.participants = [
      { userId: 'requester-a', revokedAt: null, membership: { status: 'ACTIVE' } },
    ]
    await authorize(input(), actor, f.client)
    persist.mockClear()
    f.support.participants[0]!.revokedAt = new Date()
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_RESOLVED',
    })
    expect(persist).not.toHaveBeenCalled()
    f.support.participants[0]!.revokedAt = null
    f.support.participants[0]!.membership.status = 'SUSPENDED'
    await expect(authorize(input(), actor, f.client)).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_RESOLVED',
    })
  })
  it.each([
    ['UNRESOLVED', 'HOLD_UNRESOLVED'],
    ['HOLD_PRESENT', 'LEGAL_HOLD'],
  ] as const)('refuses %s hold assessment', async (status, code) => {
    const i = input()
    i.assessment.holdStatus = status
    await expect(authorize(i, actor, fixture().client)).rejects.toMatchObject({ code })
    expect(persist).not.toHaveBeenCalled()
  })
  it('rejects missing assessment and caller authority or cutoff fields', () => {
    const i = input()
    expect(
      GuestConversationDispositionAuthorizationInput.safeParse({ request: i.request }).success,
    ).toBe(false)
    for (const extra of [
      { approvedBy: 'attacker' },
      { effectiveCutoffUtc: '2099-01-01T00:00:00.000Z' },
      { actor: { userId: 'attacker' } },
    ]) {
      expect(
        GuestConversationDispositionAuthorizationInput.safeParse({ ...i, ...extra }).success,
      ).toBe(false)
      expect(
        GuestConversationDispositionAuthorizationInput.safeParse({
          ...i,
          request: { ...i.request, ...extra },
        }).success,
      ).toBe(false)
    }
  })
  it('resolves expiry without pretending Support proves visitor ownership or supplying a cutoff', async () => {
    const i = input()
    i.request.basis = { kind: 'RETENTION_EXPIRY' }
    i.assessment.linkage = { kind: 'RETENTION_EXPIRY' }
    const f = fixture()
    await authorize(i, actor, f.client)
    expect(f.tx.supportRequest.findFirst).not.toHaveBeenCalled()
    expect(persist.mock.calls[0]![0].authority.basis).toEqual({ kind: 'RETENTION_EXPIRY' })
  })
  it('binds the selected participant to immutable replay identity even when another participant has access', async () => {
    const f = fixture()
    f.support.createdByKind = 'OPERATOR'
    f.support.requesterUserId = 'other'
    f.support.participants = ['requester-a', 'requester-b'].map((userId) => ({
      userId,
      revokedAt: null,
      membership: { status: 'ACTIVE' },
    }))
    let recorded: string | undefined
    // Model the persistence seam's immutable-input rule; native SQL proof is separate.
    persist.mockImplementation(async (value: unknown) => {
      const identity = JSON.stringify(value)
      if (recorded && recorded !== identity) throw new Error('OPERATION_CONFLICT')
      const replayed = recorded !== undefined
      recorded = identity
      return { state: 'AUTHORIZED', replayed }
    })
    const i = input()
    expect(await authorize(i, actor, f.client)).toMatchObject({ replayed: false })
    expect(await authorize(i, actor, f.client)).toMatchObject({ replayed: true })
    expect(persist.mock.calls[0]![0].authority.basis).toEqual({
      kind: 'SUPPORT_REQUEST',
      supportRequestId: 'support-a',
      supportRequestVersion: 3,
      reviewedRequesterUserId: 'requester-a',
    })
    if (i.assessment.linkage.kind !== 'SUPPORT_REQUEST') throw new Error('Expected support fixture')
    i.assessment.linkage.reviewedRequesterUserId = 'requester-b'
    await expect(authorize(i, actor, f.client)).rejects.toThrow('OPERATION_CONFLICT')
    expect(persist.mock.calls[2]![0].request).toEqual(persist.mock.calls[0]![0].request)
    expect(persist.mock.calls[2]![0].authority.basis).toEqual({
      kind: 'SUPPORT_REQUEST',
      supportRequestId: 'support-a',
      supportRequestVersion: 3,
      reviewedRequesterUserId: 'requester-b',
    })
    expect(f.tx.supportRequest.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          participants: expect.objectContaining({ where: { userId: 'requester-b' } }),
        }),
      }),
    )
  })
  it('preserves the persistence replay/conflict outcome and binds changed case evidence', async () => {
    persist.mockResolvedValueOnce({ state: 'AUTHORIZED', replayed: true })
    const i = input()
    expect(await authorize(i, actor, fixture().client)).toMatchObject({ replayed: true })
    const original = persist.mock.calls[0]![0].authority.holdAssessment.referenceSha256
    i.assessment.caseReference = 'case-b'
    persist.mockRejectedValueOnce(new Error('OPERATION_CONFLICT'))
    await expect(authorize(i, actor, fixture().client)).rejects.toThrow('OPERATION_CONFLICT')
    expect(persist.mock.calls[1]![0].authority.holdAssessment.referenceSha256).not.toBe(original)
  })
})
