import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  hasStrictReverification: vi.fn(),
  resolveOperatorConfig: vi.fn(),
  setAutonomyPolicy: vi.fn(),
  revokeOperatorGrant: vi.fn(),
  findGrant: vi.fn(),
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
vi.mock('@pathfinder/db', () => ({ db: { operatorGrant: { findUnique: mocks.findGrant } } }))
vi.mock('@pathfinder/api/operator', () => {
  class OperatorAutonomyLockedError extends Error {}
  const locked = new Set(['customers:propose', 'operator:revert', 'operator:plan'])
  return {
    resolveOperatorConfig: mocks.resolveOperatorConfig,
    isOperatorApprover: (
      config: { allowedUserIds: Set<string> },
      identity: { userId: string | null; platformRole: unknown },
    ) =>
      identity.platformRole === 'PLATFORM_ADMIN' &&
      typeof identity.userId === 'string' &&
      config.allowedUserIds.has(identity.userId),
    OPERATOR_POLICY_CAPABILITIES: ['crm:propose', 'appearance:propose', ...locked],
    OPERATOR_LOCKED_CAPABILITIES: locked,
    OperatorAutonomyLockedError,
    setAutonomyPolicy: mocks.setAutonomyPolicy,
    revokeOperatorGrant: mocks.revokeOperatorGrant,
  }
})

import { POST as autonomy } from './autonomy/route'
import { POST as revoke } from './revoke/route'

const issuer = 'https://app.example.com'

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
  mocks.findGrant.mockResolvedValue({ id: 'grant_1' })
  signIn('user_owner')
})

const cases = [
  {
    name: 'autonomy handler',
    path: '/api/operator/autonomy',
    post: autonomy,
    body: { changes: [{ capability: 'crm:propose', mode: 'auto' }] },
    effect: () => mocks.setAutonomyPolicy,
  },
  {
    name: 'revoke handler',
    path: '/api/operator/revoke',
    post: revoke,
    body: { grantId: 'grant_1' },
    effect: () => mocks.revokeOperatorGrant,
  },
]

describe.each(cases)('$name guard', ({ path, post, body, effect }) => {
  it('is dark while the operator is disabled', async () => {
    mocks.resolveOperatorConfig.mockReturnValue({ status: 'disabled' })
    expect((await post(request(path, body))).status).toBe(404)
    expect(effect()).not.toHaveBeenCalled()
  })

  it.each([
    ['no session', () => mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null })],
    ['a non-admin', () => signIn('user_owner', 'CLIENT')],
    ['an admin missing from the allowlist', () => signIn('user_other')],
  ])('refuses %s', async (_label, arrange) => {
    arrange()
    expect((await post(request(path, body))).status).toBe(403)
    expect(effect()).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin or origin-less POST', async () => {
    expect((await post(request(path, body, 'https://evil.example'))).status).toBe(403)
    expect((await post(request(path, body, null))).status).toBe(403)
    expect(effect()).not.toHaveBeenCalled()
  })

  it('answers 403 with the hint the client hook understands when reverification is missing', async () => {
    mocks.hasStrictReverification.mockResolvedValue(false)
    const response = await post(request(path, body))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ clerk_error: { reason: 'reverification-error' } })
    expect(effect()).not.toHaveBeenCalled()
  })
})

describe('autonomy handler', () => {
  it('saves the batch with the verified human as the actor', async () => {
    const response = await autonomy(
      request('/api/operator/autonomy', {
        changes: [
          { capability: 'crm:propose', mode: 'auto' },
          { capability: 'appearance:propose', mode: 'ask' },
        ],
      }),
    )
    expect(response.status).toBe(200)
    expect(mocks.setAutonomyPolicy).toHaveBeenCalledTimes(2)
    expect(mocks.setAutonomyPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'crm:propose',
        mode: 'auto',
        userId: 'user_owner',
      }),
    )
  })

  it.each(['customers:propose', 'operator:revert', 'operator:plan'])(
    'rejects auto for the locked capability %s on the server and writes nothing',
    async (capability) => {
      const response = await autonomy(
        request('/api/operator/autonomy', {
          changes: [
            { capability: 'crm:propose', mode: 'auto' },
            { capability, mode: 'auto' },
          ],
        }),
      )
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'AUTONOMY_LOCKED' })
      expect(mocks.setAutonomyPolicy).not.toHaveBeenCalled()
    },
  )

  it('rejects unknown or read capabilities, duplicates and malformed bodies', async () => {
    const bad = [
      { changes: [{ capability: 'crm:read', mode: 'auto' }] },
      { changes: [{ capability: 'crm:propose', mode: 'yolo' }] },
      {
        changes: [
          { capability: 'crm:propose', mode: 'auto' },
          { capability: 'crm:propose', mode: 'ask' },
        ],
      },
      { changes: [] },
      { changes: [{ capability: 'crm:propose', mode: 'auto', extra: true }] },
    ]
    for (const body of bad) {
      expect((await autonomy(request('/api/operator/autonomy', body))).status).toBe(400)
    }
    expect(mocks.setAutonomyPolicy).not.toHaveBeenCalled()
  })
})

describe('revoke handler', () => {
  it('revokes with the admin as the actor', async () => {
    const response = await revoke(request('/api/operator/revoke', { grantId: 'grant_1' }))
    expect(response.status).toBe(200)
    expect(mocks.revokeOperatorGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: 'grant_1',
        actorUserId: 'user_owner',
        reason: 'dashboard_revoke',
      }),
    )
  })

  it('answers 404 for an unknown grant and 400 for a malformed body', async () => {
    mocks.findGrant.mockResolvedValue(null)
    expect((await revoke(request('/api/operator/revoke', { grantId: 'nope' }))).status).toBe(404)
    expect((await revoke(request('/api/operator/revoke', { grantId: '' }))).status).toBe(400)
    expect(
      (await revoke(request('/api/operator/revoke', { grantId: 'grant_1', extra: 1 }))).status,
    ).toBe(400)
    expect(mocks.revokeOperatorGrant).not.toHaveBeenCalled()
  })
})
