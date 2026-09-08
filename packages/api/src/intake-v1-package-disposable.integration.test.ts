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
  issueExternalCredentialAction,
  activateAgentBridgeCredentialAction,
  verifyAgentBridgeCredential,
  registerAgentWorkerAction,
  revokeExternalCredentialAction,
} from '@pathfinder/db'

import { buildIntakeV1PackageCandidate } from './lib/intake-v1-package-candidate'
import { createIntakeV1PackageDraftForAdmin } from './lib/intake-v1-package-draft'
import { createSafeOperationalMcpRegistry } from './mcp/composition'
import { adminIntakeV1PackageDraftApprovalRouter } from './routers/admin/intake-v1-package-draft-approval'
import type { TRPCContext } from './context'

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
          // This is the same real Prisma client with a query failure hook. Erase
          // the additional extension type layer to keep the large schema tractable.
          db: failingDb as unknown as typeof db,
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

      const machineSubmission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        amend: { submissionId: submitted.submissionId, expectedCurrentRevision: 1 },
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [bootstrap.runId, second.id, website.id],
          intakeUploadIds: [],
        },
      })
      const machineRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: {
          tenantId,
          venueId,
          submissionId: submitted.submissionId,
          revision: machineSubmission.revision,
        },
        include: { members: { orderBy: { ordinal: 'asc' } } },
      })
      const machineMember = machineRevision.members.find(
        (member) => member.intakeRunId === bootstrap.runId,
      )!
      const machinePreview = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: machineSubmission.revision,
        selectedMemberIds: [machineMember.id],
      })
      expect(machinePreview.ready).toBe(true)
      const identityId = `v1-machine-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: identityId,
          name: 'V1 package reviewer',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['packages:draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: ownerUserId,
        },
      })
      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor: { type: 'HUMAN', id: ownerUserId, role: 'PLATFORM_ADMIN' },
        kind: 'MCP',
        label: 'V1 package fixture',
        capabilities: ['packages:draft', 'agent-runs:execute'],
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor: { type: 'HUMAN', id: ownerUserId, role: 'PLATFORM_ADMIN' },
      })
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const worker = await registerAgentWorkerAction(
        {
          workerKey: `v1-worker-${suffix}`,
          runtimeType: 'OPENAI_COMPATIBLE',
          label: 'V1 package worker',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'fixture/1',
          capabilities: ['packages:draft'],
          agentRoles: ['client-operations'],
          safeHealth: {},
        },
        credential,
        { leaseSeconds: 300 },
      )
      const otherWorker = await registerAgentWorkerAction(
        {
          workerKey: `v1-worker-other-${suffix}`,
          runtimeType: 'OPENAI_COMPATIBLE',
          label: 'Other V1 worker',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'fixture/1',
          capabilities: ['packages:draft'],
          agentRoles: ['client-operations'],
          safeHealth: {},
        },
        credential,
        { leaseSeconds: 300 },
      )
      const leaseToken = randomUUID()
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'ONBOARDING',
          requestedOperation: 'operator_task',
          requestPrompt: 'Prepare exact V1 package draft.',
          scopeSnapshot: {},
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: ownerUserId,
          executionWorkerId: worker.id,
          executionLeaseToken: leaseToken,
          executionLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
          attemptNumber: 1,
          startedAt: new Date(),
        },
      })
      const registry = createSafeOperationalMcpRegistry(db)
      const proposalOperationId = randomUUID()
      const machineDraftOperationId = randomUUID()
      const exact = {
        clientId: tenantId,
        venueId,
        agentIdentityId: identityId,
        agentRunId: run.id,
        workerKey: worker.workerKey,
        executionLeaseToken: leaseToken,
        submissionId: submitted.submissionId,
        revision: machineSubmission.revision,
        selectedMemberIds: [machineMember.id],
        expectedManifestHash: machinePreview.manifestHash,
        expectedCandidateHash: machinePreview.candidateHash!,
        expectedPayloadHash: machinePreview.payloadHash!,
        expectedSelectionHash: machinePreview.selectionHash,
        partialAcknowledged: true,
        draftOperationId: machineDraftOperationId,
      }
      await expect(
        registry.callTool(
          'pathfinder.propose_intake_v1_package_draft',
          {
            ...exact,
            operationId: randomUUID(),
            workerKey: otherWorker.workerKey,
            reason: 'Mismatched assigned worker must fail.',
          },
          { credential },
        ),
      ).rejects.toThrow(/authority/iu)
      const proposed = await registry.callTool(
        'pathfinder.propose_intake_v1_package_draft',
        {
          ...exact,
          operationId: proposalOperationId,
          reason: 'Create the reviewed exact V1 draft.',
        },
        { credential },
      )
      const approvalRequestId = (proposed.structuredContent.data as { approvalRequestId: string })
        .approvalRequestId
      const approval = await adminIntakeV1PackageDraftApprovalRouter
        .createCaller({
          db,
          headers: new Headers(),
          session: {
            userId: ownerUserId,
            activeTenantId: tenantId,
            role: 'OWNER',
            isPlatformAdmin: true,
          },
        } as TRPCContext)
        .decideIntakeV1PackageDraftProposal({
          operationId: randomUUID(),
          tenantId,
          venueId,
          approvalRequestId,
          decision: 'APPROVED',
          reason: 'Exact V1 selection reviewed.',
        })
      const applyOperationId = randomUUID()
      const applied = await registry.callTool(
        'pathfinder.apply_intake_v1_package_draft',
        { ...exact, operationId: applyOperationId },
        { credential, approvalGrantId: approval.approvalGrant!.id },
      )
      const replayedMachine = await registry.callTool(
        'pathfinder.apply_intake_v1_package_draft',
        { ...exact, operationId: applyOperationId },
        { credential, approvalGrantId: approval.approvalGrant!.id },
      )
      expect(applied.structuredContent.data).toMatchObject({
        status: 'DRAFT',
        replayed: false,
        published: false,
      })
      expect(replayedMachine.structuredContent.data).toMatchObject({ replayed: true })
      expect(
        await db.approvalGrantConsumption.count({
          where: { tenantId, operationId: applyOperationId },
        }),
      ).toBe(1)
      expect(
        await db.intakeV1PackageHandoff.count({
          where: { tenantId, venueId, operationId: machineDraftOperationId },
        }),
      ).toBe(1)
      const rollbackSubmission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId,
        actorRole: 'MANAGER',
        amend: {
          submissionId: submitted.submissionId,
          expectedCurrentRevision: machineSubmission.revision,
        },
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [bootstrap.runId, second.id, website.id],
          intakeUploadIds: [],
        },
      })
      const rollbackRevision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: {
          tenantId,
          venueId,
          submissionId: submitted.submissionId,
          revision: rollbackSubmission.revision,
        },
        include: { members: { orderBy: { ordinal: 'asc' } } },
      })
      const rollbackMember = rollbackRevision.members.find(
        (member) => member.intakeRunId === bootstrap.runId,
      )!
      const rollbackPreview = await buildIntakeV1PackageCandidate({
        db,
        tenantId,
        venueId,
        submissionId: submitted.submissionId,
        revision: rollbackSubmission.revision,
        selectedMemberIds: [rollbackMember.id],
      })
      const rollbackProposalId = randomUUID()
      const rollbackDraftId = randomUUID()
      const rollbackExact = {
        ...exact,
        revision: rollbackSubmission.revision,
        selectedMemberIds: [rollbackMember.id],
        expectedManifestHash: rollbackPreview.manifestHash,
        expectedCandidateHash: rollbackPreview.candidateHash!,
        expectedPayloadHash: rollbackPreview.payloadHash!,
        expectedSelectionHash: rollbackPreview.selectionHash,
        draftOperationId: rollbackDraftId,
      }
      const rollbackProposal = await registry.callTool(
        'pathfinder.propose_intake_v1_package_draft',
        {
          ...rollbackExact,
          operationId: rollbackProposalId,
          reason: 'Prove atomic grant rollback.',
        },
        { credential },
      )
      const rollbackRequestId = (
        rollbackProposal.structuredContent.data as { approvalRequestId: string }
      ).approvalRequestId
      const rollbackApproval = await adminIntakeV1PackageDraftApprovalRouter
        .createCaller({
          db,
          headers: new Headers(),
          session: {
            userId: ownerUserId,
            activeTenantId: tenantId,
            role: 'OWNER',
            isPlatformAdmin: true,
          },
        } as TRPCContext)
        .decideIntakeV1PackageDraftProposal({
          operationId: randomUUID(),
          tenantId,
          venueId,
          approvalRequestId: rollbackRequestId,
          decision: 'APPROVED',
          reason: 'Exact rollback fixture reviewed.',
        })
      const rollbackApplyId = randomUUID()
      const failingMachineRegistry = createSafeOperationalMcpRegistry(
        failingDb as unknown as typeof db,
      )
      await expect(
        failingMachineRegistry.callTool(
          'pathfinder.apply_intake_v1_package_draft',
          { ...rollbackExact, operationId: rollbackApplyId },
          { credential, approvalGrantId: rollbackApproval.approvalGrant!.id },
        ),
      ).rejects.toThrow(injectedFailure.message)
      expect(
        await db.approvalGrantConsumption.count({
          where: { tenantId, operationId: rollbackApplyId },
        }),
      ).toBe(0)
      expect(
        await db.venuePackage.count({ where: { tenantId, venueId, draftKey: rollbackDraftId } }),
      ).toBe(0)
      const credentialBeforeRevoke = await db.externalAccessCredential.findUniqueOrThrow({
        where: { id: issued.credential.id },
        select: { updatedAt: true },
      })
      await revokeExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: credentialBeforeRevoke.updatedAt,
        reasonCode: 'FIXTURE_IMMEDIATE_STOP',
        actor: { type: 'HUMAN', id: ownerUserId, role: 'PLATFORM_ADMIN' },
      })
      await expect(
        registry.callTool(
          'pathfinder.apply_intake_v1_package_draft',
          { ...exact, operationId: applyOperationId },
          { credential, approvalGrantId: approval.approvalGrant!.id },
        ),
      ).rejects.toThrow(/authority|worker|credential/iu)

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
      // One human revision and one machine revision succeeded; the third rolled back.
      expect(await db.intakeV1PackageHandoff.count({ where: { tenantId, venueId } })).toBe(2)
    })
  })
})
