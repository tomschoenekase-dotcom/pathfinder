import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { db, recordWebsiteResearchReceiptAction, withTenantIsolationBypass } from '@pathfinder/db'

import { executeWebsiteIntakeResearch } from './website-intake-research-service'
import type { WebsiteIntakeDependencies } from './website-intake'

const enabled =
  process.env.RUN_WEBSITE_DISCOVERY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_website_discovery_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const observedAt = new Date('2026-09-08T15:00:00.000Z')
const rootUrl = 'https://example.org/'
const pdfUrl = 'https://example.org/visitor-guide.pdf'
const detailUrl = 'https://example.org/accessibility'
const rootBytes = new TextEncoder().encode('<html>synthetic root</html>')
const detailBytes = new TextEncoder().encode('<html>synthetic accessibility</html>')
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

function request(input: {
  operationId: string
  tenantId: string
  venueId: string
  runId: string
  maxPages?: number
}) {
  return {
    operationId: input.operationId,
    tenantId: input.tenantId,
    venueId: input.venueId,
    runId: input.runId,
    maxPages: input.maxPages ?? 2,
    maxDepth: 1,
    maxBytesPerPage: 10_000,
    maxDurationMs: 30_000,
    maxCostUnits: 10,
    userAgent: 'TorchikoWebsiteDiscoveryProof/1.0',
    createdBy: 'website-discovery-proof-admin',
  }
}

function dependencies(
  fetchPage: WebsiteIntakeDependencies['fetchPage'],
): WebsiteIntakeDependencies {
  return {
    resolveHostname: vi.fn(async () => ['93.184.216.34']),
    robots: { canFetch: vi.fn(async () => true) },
    fetchPage,
    extractPage: vi.fn(async ({ url }) =>
      url === rootUrl
        ? {
            links: [pdfUrl, detailUrl],
            facts: [
              {
                fieldPath: 'venue.name',
                value: 'Synthetic Conservatory',
                confidence: 0.95,
                locator: 'title',
              },
            ],
          }
        : {
            links: [],
            facts: [
              {
                fieldPath: 'venue.accessibility.arrival',
                value: 'The greenhouse entrance is step-free.',
                confidence: 0.9,
                locator: 'greenhouse',
              },
            ],
          },
    ),
    now: () => observedAt,
  }
}

describe.skipIf(!enabled)('website source discovery disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('retains bounded mixed-source discovery, inaccessible inventory, replay, and append-only truth', async () => {
    {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
      const tenantId = `tenant-discovery-${suffix}`
      const venueId = `venue-discovery-${suffix}`
      const unsupportedVenueId = `venue-unsupported-${suffix}`
      const otherVenueId = `venue-other-${suffix}`
      const runId = `run-discovery-${suffix}`
      const unsupportedRunId = `run-unsupported-${suffix}`
      const operationId = randomUUID()
      const unsupportedOperationId = randomUUID()

      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: tenantId, name: 'Website discovery proof', slug: tenantId },
        })
        await db.venue.createMany({
          data: [
            { id: venueId, tenantId, name: 'Mixed source venue', slug: venueId },
            {
              id: unsupportedVenueId,
              tenantId,
              name: 'Unsupported source venue',
              slug: unsupportedVenueId,
            },
            { id: otherVenueId, tenantId, name: 'Other scoped venue', slug: otherVenueId },
          ],
        })
        await db.intakeRun.createMany({
          data: [
            {
              id: runId,
              tenantId,
              venueId,
              sourceKind: 'WEBSITE',
              status: 'AWAITING_REVIEW',
              displayName: 'Mixed website source',
              websiteUri: rootUrl,
              requestedBy: 'website-discovery-proof-admin',
            },
            {
              id: unsupportedRunId,
              tenantId,
              venueId: unsupportedVenueId,
              sourceKind: 'WEBSITE',
              status: 'AWAITING_REVIEW',
              displayName: 'Unsupported website source',
              websiteUri: pdfUrl,
              requestedBy: 'website-discovery-proof-admin',
            },
          ],
        })
      })

      const fetch = vi.fn(async ({ url }: { url: string }) => {
        if (url === rootUrl)
          return { status: 200, headers: { 'content-type': 'text/html' }, body: rootBytes }
        if (url === detailUrl)
          return {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: detailBytes,
          }
        throw new Error(`Unexpected synthetic fetch: ${url}`)
      })
      const mixedDependencies = dependencies(fetch as WebsiteIntakeDependencies['fetchPage'])
      const mixedRequest = request({ operationId, tenantId, venueId, runId })
      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: mixedRequest,
          dependencies: mixedDependencies,
          now: () => observedAt,
        }),
      ).resolves.toMatchObject({
        outcome: 'SUCCEEDED',
        replayed: false,
        evidenceRecorded: true,
        packageDraftCreated: false,
        autoApproved: false,
        autoApplied: false,
        autoPublished: false,
      })
      expect(fetch.mock.calls.map(([call]) => call.url)).toEqual([rootUrl, detailUrl])

      const mixedReceipt = await db.intakeWebsiteResearchReceipt.findFirstOrThrow({
        where: { id: operationId, tenantId, venueId, runId },
      })
      expect(mixedReceipt).toMatchObject({
        outcome: 'SUCCEEDED',
        attemptedFetches: 2,
        fetchedPages: 2,
        fetchedBytes: rootBytes.byteLength + detailBytes.byteLength,
        errorCode: null,
      })
      expect(mixedReceipt.discoverySnapshot).toEqual({
        policyVersion: 1,
        observedAt: observedAt.toISOString(),
        omittedCount: 0,
        items: [
          {
            url: rootUrl,
            parentUrl: null,
            depth: 0,
            observedAt: observedAt.toISOString(),
            disposition: 'FETCHED_TEXT',
            contentType: 'text/html',
            byteSize: rootBytes.byteLength,
            exactByteHash: sha256(rootBytes),
          },
          {
            url: pdfUrl,
            parentUrl: rootUrl,
            depth: 1,
            observedAt: observedAt.toISOString(),
            disposition: 'UNSUPPORTED_DOCUMENT',
          },
          {
            url: detailUrl,
            parentUrl: rootUrl,
            depth: 1,
            observedAt: observedAt.toISOString(),
            disposition: 'FETCHED_TEXT',
            contentType: 'text/html',
            byteSize: detailBytes.byteLength,
            exactByteHash: sha256(detailBytes),
          },
        ],
      })
      expect(mixedReceipt.researchSnapshot).not.toBeNull()
      expect(mixedReceipt.candidateSnapshot).toEqual({
        kind: 'TYPED_INTERMEDIATE',
        draftInput: null,
      })
      const evidence = await db.intakeEvidenceRecord.findMany({
        where: { tenantId, venueId, runId },
        orderBy: { locator: 'asc' },
      })
      expect(evidence).toEqual([
        expect.objectContaining({
          sourceKind: 'WEBSITE',
          locator: `${rootUrl}#title`,
          normalizedHash: sha256('synthetic conservatory'),
          capturedAt: observedAt,
        }),
        expect.objectContaining({
          sourceKind: 'WEBSITE',
          locator: `${detailUrl}#greenhouse`,
          normalizedHash: sha256('the greenhouse entrance is step-free.'),
          capturedAt: observedAt,
        }),
      ])

      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: mixedRequest,
          dependencies: mixedDependencies,
          now: () => observedAt,
        }),
      ).resolves.toMatchObject({ outcome: 'SUCCEEDED', replayed: true })
      expect(fetch).toHaveBeenCalledTimes(2)
      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: { ...mixedRequest, maxPages: 3 },
          dependencies: mixedDependencies,
          now: () => observedAt,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(fetch).toHaveBeenCalledTimes(2)

      const unsupportedFetch = vi.fn()
      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: request({
            operationId: unsupportedOperationId,
            tenantId,
            venueId: unsupportedVenueId,
            runId: unsupportedRunId,
          }),
          dependencies: dependencies(unsupportedFetch),
          now: () => observedAt,
        }),
      ).resolves.toMatchObject({
        outcome: 'INACCESSIBLE',
        replayed: false,
        evidenceRecorded: false,
      })
      expect(unsupportedFetch).not.toHaveBeenCalled()
      const unsupportedReceipt = await db.intakeWebsiteResearchReceipt.findFirstOrThrow({
        where: {
          id: unsupportedOperationId,
          tenantId,
          venueId: unsupportedVenueId,
          runId: unsupportedRunId,
        },
      })
      expect(unsupportedReceipt).toMatchObject({
        outcome: 'INACCESSIBLE',
        researchSnapshot: null,
        candidateSnapshot: null,
        attemptedFetches: 0,
        fetchedPages: 0,
        fetchedBytes: 0,
        errorCode: 'NO_ACCESSIBLE_PAGES',
        discoverySnapshot: {
          policyVersion: 1,
          observedAt: observedAt.toISOString(),
          omittedCount: 0,
          items: [
            {
              url: pdfUrl,
              parentUrl: null,
              depth: 0,
              observedAt: observedAt.toISOString(),
              disposition: 'UNSUPPORTED_DOCUMENT',
            },
          ],
        },
      })
      expect(
        await db.intakeEvidenceRecord.count({
          where: { tenantId, venueId: unsupportedVenueId, runId: unsupportedRunId },
        }),
      ).toBe(0)

      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: request({ operationId, tenantId, venueId: otherVenueId, runId }),
          dependencies: dependencies(fetch as WebsiteIntakeDependencies['fetchPage']),
          now: () => observedAt,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        executeWebsiteIntakeResearch({
          db,
          request: request({ operationId, tenantId: 'tenant-wrong', venueId, runId }),
          dependencies: dependencies(fetch as WebsiteIntakeDependencies['fetchPage']),
          now: () => observedAt,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(fetch).toHaveBeenCalledTimes(2)

      await expect(
        recordWebsiteResearchReceiptAction({
          operationId: randomUUID(),
          tenantId,
          venueId: unsupportedVenueId,
          runId: unsupportedRunId,
          priorReceiptId: unsupportedOperationId,
          requestHash: 'a'.repeat(64),
          sourceUriHash: sha256(pdfUrl),
          bounds: {
            maxPages: 2,
            maxDepth: 1,
            maxBytesPerPage: 10_000,
            allowedHosts: ['example.org'],
            respectRobots: true,
            publishMode: 'DRAFT_ONLY',
          },
          outcome: 'INACCESSIBLE',
          discoverySnapshot: {
            policyVersion: 1,
            observedAt: observedAt.toISOString(),
            omittedCount: 0,
            items: [
              {
                url: 'http://127.0.0.1/private',
                parentUrl: null,
                depth: 0,
                observedAt: observedAt.toISOString(),
                disposition: 'UNSUPPORTED_OTHER',
              },
            ],
          },
          evidence: [],
          discrepancies: [],
          attemptedFetches: 0,
          fetchedPages: 0,
          fetchedBytes: 0,
          estimatedCostUnits: 0,
          latencyMs: 0,
          errorCode: 'NO_ACCESSIBLE_PAGES',
          createdBy: 'website-discovery-proof-admin',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

      await expect(
        db.$executeRawUnsafe(
          'UPDATE "intake_website_research_receipts" SET "latency_ms" = 1 WHERE "id" = $1::uuid',
          operationId,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe(
          'DELETE FROM "intake_website_research_receipts" WHERE "id" = $1::uuid',
          operationId,
        ),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "intake_website_research_receipts" (
            "id", "tenant_id", "venue_id", "run_id", "prior_receipt_id", "request_hash",
            "outcome", "source_uri_hash", "bounds", "research_snapshot", "candidate_snapshot",
            "discovery_snapshot", "attempted_fetches", "fetched_pages", "fetched_bytes",
            "estimated_cost_units", "latency_ms", "error_code", "error_message", "created_by"
          )
          SELECT $2::uuid, "tenant_id", "venue_id", "run_id", "prior_receipt_id", "request_hash",
            "outcome", "source_uri_hash", "bounds", "research_snapshot", "candidate_snapshot",
            '{}'::jsonb, "attempted_fetches", "fetched_pages", "fetched_bytes",
            "estimated_cost_units", "latency_ms", "error_code", "error_message", "created_by"
          FROM "intake_website_research_receipts" WHERE "id" = $1::uuid`,
          operationId,
          randomUUID(),
        ),
      ).rejects.toThrow(/discovery_snapshot_shape_check/u)
      expect(
        await db.intakeWebsiteResearchReceipt.count({ where: { tenantId, venueId, runId } }),
      ).toBe(1)
      expect(await db.intakeEvidenceRecord.count({ where: { tenantId, venueId, runId } })).toBe(2)
      expect(await db.intakePackageHandoff.count({ where: { tenantId, venueId, runId } })).toBe(0)
    }
  }, 30_000)
})
