import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applicationTenantId,
  applicationUserId,
  assertClerkSessionBinding,
  assertClerkWebhookBinding,
  providerOrganizationId,
  providerUserId,
} from './identity-binding'

const binding = {
  version: 1,
  issuer: 'https://clerk.synthetic.example',
  instanceId: 'ins_synthetic',
  webhookSecretSha256: createHash('sha256').update('synthetic-secret').digest('hex'),
  users: [{ providerId: 'user_productionTom', applicationId: 'user_originalTom' }],
  organizations: [
    { providerId: 'org_productionMiniature', applicationId: 'org_3HN2BNDTxN9EU5HrfMOh9gWIxao' },
    { providerId: 'org_productionSpace', applicationId: 'org_3HV2vyn6xVr0wPRx2PAmC6AH7V2' },
  ],
}

describe('deployment identity binding', () => {
  beforeEach(() => {
    vi.stubEnv('CLERK_IDENTITY_BINDING', JSON.stringify(binding))
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_synthetic')
    const key = `pk_live_${Buffer.from('clerk.synthetic.example$').toString('base64')}`
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', key)
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', key)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('round-trips both museums and Tom without changing business IDs', () => {
    for (const pair of binding.organizations) {
      expect(applicationTenantId(pair.providerId)).toBe(pair.applicationId)
      expect(providerOrganizationId(pair.applicationId)).toBe(pair.providerId)
    }
    expect(applicationUserId('user_productionTom')).toBe('user_originalTom')
    expect(providerUserId('user_originalTom')).toBe('user_productionTom')
  })
  it('leaves legitimate new identities on the existing onboarding path', () => {
    expect(applicationUserId('user_new')).toBe('user_new')
    expect(applicationTenantId('org_new')).toBe('org_new')
    expect(providerUserId('user_new')).toBe('user_new')
    expect(providerOrganizationId('org_new')).toBe('org_new')
  })
  it('rejects old-ID incoming fallback and provider-ID outgoing fallback', () => {
    expect(() => applicationUserId('user_originalTom')).toThrow('binding validation failed')
    expect(() => providerUserId('user_productionTom')).toThrow()
    for (const pair of binding.organizations) {
      expect(() => applicationTenantId(pair.applicationId)).toThrow()
      expect(() => providerOrganizationId(pair.providerId)).toThrow()
    }
    expect(() => applicationTenantId('user_productionTom')).toThrow()
  })
  it.each([
    { users: [...binding.users, { providerId: 'user_other', applicationId: 'user_originalTom' }] },
    {
      users: [...binding.users, { providerId: 'user_productionTom', applicationId: 'user_other' }],
    },
    { users: [...binding.users, { providerId: 'user_originalTom', applicationId: 'user_other' }] },
    {
      users: [
        ...binding.users,
        { providerId: 'user_originalTom', applicationId: 'user_productionTom' },
      ],
    },
    { users: [{ providerId: 'user_same', applicationId: 'user_same' }] },
    { users: [{ providerId: 'user_new', applicationId: 'org_old' }] },
    {
      users: [
        { providerId: 'user_new', applicationId: 'user_old', email: 'untrusted@example.com' },
      ],
    },
    { version: 2 },
    { issuer: 'http://clerk.synthetic.example' },
    { issuer: 'https://clerk.synthetic.example/' },
    { instanceId: '' },
    { webhookSecretSha256: 'invalid' },
    { organizations: null },
    { unexpected: true },
  ])('rejects malformed, ambiguous or cyclic configuration %#', (change) => {
    vi.stubEnv('CLERK_IDENTITY_BINDING', JSON.stringify({ ...binding, ...change }))
    expect(() => applicationUserId('user_new')).toThrow('binding validation failed')
  })
  it.each(['', '{', 'null', '[]'])('refuses malformed JSON %s', (raw) => {
    vi.stubEnv('CLERK_IDENTITY_BINDING', raw)
    expect(() => applicationUserId('user_new')).toThrow()
  })
  it('binds sessions to the exact issuer and both configured public keys', () => {
    expect(() => assertClerkSessionBinding({ iss: binding.issuer })).not.toThrow()
    expect(() => assertClerkSessionBinding({ iss: 'https://other.example' })).toThrow()
    expect(() => assertClerkSessionBinding(null)).toThrow()
    vi.stubEnv(
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
      `pk_live_${Buffer.from('other.example$').toString('base64')}`,
    )
    expect(() => applicationUserId('user_productionTom')).toThrow()
  })
  it('rejects development keys and binds signed webhooks to instance and signing key', () => {
    expect(() =>
      assertClerkWebhookBinding({ instance_id: binding.instanceId }, 'synthetic-secret'),
    ).not.toThrow()
    expect(() =>
      assertClerkWebhookBinding({ instance_id: 'ins_other' }, 'synthetic-secret'),
    ).toThrow()
    expect(() => assertClerkWebhookBinding({}, 'synthetic-secret')).toThrow()
    expect(() =>
      assertClerkWebhookBinding({ instance_id: binding.instanceId }, 'other-secret'),
    ).toThrow()
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_synthetic')
    expect(() => applicationUserId('user_productionTom')).toThrow()
  })
  it('preserves ordinary unconfigured staging behavior', () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT', 'staging')
    vi.stubEnv('CLERK_IDENTITY_BINDING', undefined)
    expect(applicationTenantId('tenant_fixture')).toBe('tenant_fixture')
    expect(applicationUserId('user_originalTom')).toBe('user_originalTom')
    expect(() => assertClerkSessionBinding(undefined)).not.toThrow()
    expect(() => assertClerkWebhookBinding({}, 'staging-secret')).not.toThrow()
  })

  it('refuses production identity fallback when deployment omitted the map', () => {
    vi.stubEnv('RAILWAY_ENVIRONMENT', 'production')
    vi.stubEnv('CLERK_IDENTITY_BINDING', undefined)
    expect(() => applicationUserId('user_new')).toThrow('binding validation failed')
    expect(() => providerOrganizationId('org_old')).toThrow('binding validation failed')
  })
})
