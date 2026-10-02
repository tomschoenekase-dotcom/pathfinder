import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  hasStrictReverification: vi.fn(),
  resolveOperatorConfig: vi.fn(),
  decideRequest: vi.fn(),
  createJobGrant: vi.fn(),
  revokeJobGrant: vi.fn(),
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
vi.mock('@pathfinder/db', () => ({ db: {} }))
vi.mock('@pathfinder/api/operator', () => {
  class OperatorNotFoundError extends Error {}
  class OperatorProposalError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  class OperatorJobGrantError extends Error {
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
    createOperatorRegistry: () => ({ kinds: new Map() }),
    decideRequest: mocks.decideRequest,
    createJobGrant: mocks.createJobGrant,
    revokeJobGrant: mocks.revokeJobGrant,
    OperatorNotFoundError,
    OperatorProposalError,
    OperatorJobGrantError,
  }
})

import { POST as decide } from './decide/route'
import { POST as jobGrants } from './job-grants/route'

const issuer = 'https://app.example.com'
const hash = 'a'.repeat(64)

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
  mocks.decideRequest.mockResolvedValue({ id: 'proposal_1', status: 'APPLIED', failureCode: null })
  mocks.createJobGrant.mockResolvedValue({ id: 'jg_1' })
  mocks.revokeJobGrant.mockResolvedValue({ id: 'jg_1', revokedAt: new Date() })
  signIn('user_owner')
})

const createBody = {
  action: 'create',
  name: 'Example weekly job',
  clientId: 'opc_1',
  tenantId: 'tenant_a',
  kinds: ['appearance.update'],
  maxExecutions: 3,
}

const cases = [
  {
    name: 'decide handler',
    path: '/api/operator/decide',
    post: decide,
    body: { decisionRequestId: 'req_1', argsHash: hash, decision: 'approve' },
    effect: () => mocks.decideRequest,
  },
  {
    name: 'job-grants create',
    path: '/api/operator/job-grants',
    post: jobGrants,
    body: createBody,
    effect: () => mocks.createJobGrant,
  },
  {
    name: 'job-grants revoke',
    path: '/api/operator/job-grants',
    post: jobGrants,
    body: { action: 'revoke', id: 'jg_1' },
    effect: () => mocks.revokeJobGrant,
  },
]

describe.each(cases)('$name guard', ({ path, post, body, effect }) => {
  it('is dark while the operator is disabled', async () => {
    mocks.resolveOperatorConfig.mockReturnValue({ status: 'disabled' })
    expect((await post(request(path, body))).status).toBe(404)
    expect(effect()).not.toHaveBeenCalled()
  })

  it.each([
    [
      'no session (a bearer-token connection has none)',
      () => mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null }),
    ],
    ['a non-admin', () => signIn('user_owner', 'CLIENT')],
    ['a tenant owner who is not a platform admin', () => signIn('user_owner', 'OWNER')],
    ['an admin missing from the allowlist', () => signIn('user_other')],
  ])('refuses %s', async (_label, arrange) => {
    arrange()
    expect((await post(request(path, body))).status).toBe(403)
    expect(effect()).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin or origin-less POST (CSRF)', async () => {
    expect((await post(request(path, body, 'https://evil.example'))).status).toBe(403)
    expect((await post(request(path, body, null))).status).toBe(403)
    expect(effect()).not.toHaveBeenCalled()
  })

  it('answers 403 with the reverification hint when strict reverification is missing', async () => {
    mocks.hasStrictReverification.mockResolvedValue(false)
    const response = await post(request(path, body))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ clerk_error: { reason: 'reverification-error' } })
    expect(effect()).not.toHaveBeenCalled()
  })
})

describe('decide handler', () => {
  it('decides with the verified human as the actor and the allowlist from config', async () => {
    const response = await decide(
      request('/api/operator/decide', {
        decisionRequestId: 'req_1',
        argsHash: hash,
        decision: 'reject',
      }),
    )
    expect(response.status).toBe(200)
    expect(mocks.decideRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionRequestId: 'req_1',
        argsHash: hash,
        decision: 'reject',
        actorUserId: 'user_owner',
      }),
      expect.objectContaining({ allowedUserIds: new Set(['user_owner']) }),
    )
  })

  it('takes no identity or authority from the body', async () => {
    for (const body of [
      { decisionRequestId: 'req_1', argsHash: hash, decision: 'approve', actorUserId: 'someone' },
      { decisionRequestId: 'req_1', argsHash: hash, decision: 'approve', approved: true },
      { decisionRequestId: 'req_1', argsHash: 'short', decision: 'approve' },
      { decisionRequestId: 'req_1', argsHash: hash, decision: 'maybe' },
      { decisionRequestId: '', argsHash: hash, decision: 'approve' },
    ]) {
      expect((await decide(request('/api/operator/decide', body))).status).toBe(400)
    }
    expect(mocks.decideRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['REQUEST_USED', 409],
    ['REQUEST_EXPIRED', 409],
    ['REQUEST_INVALIDATED', 409],
    ['ARGS_HASH_MISMATCH', 409],
    ['FORBIDDEN_ACTOR', 403],
  ])('maps %s to %i without leaking more', async (code, status) => {
    const { OperatorProposalError } = await import('@pathfinder/api/operator')
    mocks.decideRequest.mockRejectedValue(
      new (OperatorProposalError as never as new (c: string) => Error)(code),
    )
    const response = await decide(
      request('/api/operator/decide', {
        decisionRequestId: 'req_1',
        argsHash: hash,
        decision: 'approve',
      }),
    )
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: code })
  })

  it('answers 404 for an unknown request', async () => {
    const { OperatorNotFoundError } = await import('@pathfinder/api/operator')
    mocks.decideRequest.mockRejectedValue(new OperatorNotFoundError())
    expect(
      (
        await decide(
          request('/api/operator/decide', {
            decisionRequestId: 'nope',
            argsHash: hash,
            decision: 'approve',
          }),
        )
      ).status,
    ).toBe(404)
  })
})

describe('job-grants handler', () => {
  it('creates a grant with the verified human as the actor', async () => {
    const response = await jobGrants(request('/api/operator/job-grants', createBody))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'jg_1', created: true })
    expect(mocks.createJobGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Example weekly job',
        clientId: 'opc_1',
        tenantId: 'tenant_a',
        kinds: ['appearance.update'],
        maxExecutions: 3,
        actorUserId: 'user_owner',
      }),
      expect.objectContaining({ allowedUserIds: new Set(['user_owner']) }),
    )
  })

  it('revokes with the verified human as the actor', async () => {
    const response = await jobGrants(
      request('/api/operator/job-grants', { action: 'revoke', id: 'jg_1' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'jg_1', revoked: true })
    expect(mocks.revokeJobGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jg_1', actorUserId: 'user_owner' }),
      expect.anything(),
    )
  })

  it('rejects out-of-range or unexpected bodies before the service is reached', async () => {
    for (const body of [
      { ...createBody, maxExecutions: 0 },
      { ...createBody, maxExecutions: 101 },
      { ...createBody, kinds: [] },
      { ...createBody, expiresInMinutes: 1 },
      { ...createBody, expiresInMinutes: 8 * 24 * 60 },
      { ...createBody, actorUserId: 'someone' },
      { ...createBody, createdByUserId: 'someone' },
      { action: 'delete', id: 'jg_1' },
      { action: 'revoke', id: '' },
    ]) {
      expect((await jobGrants(request('/api/operator/job-grants', body))).status).toBe(400)
    }
    expect(mocks.createJobGrant).not.toHaveBeenCalled()
    expect(mocks.revokeJobGrant).not.toHaveBeenCalled()
  })

  it('answers 409 for a kind that cannot be granted', async () => {
    const { OperatorJobGrantError } = await import('@pathfinder/api/operator')
    mocks.createJobGrant.mockRejectedValue(
      new (OperatorJobGrantError as never as new (c: string) => Error)('KIND_NOT_GRANTABLE'),
    )
    const response = await jobGrants(
      request('/api/operator/job-grants', { ...createBody, kinds: ['customers.invite'] }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'KIND_NOT_GRANTABLE' })
  })
})
