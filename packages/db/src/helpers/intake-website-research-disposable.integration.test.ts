import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db, recordWebsiteResearchReceiptAction, withTenantIsolationBypass } from '../index'

const enabled =
  process.env.RUN_INTAKE_WEBSITE_RESEARCH_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('website research receipt disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('persists scoped retry lineage, terminal replay, append-only truth, and no downstream authority', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-website-${suffix}`
      const venueId = `venue-website-${suffix}`
      const runId = `run-website-${suffix}`
      const websiteUri = 'https://example.org/'
      const sourceUriHash = createHash('sha256').update(websiteUri).digest('hex')
      const requestHash = createHash('sha256').update(`failed:${suffix}`).digest('hex')
      const failedOperationId = randomUUID()

      await db.tenant.create({
        data: { id: tenantId, name: 'Website research tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Website Research Venue', slug: venueId },
      })
      await db.intakeRun.create({
        data: {
          id: runId,
          tenantId,
          venueId,
          sourceKind: 'WEBSITE',
          status: 'AWAITING_REVIEW',
          displayName: 'Disposable website',
          websiteUri,
          requestedBy: 'disposable-admin',
        },
      })

      const failureInput = {
        operationId: failedOperationId,
        tenantId,
        venueId,
        runId,
        requestHash,
        sourceUriHash,
        bounds: {
          maxPages: 5,
          maxDepth: 1,
          maxBytesPerPage: 1_000_000,
          allowedHosts: ['example.org'],
          respectRobots: true as const,
          publishMode: 'DRAFT_ONLY' as const,
        },
        outcome: 'FAILED' as const,
        evidence: [],
        discrepancies: [],
        attemptedFetches: 1,
        fetchedPages: 0,
        fetchedBytes: 0,
        estimatedCostUnits: 0,
        latencyMs: 10,
        errorCode: 'TIME_LIMIT',
        errorMessage: 'Disposable bounded timeout.',
        createdBy: 'disposable-admin',
      }
      expect(await recordWebsiteResearchReceiptAction(failureInput)).toMatchObject({
        replayed: false,
        outcome: 'FAILED',
      })
      expect(await recordWebsiteResearchReceiptAction(failureInput)).toMatchObject({
        replayed: true,
        outcome: 'FAILED',
      })

      const succeededOperationId = randomUUID()
      const evidenceId = randomUUID()
      const succeeded = await recordWebsiteResearchReceiptAction({
        ...failureInput,
        operationId: succeededOperationId,
        priorReceiptId: failedOperationId,
        requestHash: createHash('sha256').update(`succeeded:${suffix}`).digest('hex'),
        outcome: 'SUCCEEDED',
        researchSnapshot: {
          schemaVersion: 1,
          sourceId: runId,
          pages: [],
          citations: [],
          evidence: [],
          discrepancies: [],
        },
        candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
        evidence: [
          {
            id: evidenceId,
            sourceId: runId,
            locator: 'https://example.org/#title',
            normalizedHash: createHash('sha256').update('Example Hall').digest('hex'),
            confidence: 0.9,
            capturedAt: '2026-08-25T22:00:00.000Z',
          },
        ],
        attemptedFetches: 1,
        fetchedPages: 1,
        fetchedBytes: 100,
        estimatedCostUnits: 2,
        latencyMs: 20,
        errorCode: undefined,
        errorMessage: undefined,
      })
      expect(succeeded).toMatchObject({
        outcome: 'SUCCEEDED',
        evidenceRecorded: true,
        packageDraftCreated: false,
        autoApproved: false,
        autoApplied: false,
        autoPublished: false,
      })

      await expect(
        recordWebsiteResearchReceiptAction({
          ...failureInput,
          operationId: randomUUID(),
          priorReceiptId: succeededOperationId,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.intakeWebsiteResearchReceipt.update({
          where: { id: succeededOperationId },
          data: { latencyMs: 99 },
        }),
      ).rejects.toThrow(/append-only/u)

      expect(
        await db.intakeWebsiteResearchReceipt.count({ where: { tenantId, venueId, runId } }),
      ).toBe(2)
      expect(await db.intakeEvidenceRecord.count({ where: { tenantId, venueId, runId } })).toBe(1)
      expect(
        await db.intakeRunEvent.count({
          where: { tenantId, venueId, runId, kind: 'WEBSITE_RESEARCH_RECORDED' },
        }),
      ).toBe(2)
      expect(await db.intakePackageHandoff.count({ where: { tenantId, venueId, runId } })).toBe(0)
    })
  }, 30_000)
})
