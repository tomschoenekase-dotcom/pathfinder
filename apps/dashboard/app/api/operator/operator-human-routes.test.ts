import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  hasStrictReverification: vi.fn(),
  resolveOperatorConfig: vi.fn(),
  approveAndApplyProposal: vi.fn(),
  approveAndApplyPlan: vi.fn(),
  rejectProposal: vi.fn(),
  completeAuthorization: vi.fn(),
  findPlan: vi.fn(),
  armOperatorConnection: vi.fn(),
}))

vi.mock('@pathfinder/auth/server', () => ({
  auth: mocks.auth,
  hasStrictReverification: mocks.hasStrictReverification,
  strictReverificationRequiredBody: () => ({
    clerk_error: {
      type: 'forbidden',
      reason: 'reverification-error',
      metadata: { reverification: 'strict' },
    },
  }),
}))
vi.mock('@pathfinder/db', () => ({ db: { operatorPlan: { findUnique: mocks.findPlan } } }))
vi.mock('@pathfinder/api/operator', async () => {
  const { z } = await import('zod')
  class OperatorNotFoundError extends Error {}
  class OperatorProposalError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    resolveOperatorConfig: mocks.resolveOperatorConfig,
    isOperatorApprover: (
      config: { allowedUserIds: Set<string> },
      identity: { userId: string | null; platformRole: unknown },
    ) =>
      identity.platformRole === 'PLATFORM_ADMIN' &&
      typeof identity.userId === 'string' &&
      config.allowedUserIds.has(identity.userId),
    approveAndApplyProposal: mocks.approveAndApplyProposal,
    approveAndApplyPlan: mocks.approveAndApplyPlan,
    rejectProposal: mocks.rejectProposal,
    rejectPlan: vi.fn(),
    completeAuthorization: mocks.completeAuthorization,
    armOperatorConnection: mocks.armOperatorConnection,
    ConsentDecision: z.object({}).passthrough(),
    createOperatorRegistry: () => ({ kinds: new Map() }),
    OperatorNotFoundError,
    OperatorProposalError,
  }
})

import { POST as approve } from './approve/route'
import { POST as arm } from './arm/route'
import { POST as consent } from './consent/route'

const issuer = 'https://app.example.com'
const argsHash = 'a'.repeat(64)

function request(path: string, body: unknown, origin: string | null = issuer) {
  return new Request(`${issuer}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
}

function signIn(userId: string, platformRole: unknown = 'PLATFORM_ADMIN') {
  mocks.auth.mockResolvedValue({
    userId,
    sessionClaims: { publicMetadata: { platform_role: platformRole } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveOperatorConfig.mockReturnValue({
    status: 'ready',
    config: { issuer, allowedUserIds: new Set(['user_owner']) },
  })
  mocks.hasStrictReverification.mockResolvedValue(true)
  mocks.findPlan.mockResolvedValue(null)
  mocks.approveAndApplyProposal.mockResolvedValue({
    id: 'p1',
    status: 'APPLIED',
    failureCode: null,
  })
  signIn('user_owner')
})

describe('one-tap approval handler', () => {
  const body = { id: 'p1', argsHash, decision: 'approve' }

  it('is dark while the operator is disabled', async () => {
    mocks.resolveOperatorConfig.mockReturnValue({ status: 'disabled' })
    expect((await approve(request('/api/operator/approve', body))).status).toBe(404)
    expect(mocks.approveAndApplyProposal).not.toHaveBeenCalled()
  })

  it.each([
    ['no session', () => mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null })],
    ['a non-admin', () => signIn('user_owner', 'CLIENT')],
    ['an admin missing from the allowlist', () => signIn('user_other')],
  ])('refuses %s', async (_label, arrange) => {
    arrange()
    expect((await approve(request('/api/operator/approve', body))).status).toBe(403)
    expect(mocks.approveAndApplyProposal).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin or origin-less POST', async () => {
    expect(
      (await approve(request('/api/operator/approve', body, 'https://evil.example'))).status,
    ).toBe(403)
    expect((await approve(request('/api/operator/approve', body, null))).status).toBe(403)
    expect(mocks.approveAndApplyProposal).not.toHaveBeenCalled()
  })

  it('demands a strict Clerk reverification and answers with the hint the client hook understands', async () => {
    mocks.hasStrictReverification.mockResolvedValue(false)
    const response = await approve(request('/api/operator/approve', body))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ clerk_error: { reason: 'reverification-error' } })
    expect(mocks.approveAndApplyProposal).not.toHaveBeenCalled()
  })

  it('applies with the verified human as actor and the argsHash that was shown', async () => {
    const response = await approve(request('/api/operator/approve', body))
    expect(response.status).toBe(200)
    expect(mocks.approveAndApplyProposal).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'p1', argsHash, actorUserId: 'user_owner' }),
      expect.anything(),
    )
  })

  it('rejects malformed bodies before touching proposals', async () => {
    expect(
      (await approve(request('/api/operator/approve', { ...body, argsHash: 'short' }))).status,
    ).toBe(400)
    expect(
      (await approve(request('/api/operator/approve', { ...body, approved: true }))).status,
    ).toBe(400)
    expect(mocks.approveAndApplyProposal).not.toHaveBeenCalled()
  })
})

describe('consent handler', () => {
  const body = {
    params: { client_id: 'opc_x' },
    decision: {
      decision: 'approve',
      allTenants: true,
      tenantIds: [],
      capabilities: ['operator:read'],
      expiresInDays: 90,
    },
  }

  it('requires the same guard before creating a grant', async () => {
    mocks.hasStrictReverification.mockResolvedValue(false)
    expect((await consent(request('/api/operator/consent', body))).status).toBe(403)
    signIn('user_other')
    mocks.hasStrictReverification.mockResolvedValue(true)
    expect((await consent(request('/api/operator/consent', body))).status).toBe(403)
    expect(mocks.completeAuthorization).not.toHaveBeenCalled()
  })

  it('returns only the redirect produced by server-side re-validation', async () => {
    mocks.completeAuthorization.mockResolvedValue({
      redirectTo: 'https://connector.example.com/cb?code=x',
    })
    const response = await consent(request('/api/operator/consent', body))
    expect(await response.json()).toEqual({ redirectTo: 'https://connector.example.com/cb?code=x' })
    expect(mocks.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_owner' }),
    )
  })
})

describe('arming handler', () => {
  it('arms only for an allowlisted, same-origin, freshly reverified admin', async () => {
    mocks.hasStrictReverification.mockResolvedValue(false)
    expect((await arm(request('/api/operator/arm', {}))).status).toBe(403)
    mocks.hasStrictReverification.mockResolvedValue(true)
    expect((await arm(request('/api/operator/arm', {}, 'https://evil.example'))).status).toBe(403)
    signIn('user_other')
    expect((await arm(request('/api/operator/arm', {}))).status).toBe(403)
    expect(mocks.armOperatorConnection).not.toHaveBeenCalled()
    signIn('user_owner')
    expect((await arm(request('/api/operator/arm', {}))).status).toBe(200)
    expect(mocks.armOperatorConnection).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_owner' }),
    )
  })
})
