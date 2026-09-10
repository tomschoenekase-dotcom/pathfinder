import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { McpCapability } from '@pathfinder/contracts/mcp-v0'

import { db, withTenantIsolationBypass } from '../index'

const enabled =
  process.env.RUN_CREDENTIAL_CAPABILITY_PARITY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_capability_parity_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('credential capability parity disposable persistence', () => {
  afterAll(async () => db.$disconnect())

  it('admits declared character grants without weakening credential evidence guards', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-capability-${suffix}`
    const venueId = `venue-capability-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Grant parity fixture' },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, slug: venueId, name: 'Grant parity fixture venue' },
      })
    })

    // Disabled, deliberately unusable metadata only. No credential is issued to an actor,
    // no secret is generated or authenticated, and no provider/account is contacted.
    const createMetadata = (options: {
      capabilities: string[]
      kind?: 'MCP' | 'PARTNER_READ_API'
      enabled?: boolean
      omitReceipt?: boolean
    }) =>
      db.$transaction(async (transaction) => {
        const row = await transaction.externalAccessCredential.create({
          data: {
            tenantId,
            clientId: tenantId,
            venueId,
            scopeKey: venueId,
            kind: options.kind ?? 'MCP',
            label: 'Synthetic capability parity',
            capabilities: options.capabilities,
            secretPrefix: `fixture-${randomUUID().slice(0, 8)}`,
            secretHash: '$argon2id$not-a-real-credential',
            enabled: options.enabled ?? false,
            createdBy: 'fixture-operator',
          },
        })
        if (!options.omitReceipt) {
          await transaction.externalCredentialOperationReceipt.create({
            data: {
              operationId: randomUUID(),
              operationHash: 'a'.repeat(64),
              operationKind: 'ISSUE',
              tenantId,
              clientId: tenantId,
              venueId,
              scopeKey: venueId,
              credentialId: row.id,
              actorId: 'fixture-operator',
              createdAt: row.createdAt,
            },
          })
        }
        return { id: row.id }
      })

    const capabilities = [...McpCapability.options].sort()
    const acceptedRows: Array<{ id: string }> = []
    // Each credential retains the existing 50-capability bound; the catalog is larger.
    for (let offset = 0; offset < capabilities.length; offset += 25) {
      const batch = capabilities.slice(offset, offset + 25)
      const accepted = await createMetadata({ capabilities: batch })
      acceptedRows.push(accepted)
      expect(
        await db.externalAccessCredential.findFirstOrThrow({
          where: { id: accepted.id, tenantId },
          select: { enabled: true, capabilities: true, revokedAt: true },
        }),
      ).toEqual({ enabled: false, capabilities: batch, revokedAt: null })
    }
    const accepted = acceptedRows[0]!
    await expect(createMetadata({ capabilities: capabilities.slice(0, 51) })).rejects.toThrow(
      'external_credentials_capability_bound',
    )

    await expect(createMetadata({ capabilities: ['unknown:privilege'] })).rejects.toThrow(
      'unsupported MCP credential capability',
    )
    await expect(
      createMetadata({ capabilities: ['characters:build'], kind: 'PARTNER_READ_API' }),
    ).rejects.toThrow('unsupported partner credential capability')
    await expect(
      createMetadata({ capabilities: ['characters:execute', 'characters:build'] }),
    ).rejects.toThrow('external credential capabilities must be sorted and unique')
    await expect(
      createMetadata({ capabilities: ['characters:build', 'characters:build'] }),
    ).rejects.toThrow('external credential capabilities must be sorted and unique')
    await expect(
      createMetadata({ capabilities: ['characters:build'], omitReceipt: true }),
    ).rejects.toThrow('new external credential requires operation evidence')
    await expect(
      createMetadata({ capabilities: ['characters:execute'], enabled: true }),
    ).rejects.toThrow('new external credential must be disabled and unused')
    await expect(
      db.externalAccessCredential.update({
        where: { id: accepted.id, tenantId },
        data: { enabled: true, updatedAt: new Date(Date.now() + 1) },
      }),
    ).rejects.toThrow('enabled external credential requires exact activation evidence')
    const revokedAt = new Date()
    await expect(
      db.externalAccessCredential.update({
        where: { id: accepted.id, tenantId },
        data: { revokedAt, updatedAt: revokedAt },
      }),
    ).rejects.toThrow('external credential revocation requires exact timestamp evidence')
    expect(await db.externalAccessCredential.count({ where: { tenantId } })).toBe(
      acceptedRows.length,
    )
    expect(await db.externalCredentialOperationReceipt.count({ where: { tenantId } })).toBe(
      acceptedRows.length,
    )
    expect(
      await db.externalAccessCredential.findFirstOrThrow({
        where: { id: accepted.id, tenantId },
        select: { enabled: true, revokedAt: true },
      }),
    ).toEqual({ enabled: false, revokedAt: null })
  })
})
