import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordOperatingCostEvidenceAction } from './operating-cost-evidence-actions'

const enabled =
  process.env.RUN_OPERATING_COST_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_operating_cost_[a-z0-9]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('operating cost evidence disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('keeps scoped cost evidence idempotent, auditable, supersession-fenced, and append-only', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-cost-${suffix}`
      const otherTenantId = `tenant-cost-other-${suffix}`
      const venueId = `venue-cost-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: 'integration-operator',
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.createMany({
        data: [
          { id: tenantId, name: 'Synthetic cost tenant', slug: tenantId },
          { id: otherTenantId, name: 'Synthetic other tenant', slug: otherTenantId },
        ],
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic cost venue', slug: venueId },
      })

      const originalRequest = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        category: 'INFRASTRUCTURE' as const,
        evidenceKind: 'OBSERVED' as const,
        amountUsd: '18.25000000',
        quantity: '24.000000',
        quantityUnit: 'hours',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-02T00:00:00.000Z'),
        sourceSystem: 'synthetic-hosting-export',
        sourceReference: `line-${suffix}`,
        description: 'Synthetic venue-attributed infrastructure evidence.',
        actor,
      }
      const original = await recordOperatingCostEvidenceAction(originalRequest)
      expect(original).toMatchObject({ replayed: false, tenantId, venueId })
      await expect(recordOperatingCostEvidenceAction(originalRequest)).resolves.toMatchObject({
        id: original.id,
        replayed: true,
      })

      const correction = await recordOperatingCostEvidenceAction({
        ...originalRequest,
        operationId: randomUUID(),
        amountUsd: '17.75000000',
        description: 'Corrected synthetic venue-attributed infrastructure evidence.',
        supersedesId: original.id,
      })
      expect(correction.supersedesId).toBe(original.id)
      await expect(
        recordOperatingCostEvidenceAction({
          ...originalRequest,
          operationId: randomUUID(),
          tenantId: otherTenantId,
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_NOT_FOUND' })

      const concurrentBase = await recordOperatingCostEvidenceAction({
        ...originalRequest,
        operationId: randomUUID(),
        category: 'STORAGE',
        sourceSystem: 'synthetic-storage-export',
        sourceReference: `storage-${suffix}`,
        amountUsd: '2.00000000',
        quantity: undefined,
        quantityUnit: undefined,
        description: 'Synthetic storage evidence for the concurrency fence.',
      })
      const competing = await Promise.allSettled(
        ['2.10000000', '2.20000000'].map((amountUsd) =>
          recordOperatingCostEvidenceAction({
            ...originalRequest,
            operationId: randomUUID(),
            category: 'STORAGE',
            sourceSystem: 'synthetic-storage-export',
            sourceReference: `storage-correction-${amountUsd}-${suffix}`,
            amountUsd,
            quantity: undefined,
            quantityUnit: undefined,
            description: 'Competing storage correction.',
            supersedesId: concurrentBase.id,
          }),
        ),
      )
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(competing.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'SUPERSESSION_CONFLICT' },
      })

      const platformEvidence = await recordOperatingCostEvidenceAction({
        ...originalRequest,
        operationId: randomUUID(),
        tenantId: undefined,
        venueId: undefined,
        category: 'OBSERVABILITY',
        evidenceKind: 'ESTIMATED',
        sourceSystem: 'synthetic-monitoring-estimate',
        sourceReference: `platform-${suffix}`,
        amountUsd: '5.00000000',
        quantity: undefined,
        quantityUnit: undefined,
        description: 'Synthetic platform-wide monitoring estimate.',
      })
      expect(platformEvidence).toMatchObject({ tenantId: null, venueId: null })

      await expect(
        db.$executeRaw`UPDATE "operating_cost_evidence" SET "description" = 'mutated' WHERE "id" = ${original.id}::uuid`,
      ).rejects.toBeTruthy()
      await expect(
        db.$executeRaw`DELETE FROM "operating_cost_evidence" WHERE "id" = ${original.id}::uuid`,
      ).rejects.toBeTruthy()

      const rows = await db.operatingCostEvidence.findMany({
        where: {
          OR: [{ tenantId }, { id: platformEvidence.id }],
        },
        select: { id: true, supersedesId: true, supersededBy: { select: { id: true } } },
      })
      expect(rows.find((row) => row.id === original.id)?.supersededBy?.id).toBe(correction.id)
      expect(rows.filter((row) => row.supersedesId === concurrentBase.id)).toHaveLength(1)

      const evidenceCount = rows.length
      const audits = await db.auditLog.findMany({
        where: { action: 'operating-cost-evidence.recorded' },
        select: { targetId: true, afterState: true },
      })
      expect(audits).toHaveLength(evidenceCount)
      for (const audit of audits) {
        expect(audit.afterState).toMatchObject({
          affectsInvoices: false,
          affectsCustomerPricing: false,
          authorizesServiceCutoff: false,
        })
      }
      expect(await db.billingInvoiceProjection.count({ where: { tenantId } })).toBe(0)
    })
  })
})
