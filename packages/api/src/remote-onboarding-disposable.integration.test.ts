import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  setOpenAiEmbeddingsClientForTesting,
  type AnthropicMessagesClient,
  type OpenAiEmbeddingsClient,
} from '@pathfinder/ai'

import {
  buildOnboardingEvaluationSuite,
  resolveRemoteOnboardingProjection,
} from '@pathfinder/contracts'
import { deploymentManifestHash } from '@pathfinder/contracts/venue-deployment-manifest'
import { createEvalObservation, scoreEvaluationChecks } from '@pathfinder/contracts/evaluation'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'
import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'
import {
  askAgentQuestionAction,
  acquireEmbeddingWork,
  claimEvaluationRunAttempt,
  claimIntakeUploadVerificationAction,
  createClientOnboardingQuestionAction,
  createIntakeProposal,
  createOrReplayEvaluationCase,
  createOrReplayEvaluationResult,
  createOrReplayEvaluationRun,
  db,
  evaluationSnapshotHash,
  finishEvaluationRunAttempt,
  getIntakeProposalReview,
  hashEvalObservation,
  markEvaluationRunQueued,
  recordApprovedPackageEvaluationMilestones,
  recordIntakeUploadPrecheckAction,
  recordOrReplayOnboardingMilestoneEvent,
  reserveIntakeUploadAction,
  respondToSupportInformationAction,
  resumeOnboardingQuestionFromSupportAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  storeKnowledgeEntryEmbeddingForScope,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from './core'
import type { TRPCContext } from './context'
import { reviewVenuePackageManifestService } from './lib/venue-package-manifest-service'
import { adminOffboardingExportPreviewRouter } from './routers/admin/offboarding-export-preview'
import { adminOffboardingPlansRouter } from './routers/admin/offboarding-plans'
import { adminReportConfigurationRouter } from './routers/admin/report-configuration'
import { adminWeeklyReportsRouter } from './routers/admin/weekly-reports'
import { analyticsRouter } from './routers/analytics'
import { _setAnthropicClientForTesting, chatRouter } from './routers/chat'
import { feedbackRouter } from './routers/feedback'
import { operationalUpdateRouter } from './routers/operational-update'
import { portalRouter } from './routers/portal'
import { venuePackageRouter } from './routers/venue-package'

const enabled = process.env.RUN_REMOTE_ONBOARDING_E2E_DB_INTEGRATION === '1'

function assertDisposableDatabase(): void {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Disposable lifecycle proof requires DATABASE_URL')
  const url = new URL(raw)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/^pathfinder_disposable_[a-z0-9_]+$/u.test(database)
  )
    throw new Error('Disposable lifecycle proof requires an exact-loopback disposable database')
}

const testRouter = router({
  admin: mergeRouters(
    adminOffboardingExportPreviewRouter,
    adminOffboardingPlansRouter,
    adminReportConfigurationRouter,
    adminWeeklyReportsRouter,
  ),
  analytics: analyticsRouter,
  chat: chatRouter,
  feedback: feedbackRouter,
  operationalUpdate: operationalUpdateRouter,
  portal: portalRouter,
  venuePackage: venuePackageRouter,
})

describe.skipIf(!enabled)('remote onboarding twenty-step disposable lifecycle', () => {
  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    setOpenAiEmbeddingsClientForTesting(null)
    await db.$disconnect()
  })

  it('proves invitation through exact rollback in one sanitized venue run', async () => {
    assertDisposableDatabase()
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `remote-proof-tenant-${suffix}`
      const ownerId = `remote-proof-owner-${suffix}`
      const operatorId = `remote-proof-operator-${suffix}`
      const actor = { type: 'HUMAN' as const, id: ownerId, role: 'OWNER' as const }
      const context: TRPCContext = {
        db,
        headers: new Headers(),
        session: {
          userId: ownerId,
          activeTenantId: tenantId,
          role: 'OWNER',
          isPlatformAdmin: false,
        },
      }
      const caller = testRouter.createCaller(context)
      const admin = testRouter.createCaller({
        db,
        headers: new Headers(),
        session: {
          userId: operatorId,
          activeTenantId: null,
          role: null,
          isPlatformAdmin: true,
        },
      }).admin
      const publicCaller = testRouter.createCaller({
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      })
      const openAiCreate = vi.fn(async (params: { input: string[]; dimensions: number }) => ({
        data: params.input.map((_text, index) => {
          const embedding = Array(params.dimensions).fill(0)
          embedding[0] = 1
          return { index, embedding }
        }),
        usage: { prompt_tokens: params.input.length, total_tokens: params.input.length },
      }))
      setOpenAiEmbeddingsClientForTesting({
        embeddings: { create: openAiCreate },
      } as OpenAiEmbeddingsClient)

      await db.tenant.create({
        data: { id: tenantId, name: 'Sanitized Remote Proof', slug: tenantId },
      })
      await db.user.create({
        data: { id: ownerId, email: `${ownerId}@example.test`, fullName: 'Synthetic Owner' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: ownerId, role: 'OWNER', joinedAt: new Date() },
      })
      const venue = await db.venue.create({
        data: {
          tenantId,
          name: 'Synthetic River Museum',
          slug: `remote-proof-venue-${suffix}`,
          guideMode: 'non_location',
          isActive: true,
        },
      })
      const venueId = venue.id

      // 1. Invitation/start — sanitized, immutable, and replay-safe.
      const invitationAt = new Date()
      await recordOrReplayOnboardingMilestoneEvent({
        db,
        input: {
          id: randomUUID(),
          tenantId,
          venueId,
          eventType: 'INVITATION_STARTED',
          idempotencyKey: `proof:${suffix}:invitation`,
          occurredAt: invitationAt,
          actorType: 'OPERATOR',
          actorId: operatorId,
          sourceType: 'SYNTHETIC_INVITATION',
          sourceId: `invite-${suffix}`,
        },
      })

      // 2. Website, interview, and file submission.
      const website = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: {
          kind: 'WEBSITE',
          displayName: 'Synthetic public website',
          websiteUri: 'https://example.invalid/synthetic-river-museum',
        },
      })
      const interview = await createIntakeProposal({
        db,
        tenantId,
        venueId,
        actor,
        requestId: randomUUID(),
        proposal: {
          kind: 'INTERVIEW',
          displayName: 'Synthetic accessibility interview',
          submission: {
            role: 'ACCESSIBILITY',
            consentToUse: true,
            acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
            answers: [
              {
                questionId: 'accessibility.arrival',
                text: 'The Oak Street entrance has the step-free route.',
                privacy: 'PUBLIC_CANDIDATE',
                skipped: false,
                redacted: false,
                uncertain: false,
                confidence: 0.95,
              },
              {
                questionId: 'accessibility.accommodations',
                text: 'Visitors may request a portable seat at reception.',
                privacy: 'PUBLIC_CANDIDATE',
                skipped: false,
                redacted: false,
                uncertain: false,
                confidence: 0.9,
              },
              {
                questionId: 'accessibility.limitations',
                privacy: 'INTERNAL_CONTEXT',
                skipped: true,
                redacted: false,
                uncertain: false,
                confidence: 0.8,
              },
            ],
          },
        },
      })
      const fileBytes = Buffer.from('sanitized remote onboarding proof image', 'utf8')
      const fileSha256 = createHash('sha256').update(fileBytes).digest('hex')
      const objectGeneration = randomUUID()
      const reserved = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Synthetic floor plan',
          fileName: 'synthetic-floor-plan.png',
          mimeType: 'image/png',
          category: 'FLOOR_PLAN',
          byteSize: fileBytes.byteLength,
          sha256: fileSha256,
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration,
        },
      })
      expect([website.status, interview.status, reserved.upload.status]).toEqual([
        'AWAITING_REVIEW',
        'AWAITING_REVIEW',
        'RESERVED',
      ])

      // 3. Exact precheck and authoritative verification.
      const precheckClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaim,
      })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: precheckClaim,
        verified: {
          objectGeneration,
          storageVersionId: `proof-version-${suffix}`,
          mimeType: 'image/png',
          byteSize: fileBytes.byteLength,
          sha256: fileSha256,
        },
        evidence: {
          engine: 'synthetic-magic-bytes',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('proof-precheck').digest('hex'),
          computedByteSize: fileBytes.byteLength,
          computedSha256: fileSha256,
        },
      })
      const authoritativeClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: authoritativeClaim,
      })
      const verified = await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: reserved.upload.id,
        actor,
        claimId: authoritativeClaim,
        malware: {
          verdict: 'CLEAN',
          engine: 'synthetic-clamav',
          engineVersion: '1',
          verdictHash: createHash('sha256').update('proof-clean').digest('hex'),
          computedByteSize: fileBytes.byteLength,
          computedSha256: fileSha256,
        },
      })
      expect(verified.upload.status).toBe('AWAITING_REVIEW')

      // 4–5. Durable intake processing and cited, client-safe extracted review.
      const review = await getIntakeProposalReview({
        db,
        tenantId,
        venueId,
        runId: interview.id,
      })
      expect(review.answers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            questionId: 'accessibility.arrival',
            hasEvidence: true,
            publicText: 'The Oak Street entrance has the step-free route.',
          }),
        ]),
      )

      // 6–8. Missing-information question, client answer, and exact at-most-once resume.
      const identity = await db.agentIdentity.create({
        data: {
          tenantId,
          venueId,
          identityKey: `proof.accessibility.${suffix}`,
          name: 'Synthetic accessibility reviewer',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'support.question'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: operatorId,
        },
      })
      const agentRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identity.id,
          runType: 'ONBOARDING',
          requestedOperation: 'verify_accessible_arrival',
          requestPrompt: 'Verify the step-free entrance from synthetic evidence.',
          scopeSnapshot: { accessCapabilities: ['intake.read', 'support.question'] },
          status: 'QUEUED',
          initiatedByType: 'HUMAN',
          initiatedById: operatorId,
        },
      })
      const asked = await askAgentQuestionAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identity.id,
        agentRunId: agentRun.id,
        question: 'Which entrance provides the step-free route?',
        context: 'The synthetic website does not identify the route.',
        choices: ['Oak Street', "I don't know"],
        blocking: true,
      })
      const routed = await createClientOnboardingQuestionAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentQuestionId: asked.question.id,
        expectedQuestionUpdatedAt: asked.question.updatedAt,
        recipientUserId: ownerId,
        category: 'ACCESSIBILITY',
        subject: 'Confirm the step-free entrance',
        why: 'The public website does not identify it.',
        whatWasFound: 'Staff evidence names Oak Street.',
        effect: 'The exact accessibility review can continue.',
        actor: { actorId: operatorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const answer = await respondToSupportInformationAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: routed.link.supportRequestId,
        expectedClientVersion: 1,
        body: 'Oak Street is the step-free entrance during public hours.',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'CLIENT',
          actorId: ownerId,
          auditRole: 'OWNER',
        },
      })
      const resumed = await resumeOnboardingQuestionFromSupportAction({
        tenantId,
        venueId,
        supportRequestId: routed.link.supportRequestId,
        supportMessageId: answer.message.id,
        actor: { actorId: ownerId, auditRole: 'OWNER' },
      })
      const resumeReplay = await resumeOnboardingQuestionFromSupportAction({
        tenantId,
        venueId,
        supportRequestId: routed.link.supportRequestId,
        supportMessageId: answer.message.id,
        actor: { actorId: ownerId, auditRole: 'OWNER' },
      })
      expect(resumed).toMatchObject({ replayed: false, agentRunId: agentRun.id })
      expect(resumeReplay).toMatchObject({ replayed: true, agentRunId: agentRun.id })
      expect(await db.approvalRequest.count({ where: { tenantId, venueId } })).toBe(0)

      // 9. Generate an immutable manifest artifact, materialize its exact linked package,
      // and explicitly approve the candidate. A FULL artifact establishes the scoped base;
      // the materializable PATCH retains the client-reviewable content delta.
      const artifactCreatedAt = new Date().toISOString()
      const baseManifest = {
        schemaVersion: 2 as const,
        packageType: 'FULL' as const,
        manifestId: randomUUID(),
        venueRef: venueId,
        idempotencyKey: randomUUID(),
        identity: {
          venueStableId: venueId,
          name: 'Synthetic River Museum',
          slug: `remote-proof-venue-${suffix}`,
          archetype: 'museum' as const,
        },
        branding: { themeId: 'default' as const, fontId: 'jakarta' as const },
        aiConfiguration: {
          guideName: 'Torchiko',
          tone: { preset: 'friendly' as const, behaviorVersion: 1 },
          modelReferences: [],
        },
        capabilities: { enabled: [], effectiveConfigurationProvenance: [] },
        contentModules: [],
        assets: [],
        evaluation: {
          evaluationRunId: `proof-eval-${suffix}`,
          readinessAssessmentId: `proof-readiness-${suffix}`,
          readiness: 'NOT_READY' as const,
        },
        provenance: {
          sourceIds: [`proof-intake-${suffix}`],
          evidenceIds: [],
          createdAt: artifactCreatedAt,
          createdBy: { kind: 'OPERATOR' as const, actorRef: operatorId },
        },
      }
      const baseArtifact = await reviewVenuePackageManifestService({
        db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: operatorId, role: 'PLATFORM_ADMIN' },
        manifest: baseManifest,
        persist: true,
      })
      expect(baseArtifact).toMatchObject({
        materialization: { status: 'NOT_MATERIALIZABLE' },
        artifact: { id: expect.any(String) },
        draft: null,
      })
      const patchManifest = {
        schemaVersion: 2 as const,
        packageType: 'PATCH' as const,
        manifestId: randomUUID(),
        venueRef: venueId,
        idempotencyKey: randomUUID(),
        baseManifestHash: deploymentManifestHash(baseManifest),
        provenance: {
          sourceIds: [website.id, interview.id, reserved.upload.id],
          evidenceIds: [],
          createdAt: artifactCreatedAt,
          createdBy: { kind: 'OPERATOR' as const, actorRef: operatorId },
        },
        operations: [
          {
            operationId: randomUUID(),
            op: 'UPSERT_CONTENT_MODULE' as const,
            value: {
              id: `river-gallery-${suffix}`,
              version: 1,
              audience: 'PUBLIC' as const,
              evidence: [],
              assetIds: [],
              kind: 'PLACE' as const,
              name: 'River Gallery',
              description: 'A family-friendly gallery beside the step-free route.',
              accessibility: ['Step-free route from Oak Street'],
            },
          },
          {
            operationId: randomUUID(),
            op: 'UPSERT_CONTENT_MODULE' as const,
            value: {
              id: `accessible-arrival-${suffix}`,
              version: 1,
              audience: 'PUBLIC' as const,
              evidence: [],
              assetIds: [],
              kind: 'KNOWLEDGE' as const,
              title: 'Accessible arrival',
              body: 'Use the Oak Street entrance for the step-free route.',
              topics: ['Accessibility'],
            },
          },
        ],
      }
      const materialized = await reviewVenuePackageManifestService({
        db,
        tenantId,
        venueId,
        actor: { type: 'HUMAN', id: operatorId, role: 'PLATFORM_ADMIN' },
        manifest: patchManifest,
        persist: true,
      })
      expect(materialized).toMatchObject({
        materialization: { status: 'MATERIALIZABLE' },
        artifact: { id: expect.any(String) },
        draft: { id: expect.any(String), status: 'DRAFT' },
      })
      const draft = materialized.draft!
      expect(
        await db.venuePackage.findFirst({
          where: { id: draft.id, tenantId, venueId },
          select: { manifestArtifactId: true },
        }),
      ).toEqual({ manifestArtifactId: materialized.artifact!.id })
      await expect(
        caller.portal.getClientPreview({ venueId, packageId: draft.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const approved = await caller.venuePackage.approve({
        id: draft.id,
        expectedUpdatedAt: draft.updatedAt,
        commandKey: randomUUID(),
        acknowledgedWarningDigest: draft.preview.warningDigest,
        acknowledgedPayloadHash: draft.payloadHash,
      })
      const preview = await caller.portal.getClientPreview({ venueId, packageId: approved.id })
      expect(preview).toMatchObject({ package: { id: approved.id, status: 'APPROVED' } })

      // 10. Durable, exact-package preview feedback creates work but cannot publish.
      const feedback = await caller.portal.createPreviewFeedbackRequest({
        operationId: randomUUID(),
        venueId,
        packageId: approved.id,
        body: 'Preview answer feedback: correct. Prompt: Which entrance is step-free?',
        context: {
          kind: 'PREVIEW_ANSWER',
          prompt: 'Which entrance is step-free?',
          answerRef: 'knowledge:0:Accessible arrival',
          verdict: 'CORRECT',
        },
        attachments: [],
      })
      expect(feedback).toMatchObject({ replayed: false })

      // 11. Freeze the exact seven-dimension suite, score it, and close the run.
      const suite = buildOnboardingEvaluationSuite(preview)
      expect(suite.map((item) => item.dimension)).toEqual([
        'fact',
        'navigation',
        'accessibility',
        'safety',
        'multilingual',
        'adversarial',
        'unanswerable',
      ])
      const evalCases = []
      for (const item of suite) {
        const persisted = await createOrReplayEvaluationCase({
          db,
          caseId: randomUUID(),
          identity: {
            tenantId,
            venueId,
            caseKey: item.evalCase.caseId,
            revision: 1,
            schemaVersion: item.evalCase.schemaVersion,
            category: item.evalCase.category,
            caseSnapshot: item.evalCase,
            createdBy: operatorId,
            sourceType: 'ONBOARDING_APPROVED_PACKAGE',
            sourceRef: `venue-package:${approved.id}:${draft.payloadHash}`,
          },
        })
        evalCases.push({ contract: item.evalCase, row: persisted.evalCase })
      }
      const manifest = evalCases.map(({ row }) => ({
        caseId: row.id,
        revision: row.revision,
        caseHash: row.caseHash,
      }))
      const approvedContent = {
        version: 'pathfinder-approved-package-evaluation-content-v1',
        tenantId,
        venueId,
        packageId: approved.id,
        preview,
      }
      const evalRun = await createOrReplayEvaluationRun({
        db,
        runId: randomUUID(),
        identity: {
          tenantId,
          venueId,
          idempotencyKey: `proof-${suffix}`,
          caseManifest: manifest,
          promptContractVersion: GUEST_CHAT_PROMPT_VERSION,
          promptContractHash: GUEST_CHAT_PROMPT_CONTRACT_HASH,
          packageSnapshotRef: `venue-package-v1:${approved.id}`,
          packageSnapshotHash: draft.payloadHash,
          contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1',
          contentSnapshotRef: approved.id,
          contentSnapshotVersion: 1n,
          contentSnapshotHash: evaluationSnapshotHash(
            'pathfinder-approved-client-package-preview-v1',
            approvedContent as never,
          ),
          modelProvider: 'synthetic',
          modelName: 'deterministic-proof',
          modelSnapshot: { provider: 'synthetic', model: 'deterministic-proof' },
          runConfigSnapshot: {
            version: 'pathfinder-approved-package-evaluation-run-config-v1',
            requestedCases: 7,
            contentSnapshot: approvedContent,
          },
          declaredBudgetCeilingE8Usd: 0n,
          createdBy: operatorId,
          triggerType: 'SYNTHETIC_DISPOSABLE_PROOF',
        },
      })
      const runScope = {
        runId: evalRun.run.id,
        tenantId,
        venueId,
        runIdentityHash: evalRun.run.identityHash,
      }
      expect(await markEvaluationRunQueued(runScope)).toBe(true)
      const claimed = await claimEvaluationRunAttempt({
        ...runScope,
        attemptNumber: 1,
        maxAttempts: 1,
      })
      if (claimed.state !== 'acquired')
        throw new Error(`Evaluation was not acquired: ${claimed.state}`)
      for (const { contract, row } of evalCases) {
        const answerText = [
          ...contract.rules.requiredPhrases.map((rule) => rule.phrase),
          ...contract.rules.requiredFacts.flatMap((rule) => rule.acceptablePhrases.slice(0, 1)),
          ...(contract.rules.unknownAnswer.required ? ["I don't know"] : []),
          'Synthetic verified response.',
        ].join(' ')
        const observation = createEvalObservation({ caseId: contract.caseId, answer: answerText })
        const checks = scoreEvaluationChecks(contract, observation)
        const observationHash = hashEvalObservation(observation)
        await createOrReplayEvaluationResult({
          db,
          resultId: randomUUID(),
          tenantId,
          venueId,
          runId: evalRun.run.id,
          evalCaseId: row.id,
          caseRevision: row.revision,
          latencyMs: 1,
          costE8Usd: 0n,
          terminal: {
            outcome: 'SCORED',
            observation,
            result: {
              schemaVersion: contract.schemaVersion,
              caseId: contract.caseId,
              caseHash: row.caseHash,
              observationHash,
              passed: checks.every((check) => check.passed),
              score: checks.filter((check) => check.passed).length / checks.length,
              checks,
            },
          },
        })
      }
      expect(
        await finishEvaluationRunAttempt({
          ...runScope,
          attemptNumber: claimed.attemptNumber,
          leaseToken: claimed.leaseToken,
          outcome: 'COMPLETED',
        }),
      ).toBe(true)
      await recordApprovedPackageEvaluationMilestones(runScope)

      // 12–13. Multidimensional readiness is exact-package based; publication stays separate.
      const journey = await caller.portal.getOnboardingJourney({ venueId })
      expect(journey.qa).toMatchObject({
        state: 'COMPLETED',
        passed: 7,
        failed: 0,
        safetyCriticalFailed: 0,
        requiredDimensions: 7,
        assessedDimensions: 7,
        exactPackage: true,
      })
      expect(journey.publication).toEqual({
        clientCanPublish: false,
        summary: 'Publication remains a separate, explicit Torchiko operator action.',
      })
      expect(
        resolveRemoteOnboardingProjection({
          lifecycle: journey.lifecycle,
          materials: journey.materials,
          review: journey.review,
          questions: { open: journey.questions.open },
          preview: journey.preview,
          qa: journey.qa,
          release: journey.release,
        }).readiness.find((item) => item.id === 'AUTOMATED_QA'),
      ).toMatchObject({ status: 'READY' })

      // 14. Explicit release creates the exact public content used by the guest proof.
      const applied = await caller.venuePackage.applyPackage({
        id: approved.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      })
      expect(applied.status).toBe('APPLIED')
      expect(
        await db.place.findFirst({ where: { tenantId, venueId, name: 'River Gallery' } }),
      ).toMatchObject({ name: 'River Gallery' })
      const publicKnowledge = await db.venueKnowledgeEntry.findFirstOrThrow({
        where: { tenantId, venueId, title: 'Accessible arrival' },
      })
      expect(publicKnowledge).toMatchObject({
        title: 'Accessible arrival',
        content: 'Use the Oak Street entrance for the step-free route.',
      })
      expect(
        await db.contentVersion.count({
          where: { tenantId, venueId, venuePackageId: approved.id, venuePackageAction: 'APPLY' },
        }),
      ).toBeGreaterThan(0)

      const knowledgeEmbedding = Array(1_536).fill(0)
      knowledgeEmbedding[0] = 1
      const embeddingLeaseToken = randomUUID()
      const embeddingClaim = await acquireEmbeddingWork({
        tenantId,
        venueId,
        entityType: 'KNOWLEDGE_ENTRY',
        entityId: publicKnowledge.id,
        contentUpdatedAt: publicKnowledge.updatedAt,
        sourceHash: createHash('sha256')
          .update(
            [publicKnowledge.title, publicKnowledge.category, publicKnowledge.content].join('. '),
          )
          .digest('hex'),
        embeddingProfile: 'openai:text-embedding-3-small:1536',
        leaseToken: embeddingLeaseToken,
      })
      if (embeddingClaim.state !== 'acquired') {
        throw new Error(`Knowledge embedding claim was not acquired: ${embeddingClaim.state}`)
      }
      await expect(
        storeKnowledgeEntryEmbeddingForScope({
          entryId: publicKnowledge.id,
          tenantId,
          venueId,
          contentUpdatedAt: publicKnowledge.updatedAt,
          source: {
            title: publicKnowledge.title,
            category: publicKnowledge.category,
            content: publicKnowledge.content,
            isEnabled: publicKnowledge.isEnabled,
          },
          embedding: knowledgeEmbedding,
          claimId: embeddingClaim.claimId,
          leaseToken: embeddingLeaseToken,
        }),
      ).resolves.toEqual({ claimCompleted: true, stored: true })

      // 15. The real public chat router retrieves the applied venue knowledge, routes through
      // the production AI gateway, and commits a complete provider-dark guest turn. Only the
      // Anthropic transport is replaced with an in-process deterministic test client.
      const anthropicCreate = vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: 'Use the Oak Street entrance for the step-free route.',
          },
        ],
        usage: {
          input_tokens: 24,
          output_tokens: 11,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      })
      _setAnthropicClientForTesting({
        messages: { create: anthropicCreate },
      } as AnthropicMessagesClient)
      const anonymousToken = randomUUID()
      const operationId = randomUUID()
      const guestTurn = await publicCaller.chat.send({
        operationId,
        venueId,
        anonymousToken,
        message: 'Which entrance has the step-free route?',
      })
      expect(guestTurn).toMatchObject({
        response: 'Use the Oak Street entrance for the step-free route.',
        assistantMessageId: expect.any(String),
        sessionId: expect.any(String),
        replayed: false,
      })
      if (!guestTurn.assistantMessageId)
        throw new Error('Guest turn did not persist an assistant message')
      const assistantMessageId = guestTurn.assistantMessageId
      expect(anthropicCreate).toHaveBeenCalledTimes(1)
      const guestPrompt = (anthropicCreate.mock.calls[0]![0].system as Array<{ text: string }>)
        .map((block) => block.text)
        .join('')
      expect(guestPrompt).toContain('Accessible arrival')
      expect(guestPrompt).toContain('Use the Oak Street entrance for the step-free route.')
      await expect(publicCaller.chat.history({ venueId, anonymousToken })).resolves.toEqual({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: 'Which entrance has the step-free route?',
          }),
          expect.objectContaining({
            id: assistantMessageId,
            role: 'assistant',
            content: 'Use the Oak Street entrance for the step-free route.',
          }),
        ],
      })
      await expect(
        db.visitorSession.findFirstOrThrow({
          where: { id: guestTurn.sessionId, tenantId, venueId, anonymousToken },
          select: { experienceScope: true, messageCount: true },
        }),
      ).resolves.toEqual({ experienceScope: 'PUBLIC', messageCount: 2 })
      await expect(
        db.guestChatTurn.findFirstOrThrow({
          where: { tenantId, venueId, requestId: operationId },
          select: { status: true, assistantMessageId: true },
        }),
      ).resolves.toEqual({ status: 'COMPLETE', assistantMessageId })

      // 16. Visitor feedback is ownership-bound to the public session and assistant message,
      // then retained as both durable feedback and a machine-readable analytics event.
      await expect(
        publicCaller.feedback.submit({
          venueId,
          anonymousToken,
          messageId: assistantMessageId,
          rating: 'HELPFUL',
          reason: 'The route was specific and easy to follow.',
        }),
      ).resolves.toEqual({ ok: true })
      await expect(
        db.messageFeedback.findFirstOrThrow({
          where: { tenantId, venueId, sessionId: guestTurn.sessionId },
          select: { messageId: true, rating: true, reason: true },
        }),
      ).resolves.toEqual({
        messageId: assistantMessageId,
        rating: 'HELPFUL',
        reason: 'The route was specific and easy to follow.',
      })
      await expect(
        db.analyticsEvent.count({
          where: {
            tenantId,
            venueId,
            sessionId: guestTurn.sessionId,
            eventType: 'chat.response.feedback',
          },
        }),
      ).resolves.toBe(1)
      _setAnthropicClientForTesting(null)

      // 17. Exact rollback restores the content base after the public interaction evidence.
      const reverted = await caller.venuePackage.revertPackage({
        id: approved.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: randomUUID(),
      })
      expect(reverted.status).toBe('REVERTED')
      expect(await db.place.count({ where: { tenantId, venueId, name: 'River Gallery' } })).toBe(0)
      expect(
        await db.onboardingMilestoneEvent.findMany({
          where: { tenantId, venueId },
          select: { eventType: true },
        }),
      ).toEqual(
        expect.arrayContaining([
          { eventType: 'INVITATION_STARTED' },
          { eventType: 'FIRST_USEFUL_MATERIAL' },
          { eventType: 'QUESTION_ROUTED' },
          { eventType: 'QUESTION_ANSWERED' },
          { eventType: 'QA_RESULT' },
          { eventType: 'RELEASED' },
          { eventType: 'HUMAN_INTERVENTION' },
        ]),
      )

      // 18. A routine venue update is published through the tenant action surface and
      // remains machine-readable through the same bounded tenant API.
      const updateStart = new Date(Date.now() - 60_000)
      const updateEnd = new Date(Date.now() + 60 * 60 * 1_000)
      const operationalUpdate = await caller.operationalUpdate.create({
        venueId,
        updateType: 'CHANGED_HOURS',
        severity: 'INFO',
        priority: 'NORMAL',
        title: 'Synthetic late opening',
        body: 'The museum opens at 10:30 AM during this disposable proof.',
        startsAt: updateStart,
        expiresAt: updateEnd,
        publish: true,
      })
      expect(operationalUpdate).toMatchObject({
        tenantId,
        venueId,
        status: 'PUBLISHED',
        isActive: true,
      })
      await expect(
        caller.operationalUpdate.getById({ id: operationalUpdate.id }),
      ).resolves.toMatchObject({
        id: operationalUpdate.id,
        title: 'Synthetic late opening',
        status: 'PUBLISHED',
      })

      // 19. Reports fail closed until explicitly enabled. A populated draft is then
      // published by the platform-admin action and read through the client tenant API.
      await expect(caller.analytics.listPublishedWeeklyReports({ venueId })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      })
      await admin.updateVenueReportConfiguration({
        tenantId,
        venueId,
        enabled: true,
        expectedUpdatedAt: null,
      })
      const report = await db.weeklyReport.create({
        data: {
          tenantId,
          venueId,
          weekStart: new Date('2026-08-10T00:00:00.000Z'),
          weekEnd: new Date('2026-08-16T23:59:59.999Z'),
          status: 'DRAFT',
          title: 'Synthetic Golden Venue report',
          content: 'A sanitized weekly summary for the disposable Golden Venue proof.',
          createdBy: operatorId,
        },
      })
      await expect(
        admin.publishWeeklyReport({
          tenantId,
          venueId,
          reportId: report.id,
          expectedUpdatedAt: report.updatedAt.toISOString(),
        }),
      ).resolves.toEqual({ ok: true })
      await expect(
        caller.analytics.getPublishedWeeklyReport({ venueId, reportId: report.id }),
      ).resolves.toMatchObject({
        id: report.id,
        title: 'Synthetic Golden Venue report',
        content: 'A sanitized weekly summary for the disposable Golden Venue proof.',
      })

      // 20. Offboarding remains planning-only: create a scoped REQUESTED draft and a
      // metadata-reference export preview, without revocation, artifact creation, data
      // deletion, venue deactivation, or customer cancellation.
      const activeBeforeOffboarding = await db.venue.findFirstOrThrow({
        where: { id: venueId, tenantId },
        select: { isActive: true },
      })
      const draftPlan = await admin.createOffboardingDraft({
        tenantId,
        requestId: randomUUID(),
        venueIds: [venueId],
        revocationTargets: ['GUEST_LINKS', 'BACKGROUND_JOBS', 'CLIENT_ACCESS'],
        exportKinds: ['APPROVED_CONTENT', 'CONTENT_HISTORY', 'VENUE_PACKAGES', 'CONFIGURATION'],
      })
      expect(draftPlan).toMatchObject({ status: 'REQUESTED' })
      const exportPreview = await admin.previewOffboardingExportManifest({
        tenantId,
        venueIds: [venueId],
      })
      expect(exportPreview).toMatchObject({
        schemaVersion: 1,
        tenantId,
        selectedVenueIds: [venueId],
        privacyBoundary: 'METADATA_REFERENCES_ONLY',
      })
      expect(exportPreview.packages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: approved.id, venueId })]),
      )
      await expect(
        db.venue.findFirstOrThrow({ where: { id: venueId, tenantId }, select: { isActive: true } }),
      ).resolves.toEqual(activeBeforeOffboarding)
      await expect(
        db.offboardingRevocationEvidence.count({ where: { tenantId, planId: draftPlan.id } }),
      ).resolves.toBe(0)
      await expect(
        db.offboardingExportArtifact.count({ where: { tenantId, planId: draftPlan.id } }),
      ).resolves.toBe(0)
    })
  }, 120_000)
})
