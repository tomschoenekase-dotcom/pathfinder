import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = await vi.hoisted(async () => {
  const { createRequire } = await import('node:module')
  const requireAuthPackage = createRequire(new URL('../../auth/package.json', import.meta.url))
  return {
    auth: vi.fn(),
    currentUser: vi.fn(),
    findFirst: vi.fn(),
    // Auth owns the SDK dependency. Mock its ESM entry, as used by Vitest,
    // rather than creating an unresolved virtual SDK mock in the API package.
    clerkModule: requireAuthPackage
      .resolve('@clerk/nextjs/server')
      .replace(/([\\/])cjs([\\/])/u, '$1esm$2'),
  }
})
vi.mock(mocks.clerkModule, () => ({ auth: mocks.auth, currentUser: mocks.currentUser }))
vi.mock('@pathfinder/db', () => ({ db: { place: { findFirst: mocks.findFirst } } }))
import { createTRPCContext } from './context'
import { placeRouter } from './routers/place'

const museums = [
  ['org_newMiniature', 'org_3HN2BNDTxN9EU5HrfMOh9gWIxao', 'cmuseumplace00000000000001'],
  ['org_newSpace', 'org_3HV2vyn6xVr0wPRx2PAmC6AH7V2', 'cmuseumplace00000000000002'],
] as const
const issuer = 'https://clerk.synthetic.example'
function request(override = museums[1][1]) {
  return new Request('https://dashboard.example', {
    headers: { cookie: `pf_admin_tenant=${override}` },
  })
}

describe('canonical context through owned-object authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv(
      'CLERK_IDENTITY_BINDING',
      JSON.stringify({
        version: 1,
        issuer,
        instanceId: 'ins_synthetic',
        webhookSecretSha256: 'a'.repeat(64),
        users: [{ providerId: 'user_newTom', applicationId: 'user_oldTom' }],
        organizations: museums.map(([providerId, applicationId]) => ({
          providerId,
          applicationId,
        })),
      }),
    )
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_synthetic')
    const key = `pk_live_${Buffer.from('clerk.synthetic.example$').toString('base64')}`
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', key)
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', key)
    mocks.currentUser.mockResolvedValue({ id: 'user_newTom', publicMetadata: {} })
    mocks.findFirst.mockImplementation(
      async ({ where }: { where: { tenantId: string; id: string } }) => {
        const museum = museums.find(
          ([, tenantId, id]) => where.tenantId === tenantId && where.id === id,
        )
        return museum ? { id: museum[2], tenantId: museum[1] } : null
      },
    )
  })
  afterEach(() => vi.unstubAllEnvs())
  it.each(museums)(
    'selects only existing content owned by active %s',
    async (providerId, tenantId, placeId) => {
      mocks.auth.mockResolvedValue({
        userId: 'user_newTom',
        orgId: providerId,
        orgRole: 'org:member',
        sessionClaims: { iss: issuer },
      })
      const ctx = await createTRPCContext({ req: request() })
      expect(ctx.session).toMatchObject({
        userId: 'user_oldTom',
        activeTenantId: tenantId,
        isPlatformAdmin: false,
      })
      const caller = placeRouter.createCaller(ctx)
      expect(await caller.getById({ id: placeId })).toMatchObject({ id: placeId, tenantId })
      const foreignId = museums.find(([, otherTenantId]) => otherTenantId !== tenantId)![2]
      await expect(caller.getById({ id: foreignId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(mocks.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: foreignId, tenantId } }),
      )
    },
  )
  it('permits the existing admin override while retaining the original canonical actor', async () => {
    mocks.auth.mockResolvedValue({
      userId: 'user_newTom',
      orgId: museums[0][0],
      orgRole: 'org:member',
      sessionClaims: { iss: issuer },
    })
    mocks.currentUser.mockResolvedValue({
      id: 'user_newTom',
      publicMetadata: { platform_role: 'PLATFORM_ADMIN' },
    })
    const ctx = await createTRPCContext({ req: request() })
    expect(ctx.session).toMatchObject({
      userId: 'user_oldTom',
      activeTenantId: museums[1][1],
      role: 'STAFF',
      isPlatformAdmin: true,
    })
    expect(await placeRouter.createCaller(ctx).getById({ id: museums[1][2] })).toMatchObject({
      tenantId: museums[1][1],
    })
  })
  it('does not give a new unrelated identity access to either existing museum', async () => {
    mocks.auth.mockResolvedValue({
      userId: 'user_newClient',
      orgId: 'org_newClient',
      orgRole: 'org:admin',
      sessionClaims: { iss: issuer },
    })
    mocks.currentUser.mockResolvedValue({ id: 'user_newClient', publicMetadata: {} })
    const ctx = await createTRPCContext({ req: request() })
    for (const [, , id] of museums)
      await expect(placeRouter.createCaller(ctx).getById({ id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
  })
  it('denies anonymous owned-object access before any persistence call', async () => {
    mocks.auth.mockResolvedValue({ userId: null })
    const ctx = await createTRPCContext({ req: request() })
    await expect(
      placeRouter.createCaller(ctx).getById({ id: museums[0][2] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})
