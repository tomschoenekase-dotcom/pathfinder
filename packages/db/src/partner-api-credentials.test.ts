import { describe, expect, it } from 'vitest'

import {
  createPartnerApiCredentialService,
  PartnerApiCredentialConfigurationError,
  PartnerApiCredentialNotFoundError,
  type PartnerApiCredentialRecord,
  type PartnerApiCredentialRepository,
} from './partner-api-credentials'

const pepper = 'test-only-partner-api-pepper-with-at-least-32-bytes'
const input = {
  tenantId: 'tenant-a',
  clientId: 'tenant-a',
  venueIds: ['venue-a'],
  capabilities: ['clients:read', 'venues:read'] as const,
  label: 'Stadium app',
  createdByUserId: 'platform-admin-a',
}

function harness() {
  const records = new Map<string, PartnerApiCredentialRecord>()
  const venueTenantById = new Map([
    ['venue-a', 'tenant-a'],
    ['venue-b', 'tenant-b'],
  ])
  let nextId = 0
  const repository: PartnerApiCredentialRepository = {
    async create(data) {
      const record: PartnerApiCredentialRecord = {
        ...data,
        id: `credential-${++nextId}`,
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
      }
      records.set(record.id, record)
      return record
    },
    async findByPublicId(publicId) {
      return [...records.values()].find((record) => record.publicId === publicId) ?? null
    },
    async findById(id, tenantId) {
      const record = records.get(id)
      return record?.tenantId === tenantId ? record : null
    },
    async listByTenant(tenantId) {
      return [...records.values()].filter((record) => record.tenantId === tenantId)
    },
    async venueIdsBelongToTenant(tenantId, venueIds) {
      return venueIds.every((venueId) => venueTenantById.get(venueId) === tenantId)
    },
    async update(id, tenantId, data) {
      const existing = records.get(id)
      if (!existing || existing.tenantId !== tenantId) throw new Error('not found')
      const updated = { ...existing, ...data }
      records.set(id, updated)
      return updated
    },
  }
  return {
    records,
    venueTenantById,
    service: createPartnerApiCredentialService({ repository, pepper, environment: 'test' }),
  }
}

describe('partner API credential service', () => {
  it('stores only a keyed digest and returns exact safe scope after valid verification', async () => {
    const { records, service } = harness()
    const { credential, token } = await service.create(input)
    const stored = records.get(credential.id)!

    expect(token).toMatch(/^tk_test_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/)
    expect(stored.secretHmac).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.secretHmac).not.toContain(token.split('_').at(-1)!)
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(await service.verify(token, new Date('2026-09-28T11:00:00.000Z'))).toEqual({
      credentialId: credential.id,
      publicId: credential.publicId,
      tenantId: 'tenant-a',
      clientId: 'tenant-a',
      venueIds: ['venue-a'],
      capabilities: ['clients:read', 'venues:read'],
    })
    expect(records.get(credential.id)?.lastUsedAt).toEqual(new Date('2026-09-28T11:00:00.000Z'))
  })

  it('keeps the old key valid through rotation and revocation invalidates it immediately', async () => {
    const { service } = harness()
    const first = await service.create(input)
    const second = await service.rotate({
      id: first.credential.id,
      tenantId: 'tenant-a',
      createdByUserId: 'platform-admin-b',
    })

    expect(second.credential.rotatedFromId).toBe(first.credential.id)
    expect(await service.verify(first.token)).not.toBeNull()
    expect(await service.verify(second.token)).not.toBeNull()

    await service.revoke({
      id: first.credential.id,
      tenantId: 'tenant-a',
      reason: 'Routine rotation',
    })
    expect(await service.verify(first.token)).toBeNull()
    expect(await service.verify(second.token)).not.toBeNull()
  })

  it('rejects expired, malformed, wrong-environment, and unknown credentials', async () => {
    const { service } = harness()
    const expired = await service.create({
      ...input,
      expiresAt: new Date('2026-09-28T10:59:59.999Z'),
    })
    const active = await service.create(input)

    expect(await service.verify(expired.token, new Date('2026-09-28T11:00:00.000Z'))).toBeNull()
    expect(await service.verify(active.token.replace('tk_test_', 'tk_live_'))).toBeNull()
    expect(await service.verify(`${active.token}&other=1`)).toBeNull()
    expect(await service.verify('malformed')).toBeNull()
  })

  it('scopes management reads and mutations to tenant and validates service configuration', async () => {
    const { service } = harness()
    const created = await service.create(input)
    await expect(
      service.rotate({
        id: created.credential.id,
        tenantId: 'tenant-b',
        createdByUserId: 'platform-admin-a',
      }),
    ).rejects.toBeInstanceOf(PartnerApiCredentialNotFoundError)
    await expect(
      service.revoke({
        id: created.credential.id,
        tenantId: 'tenant-b',
        reason: 'Wrong tenant',
      }),
    ).rejects.toBeInstanceOf(PartnerApiCredentialNotFoundError)
    expect(await service.list('tenant-b')).toEqual([])
    expect(() =>
      createPartnerApiCredentialService({
        repository: {} as PartnerApiCredentialRepository,
        pepper: 'short',
        environment: 'test',
      }),
    ).toThrow(PartnerApiCredentialConfigurationError)
  })

  it('rejects a client identifier that is not the owning tenant', async () => {
    const { service } = harness()
    await expect(service.create({ ...input, clientId: 'tenant-b' })).rejects.toThrow(
      'Client must match tenant scope.',
    )
  })

  it('rejects cross-tenant and nonexistent venue IDs when creating a credential', async () => {
    const { service } = harness()

    await expect(service.create({ ...input, venueIds: ['venue-b'] })).rejects.toThrow(
      'Venue scope must belong to the client tenant.',
    )
    await expect(service.create({ ...input, venueIds: ['venue-missing'] })).rejects.toThrow(
      'Venue scope must belong to the client tenant.',
    )
  })

  it('rejects a credential during verification if any scoped venue is missing or changes tenant', async () => {
    const { service, venueTenantById } = harness()
    const created = await service.create(input)

    venueTenantById.delete('venue-a')
    await expect(service.verify(created.token)).resolves.toBeNull()

    venueTenantById.set('venue-a', 'tenant-b')
    await expect(service.verify(created.token)).resolves.toBeNull()
  })
})
