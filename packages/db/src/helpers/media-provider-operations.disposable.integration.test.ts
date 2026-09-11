import { randomUUID } from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import {
  claimMediaProviderOperation,
  confirmMediaProviderOperationCleanup,
  markMediaProviderOperationAmbiguous,
  markMediaProviderOperationDispatched,
  prepareMediaProviderOperation,
  recordMediaProviderOperationOutput,
} from './media-provider-operations'

function isDisposableDatabase() {
  if (process.env.RUN_MEDIA_PROVIDER_OPERATION_DB_INTEGRATION !== '1') return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? '')
    return (
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      /^pathfinder_disposable_[a-z0-9_]+$/u.test(url.pathname.slice(1))
    )
  } catch {
    return false
  }
}

const integrationDescribe = isDisposableDatabase() ? describe : describe.skip

integrationDescribe('media provider operation receipts (disposable PostgreSQL)', () => {
  const suffix = randomUUID()
  const tenantId = `media-provider-tenant-${suffix}`
  const venueId = `media-provider-venue-${suffix}`
  const projectId = `media-provider-project-${suffix}`
  const uploadAttemptId = randomUUID()
  const identity = {
    tenantId,
    venueId,
    projectId,
    uploadAttemptId,
    sourceId: 'video-0001',
    provider: 'google',
    model: 'gemini-3.7-flash',
    method: 'files-api+models.generateContent',
    inputSha256: 'a'.repeat(64),
    promptSha256: 'b'.repeat(64),
    extractionSchemaVersion: 'media-analysis-v1',
    plannedProviderFileName: `files/torchiko-${suffix}`,
  }

  beforeAll(async () => {
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Media receipt', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Receipt venue', slug: venueId },
      })
      await db.mediaIngestionProject.create({
        data: { id: projectId, tenantId, venueId, name: 'Receipt project', createdBy: 'fixture' },
      })
    })
  })

  it('fences dispatch, stores output before exact cleanup, and prevents replay', async () => {
    const prepared = await prepareMediaProviderOperation(identity)
    await expect(
      prepareMediaProviderOperation({ ...identity, inputSha256: 'c'.repeat(64) }),
    ).rejects.toThrow('identity-conflict')
    const claim = await claimMediaProviderOperation({ id: prepared.id, tenantId })
    expect(claim).not.toBeNull()
    await expect(claimMediaProviderOperation({ id: prepared.id, tenantId })).resolves.toBeNull()
    let revision = await markMediaProviderOperationDispatched(
      { id: prepared.id, tenantId, leaseToken: claim!.leaseToken, revision: claim!.revision },
      'budget-reservation-1',
    )
    revision = await recordMediaProviderOperationOutput(
      { id: prepared.id, tenantId, leaseToken: claim!.leaseToken, revision },
      {
        result: {
          summary: 'Observed fixture',
          visibleText: [],
          objects: [],
          spatialClues: [],
          uncertainties: [],
          observations: [],
        },
        responseText: '{"summary":"Observed fixture"}',
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    )
    await confirmMediaProviderOperationCleanup({
      id: prepared.id,
      tenantId,
      leaseToken: claim!.leaseToken,
      revision,
    })
    const retained = await withTenantIsolationBypass(() =>
      db.mediaProviderOperation.findFirstOrThrow({ where: { id: prepared.id, tenantId } }),
    )
    expect(retained).toMatchObject({
      dispatchState: 'DISPATCHED',
      outcomeState: 'OBSERVED',
      cleanupState: 'CONFIRMED',
      result: expect.objectContaining({ summary: 'Observed fixture' }),
      leaseToken: null,
    })
    const reclaimed = await claimMediaProviderOperation({ id: prepared.id, tenantId })
    await expect(
      markMediaProviderOperationDispatched(
        {
          id: prepared.id,
          tenantId,
          leaseToken: reclaimed!.leaseToken,
          revision: reclaimed!.revision,
        },
        'budget-reservation-2',
      ),
    ).rejects.toThrow('fence-lost')
  })

  it('retains an ambiguous terminal outcome independently from confirmed cleanup', async () => {
    const prepared = await prepareMediaProviderOperation({ ...identity, sourceId: 'video-0002' })
    const claim = (await claimMediaProviderOperation({ id: prepared.id, tenantId }))!
    let revision = await markMediaProviderOperationDispatched(
      { id: prepared.id, tenantId, leaseToken: claim.leaseToken, revision: claim.revision },
      'budget-reservation-2',
    )
    revision = await markMediaProviderOperationAmbiguous(
      { id: prepared.id, tenantId, leaseToken: claim.leaseToken, revision },
      'provider-timeout',
    )
    await confirmMediaProviderOperationCleanup({
      id: prepared.id,
      tenantId,
      leaseToken: claim.leaseToken,
      revision,
    })
    await expect(
      withTenantIsolationBypass(() =>
        db.mediaProviderOperation.findFirstOrThrow({ where: { id: prepared.id, tenantId } }),
      ),
    ).resolves.toMatchObject({ outcomeState: 'AMBIGUOUS', cleanupState: 'CONFIRMED' })
  })

  it('freezes the exact dispatch instant even when preparation crossed the pricing boundary', async () => {
    const prepared = await prepareMediaProviderOperation({ ...identity, sourceId: 'video-0003' })
    await withTenantIsolationBypass(() =>
      db.mediaProviderOperation.update({
        where: { id: prepared.id },
        data: { createdAt: new Date('2026-12-31T23:59:59.000Z') },
      }),
    )
    const claim = (await claimMediaProviderOperation({ id: prepared.id, tenantId }))!
    const invocationAt = new Date('2027-01-01T00:00:00.000Z')
    await markMediaProviderOperationDispatched(
      { id: prepared.id, tenantId, leaseToken: claim.leaseToken, revision: claim.revision },
      'budget-reservation-boundary',
      invocationAt,
    )
    await expect(
      withTenantIsolationBypass(() =>
        db.mediaProviderOperation.findFirstOrThrow({ where: { id: prepared.id, tenantId } }),
      ),
    ).resolves.toMatchObject({
      createdAt: new Date('2026-12-31T23:59:59.000Z'),
      dispatchedAt: invocationAt,
    })
  })
})
