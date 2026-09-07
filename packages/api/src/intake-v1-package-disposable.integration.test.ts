import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pathfinder/ai')>()
  return {
    ...actual,
    AI_EMBEDDING_MODEL_KEYS: {
      PLACE_CONTENT: 'place-content',
      KNOWLEDGE_CONTENT: 'knowledge-content',
    },
    getAiEmbeddingProfile: (key: string) => `integration-profile:${key}`,
    generateEmbeddings: vi.fn(async ({ texts, usageSink }) => {
      await usageSink({
        provider: 'integration-test',
        model: 'deterministic-embedding',
        pricingVersion: 'test-v1',
        usage: {
          inputTokens: texts.length,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        estimatedCostUsd: 0,
        latencyMs: 1,
        attempts: 1,
        success: true,
      })
      return {
        embeddings: texts.map((text: string, index: number) => {
          const vector = Array(1_536).fill(0)
          vector[(text.length + index) % vector.length] = 1
          return vector
        }),
      }
    }),
  }
})
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import {
  createIntakeProposal,
  db,
  submitOnboardingBootstrapAction,
  submitIntakeV1Action,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { buildIntakeV1PackageCandidate } from './lib/intake-v1-package-candidate'
import { createIntakeV1PackageDraftForAdmin } from './lib/intake-v1-package-draft'

const enabled =
  process.env.RUN_INTAKE_V1_PACKAGE_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_intake_v1_package_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('V1 package candidate and handoff disposable journey', () => {
  afterAll(async () => db.$disconnect())

  it('freezes one explicit partial selection into one canonical review-only draft', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-v1-package-${suffix}`
      const otherTenantId = `tenant-v1-package-other-${suffix}`
      const otherVenueId = `venue-v1-package-other-${suffix}`
      const ownerUserId = `owner-v1-package-${suffix}`
      const actor = { type: 'HUMAN' as const, id: ownerUserId, role: 'MANAGER' as const }

      await db.tenant.create({ data: { id: tenantId, name: 'V1 package fixture', slug: tenantId } })
      await db.tenant.create({
        data: { id: otherTenantId, name: 'Other V1 package fixture', slug: otherTenantId },
      })
      await db.user.create({
        data: { id: ownerUserId, email: `${ownerUserId}@example.test`, fullName: 'V1 owner' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerUserId, role: 'MANAGER', joinedAt: new Date() },
      })
      const bootstrap = await submitOnboardingBootstrapAction({
        tenantId,
        actor,
        submission: {
          requestId: randomUUID(),
          venue: {
            name: 'V1 package venue',
            slug: `v1-package-${suffix}`,
            guideMode: 'non_location',
          },
          rawContent: {
            kind: 'knowledge',
            value: {
              title: 'Accessible entrance',
              category: 'ACCESSIBILITY',
              content: 'The east entrance is step-free.',
            },
          },
        },
      })
      const venueId = bootstrap.venue.id
      await db.venue.create({
        data: {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: 'Other package venue',
          slug: otherVenueId,
        },
      })

      const second = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: { kind: 'NOTES', notes: 'Visitor services are beside the main desk.' },
      })
      const website = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Fixture website',
          websiteUri: 'https://fixture.example.test',
        },
      })
      const submitted = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [bootstrap.runId, second.id, website.id],
          intakeUploadIds: [],
        },
      })
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { submissionId: submitted.submissionId, revision: 1, tenantId, venueId },
        include: { members: { orderBy: { ordinal: 'asc' } } },
      })
      const firstMember = revision.members.find((member) => member.intakeRunId === bootstrap.runId)!
      const websiteMember = revision.members.find((member) => member.intakeRunId === website.id)!

      const preview = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: 1,
        selectedMemberIds: [firstMember.id],
      })
      expect(preview).toMatchObject({
        ready: true,
        revisionId: revision.id,
        manifestHash: submitted.manifestHash,
        selectedMemberIds: [firstMember.id],
        autoApprove: false,
        autoApply: false,
        published: false,
      })
      expect(preview.remainingMemberIds).toHaveLength(2)
      expect(preview.payloadHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(preview.candidateHash).toMatch(/^[a-f0-9]{64}$/u)

      const waitingWebsite = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: 1,
        selectedMemberIds: [websiteMember.id],
      })
      expect(waitingWebsite.ready).toBe(false)
      expect(
        waitingWebsite.members.find(({ memberId }) => memberId === websiteMember.id)?.state,
      ).toBe('WAITING')
      expect(preview.ready).toBe(true)

      await expect(
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: {
            tenantId,
            venueId,
            submissionId: submitted.submissionId,
            revision: 1,
            operationId: randomUUID(),
            selectedMemberIds: [firstMember.id],
            expectedManifestHash: preview.manifestHash,
            expectedCandidateHash: preview.candidateHash!,
            expectedPayloadHash: preview.payloadHash!,
            partialAcknowledged: false,
          },
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(0)

      const failedOperationId = randomUUID()
      const injectedFailure = new Error('fixture V1 handoff create failure')
      const failingDb = db.$extends({
        query: {
          intakeV1PackageHandoff: {
            create() {
              throw injectedFailure
            },
          },
        },
      })
      await expect(
        createIntakeV1PackageDraftForAdmin({
          db: failingDb,
          actorId: ownerUserId,
          command: {
            tenantId,
            venueId,
            submissionId: submitted.submissionId,
            revision: 1,
            operationId: failedOperationId,
            selectedMemberIds: [firstMember.id],
            expectedManifestHash: preview.manifestHash,
            expectedCandidateHash: preview.candidateHash!,
            expectedPayloadHash: preview.payloadHash!,
            partialAcknowledged: true,
          },
        }),
      ).rejects.toThrow(injectedFailure.message)
      expect(
        await db.venuePackage.count({
          where: { tenantId, venueId, draftKey: failedOperationId },
        }),
      ).toBe(0)
      expect(
        await db.intakeV1PackageHandoff.count({
          where: { tenantId, venueId, operationId: failedOperationId },
        }),
      ).toBe(0)

      const packageOperationId = randomUUID()
      const command = {
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: 1,
        operationId: packageOperationId,
        selectedMemberIds: [firstMember.id],
        expectedManifestHash: preview.manifestHash,
        expectedCandidateHash: preview.candidateHash!,
        expectedPayloadHash: preview.payloadHash!,
        partialAcknowledged: true,
      }
      const concurrent = await Promise.allSettled([
        createIntakeV1PackageDraftForAdmin({ db, actorId: ownerUserId, command }),
        createIntakeV1PackageDraftForAdmin({ db, actorId: ownerUserId, command }),
      ])
      const successful = concurrent.find(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof createIntakeV1PackageDraftForAdmin>>
        > => result.status === 'fulfilled',
      )
      expect(successful).toBeDefined()
      const created = successful!.value
      const replay = await createIntakeV1PackageDraftForAdmin({
        db,
        actorId: ownerUserId,
        command,
      })
      expect(created.value.status).toBe('DRAFT')
      expect(replay.value.id).toBe(created.value.id)
      expect(replay.value.replayed).toBe(true)
      expect(await db.venuePackage.count({ where: { tenantId, venueId } })).toBe(1)
      const handoff = await db.intakeV1PackageHandoff.findFirstOrThrow({
        where: { tenantId, venueId, operationId: packageOperationId },
      })
      expect(handoff).toMatchObject({
        revisionId: revision.id,
        packageDraftId: created.value.id,
        manifestHash: preview.manifestHash,
        candidateHash: preview.candidateHash,
        payloadHash: preview.payloadHash,
        selectedMemberIds: [firstMember.id],
        partialAcknowledged: true,
        createdBy: ownerUserId,
      })

      await expect(
        createIntakeV1PackageDraftForAdmin({
          db,
          actorId: ownerUserId,
          command: { ...command, expectedCandidateHash: 'f'.repeat(64) },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        buildIntakeV1PackageCandidate({
          db,
          tenantId: otherTenantId,
          venueId: otherVenueId,
          submissionId: submitted.submissionId,
          revision: 1,
          selectedMemberIds: [firstMember.id],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await expect(
        db.$executeRaw`
          UPDATE intake_v1_submission_members
             SET immutable_hash = ${'f'.repeat(64)}
           WHERE id = ${firstMember.id}
             AND tenant_id = ${tenantId}
             AND venue_id = ${venueId}
        `,
      ).rejects.toThrow(/append-only/iu)
      expect(await db.intakeV1PackageHandoff.count({ where: { tenantId, venueId } })).toBe(1)
    })
  })
})
