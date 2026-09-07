import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'

const enabled =
  process.env.RUN_MEDIA_ENTITY_RESOLUTION_REVISION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)(
  'media entity resolution revision ledger on disposable PostgreSQL',
  () => {
    afterAll(async () => db.$disconnect())

    it('enforces exact review generation, sequential revisions, scope, requests, and immutability', async () => {
      await withTenantIsolationBypass(async () => {
        const suffix = randomUUID().slice(0, 8)
        const tenantId = `resolution-${suffix}`
        const venueId = `venue-${suffix}`
        const projectId = `project-${suffix}`
        const sourceGeneration = randomUUID()
        const uploadAttemptId = randomUUID()
        await db.tenant.create({
          data: { id: tenantId, slug: tenantId, name: 'Resolution fixture' },
        })
        await db.venue.create({ data: { id: venueId, tenantId, slug: venueId, name: 'Museum' } })
        await db.mediaIngestionProject.create({
          data: {
            id: projectId,
            tenantId,
            venueId,
            name: 'Review set',
            createdBy: 'reviewer-1',
            status: 'READY_FOR_REVIEW',
            stage: 'review',
            sourceObjectGeneration: sourceGeneration,
            uploadAttemptId,
          },
        })
        const state = {
          version: 1,
          scope: { tenantId, projectId, uploadAttemptId },
          candidates: [],
          decisions: [],
        }
        const evidenceSnapshot = {
          scope: state.scope,
          sourceGeneration,
          candidates: [],
          evidence: [],
        }
        let persistedDecisions: Array<Record<string, unknown>> = []
        const decisionFor = (requestId: string, actorId: string, revision: number) => ({
          kind: 'MERGE',
          requestId,
          reviewerId: actorId,
          rationale: `revision ${revision}`,
          candidateIds: ['candidate-1', 'candidate-2'],
          representativeId: 'candidate-1',
        })
        const create = (overrides: Record<string, unknown> = {}) => {
          const revision = (overrides.revision as number | undefined) ?? 1
          const requestId = (overrides.requestId as string | undefined) ?? randomUUID()
          const actorId = (overrides.actorId as string | undefined) ?? 'reviewer-1'
          const decision = decisionFor(requestId, actorId, revision)
          const nextState =
            revision === 1 ? state : { ...state, decisions: [...persistedDecisions, decision] }
          return db.mediaEntityResolutionRevision.create({
            data: {
              tenantId,
              venueId,
              projectId,
              sourceGeneration,
              revision,
              requestId,
              requestHash: 'a'.repeat(64),
              evidenceSnapshotHash: 'b'.repeat(64),
              evidenceSnapshot,
              state: nextState,
              actorId,
              ...overrides,
            },
          })
        }

        const firstRequestId = randomUUID()
        const first = await create({ requestId: firstRequestId })
        await expect(create({ requestId: firstRequestId, revision: 2 })).rejects.toThrow()
        await expect(create({ revision: 3 })).rejects.toThrow(/next exact generation revision/u)
        await expect(
          create({
            revision: 2,
            state: { ...state, scope: { ...state.scope, tenantId: 'other' }, decisions: [{}] },
          }),
        ).rejects.toThrow(/state scope/u)
        await expect(
          create({
            revision: 2,
            state: { ...state, version: '1', decisions: [{}] },
          }),
        ).rejects.toThrow(/state scope/u)
        await expect(
          create({
            revision: 2,
            evidenceSnapshot: {
              ...evidenceSnapshot,
              scope: { ...evidenceSnapshot.scope, uploadAttemptId: randomUUID() },
            },
          }),
        ).rejects.toThrow(/evidence snapshot/u)
        await expect(create({ revision: 2, sourceGeneration: randomUUID() })).rejects.toThrow(
          /source generation/u,
        )

        const secondRequestId = randomUUID()
        const second = await create({ revision: 2, requestId: secondRequestId })
        expect(second.revision).toBe(2)
        persistedDecisions = [decisionFor(secondRequestId, 'reviewer-1', 2)]
        await expect(
          create({
            revision: 3,
            evidenceSnapshot: { ...evidenceSnapshot, candidates: ['tampered'] },
          }),
        ).rejects.toThrow(/evidence snapshot|immutable evidence/u)
        const tamperedRequestId = randomUUID()
        await expect(
          create({
            revision: 3,
            requestId: tamperedRequestId,
            state: {
              ...state,
              candidates: [{ candidateId: 'injected' }],
              decisions: [...persistedDecisions, decisionFor(tamperedRequestId, 'reviewer-1', 3)],
            },
          }),
        ).rejects.toThrow(/evidence snapshot|immutable evidence/u)
        const concurrent = await Promise.allSettled([
          create({ revision: 3 }),
          create({ revision: 3 }),
        ])
        expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1)
        await expect(
          db.mediaEntityResolutionRevision.update({
            where: { id: first.id },
            data: { actorId: 'rewriter' },
          }),
        ).rejects.toThrow(/append-only/iu)
        await expect(
          db.mediaEntityResolutionRevision.delete({ where: { id: second.id } }),
        ).rejects.toThrow(/append-only/iu)

        await db.mediaIngestionProject.update({
          where: { id: projectId },
          data: { stage: 'complete' },
        })
        await expect(create({ revision: 4 })).rejects.toThrow(/ready for review/u)
        expect(
          await db.mediaEntityResolutionRevision.findMany({
            where: { tenantId, venueId, projectId, sourceGeneration },
            orderBy: { revision: 'asc' },
            select: { revision: true },
          }),
        ).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }])
      })
    })
  },
)
