import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { defaultOperationalUpdateDraftPolicyConstraints } from '@pathfinder/contracts'
import {
  activateAgentBridgeCredentialAction,
  claimAgentRunExecution,
  createCompanyKnowledgeCandidateAction,
  db,
  issueApprovalGrantAction,
  issueExternalCredentialAction,
  listAgentWorkerHealth,
  promoteCompanyKnowledgeAction,
  registerAgentWorkerAction,
  recordApprovalDecisionAction,
  searchCompanyKnowledge,
  supersedeCompanyKnowledgeAction,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { createSafeOperationalMcpRegistry } from './composition'

const enabled =
  process.env.RUN_COMPANY_BRAIN_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('Company Brain disposable friend-takeover shakedown', () => {
  afterAll(async () => db.$disconnect())

  it('operates a mature account through a secondary worker without Obsidian or the primary PC', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-brain-${suffix}`
      const venueId = `venue-brain-${suffix}`
      const secondVenueId = `venue-brain-second-${suffix}`
      const thirdVenueId = `venue-brain-third-${suffix}`
      const organizationId = `org-brain-${suffix}`
      const identityId = `identity-brain-${suffix}`
      const primaryKey = `tom-hermes-${suffix}`
      const secondaryKey = `secondary-worker-${suffix}`
      const human = {
        type: 'HUMAN' as const,
        actorId: `secondary-admin-${suffix}`,
        role: 'PLATFORM_ADMIN',
      }
      const credentialActor = {
        type: 'HUMAN' as const,
        id: human.actorId,
        role: 'PLATFORM_ADMIN' as const,
      }
      const now = new Date()

      await db.user.create({
        data: {
          id: human.actorId,
          email: `${human.actorId}@example.test`,
          fullName: 'Secondary Admin',
        },
      })
      await db.tenant.create({ data: { id: tenantId, name: 'Museum Y', slug: tenantId } })
      await db.tenantMembership.create({
        data: { tenantId, userId: human.actorId, role: 'OWNER', joinedAt: now },
      })
      const secondUserId = `secondary-contact-${suffix}`
      await db.user.create({
        data: {
          id: secondUserId,
          email: `${secondUserId}@example.test`,
          fullName: 'Secondary Venue Contact',
        },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: secondUserId, role: 'STAFF', joinedAt: now },
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Museum Y Main', slug: venueId },
          {
            id: secondVenueId,
            tenantId,
            name: 'Museum Y Sculpture Garden',
            slug: secondVenueId,
          },
          {
            id: thirdVenueId,
            tenantId,
            name: 'Museum Y Archive',
            slug: thirdVenueId,
          },
        ],
      })
      await db.prospectOrganization.create({
        data: {
          id: organizationId,
          canonicalName: 'Museum Y',
          normalizedName: `museum-y-${suffix}`,
          organizationType: 'MUSEUM',
          headquartersCity: 'Chicago',
          headquartersRegion: 'IL',
          relationshipTier: 'STRATEGIC',
          createdBy: human.actorId,
          updatedBy: human.actorId,
          contacts: {
            create: {
              fullName: 'Jane Curator',
              title: 'Director',
              email: `jane-${suffix}@example.test`,
              normalizedEmail: `jane-${suffix}@example.test`,
              preferredCommunication: 'Concise email',
              createdBy: human.actorId,
              updatedBy: human.actorId,
            },
          },
          opportunity: {
            create: {
              stage: 'WON',
              priority: 'HIGH',
              nextAction: 'Resolve map update',
              nextActionAt: new Date('2030-08-22T12:00:00.000Z'),
              createdBy: human.actorId,
              updatedBy: human.actorId,
            },
          },
        },
      })
      await db.prospectCustomerRelationship.create({
        data: {
          organizationId,
          tenantId,
          idempotencyKey: `relationship-${suffix}`,
          createdBy: human.actorId,
          startedAt: new Date('2028-01-10T12:00:00.000Z'),
        },
      })
      const thread = await db.prospectEmailThread.create({
        data: {
          organizationId,
          subject: 'Museum Y map update',
          replyTokenHash: sha(`reply-${suffix}`),
          lastMessageAt: new Date('2030-08-20T12:00:00.000Z'),
        },
      })
      await db.prospectEmailMessage.create({
        data: {
          threadId: thread.id,
          organizationId,
          direction: 'INBOUND',
          status: 'RECEIVED',
          fromAddress: `jane-${suffix}@example.test`,
          toAddresses: ['support@torchiko.test'],
          subject: 'Museum Y map update',
          textBody: 'Please keep the reply concise. The lobby map needs the promised exception.',
          bodyPreview: 'Please keep the reply concise. The lobby map needs the promised exception.',
          bodyRetentionState: 'TEMPORARY',
          bodyExpiresAt: new Date('2030-09-20T12:00:00.000Z'),
          occurredAt: new Date('2030-08-20T12:00:00.000Z'),
        },
      })
      await db.accountMilestone.createMany({
        data: [
          {
            tenantId,
            venueId,
            organizationId,
            type: 'FIRST_OUTREACH',
            occurredAt: new Date('2027-11-01T12:00:00.000Z'),
            sourceType: 'EMAIL',
            idempotencyKey: `milestone-outreach-${suffix}`,
          },
          {
            tenantId,
            venueId,
            organizationId,
            type: 'CONVERTED',
            occurredAt: new Date('2028-01-10T12:00:00.000Z'),
            sourceType: 'OPERATIONAL_EVENT',
            idempotencyKey: `milestone-converted-${suffix}`,
          },
        ],
      })
      await db.accountRelationshipNote.create({
        data: {
          tenantId,
          venueId,
          organizationId,
          category: 'COMMUNICATION_PREFERENCE',
          body: 'Jane prefers concise email for operational updates.',
          promotionStatus: 'PROMOTED',
          authority: 'DURABLE_CONTEXT',
          confidence: 0.98,
          sourceType: 'EMAIL',
          sourceId: thread.id,
          contentHash: sha('concise-email'),
          createdByType: 'HUMAN',
          createdById: human.actorId,
          idempotencyKey: `note-${suffix}`,
          lastConfirmedAt: now,
        },
      })
      await db.accountOpenLoop.create({
        data: {
          tenantId,
          venueId,
          organizationId,
          title: 'Publish corrected lobby map',
          waitingOn: 'TORCHIKO',
          sourceType: 'EMAIL',
          sourceId: thread.id,
          idempotencyKey: `open-loop-${suffix}`,
        },
      })
      await db.accountCommitment.create({
        data: {
          tenantId,
          venueId,
          organizationId,
          party: 'TORCHIKO',
          statement: 'Honor the approved map exception through renewal.',
          sourceType: 'MEETING',
          idempotencyKey: `commitment-${suffix}`,
        },
      })
      await db.accountSummary.create({
        data: {
          tenantId,
          organizationId,
          version: 1,
          summary:
            'Positive mature customer; Jane prefers concise email; a lobby map correction is waiting on Torchiko.',
          sections: {},
          sourceInputs: { sourceIds: [thread.id] },
          inputDigest: sha(thread.id),
          confidence: 0.95,
          generatedByType: 'SYSTEM',
          generatedById: 'fixture',
        },
      })
      const meeting = await db.companyMeeting.create({
        data: {
          tenantId,
          venueId,
          organizationId,
          title: 'Museum Y renewal review',
          meetingType: 'CLIENT_REVIEW',
          startedAt: new Date('2030-08-15T12:00:00.000Z'),
          transcriptStatus: 'RETAINED_EXTERNALLY',
          sourceArtifactRef: 'drive://synthetic-transcript',
          processingStatus: 'COMPLETE',
          summary: 'Confirmed the map exception and concise replies.',
          processedAt: new Date('2030-08-15T13:00:00.000Z'),
          idempotencyKey: `meeting-${suffix}`,
          participants: { create: [{ tenantId, displayName: 'Jane Curator', role: 'Director' }] },
          extractions: {
            create: [
              {
                tenantId,
                type: 'CLIENT_PREFERENCE',
                content: 'Jane prefers concise replies.',
                promotionStatus: 'PROMOTED',
                createdByType: 'SYSTEM',
                createdById: 'fixture',
                idempotencyKey: `meeting-extraction-${suffix}`,
              },
            ],
          },
        },
      })
      const unprocessedMeeting = await db.companyMeeting.create({
        data: {
          tenantId,
          venueId,
          organizationId,
          title: 'Museum Y launch follow-up',
          meetingType: 'CLIENT_REVIEW',
          startedAt: new Date('2030-08-20T15:00:00.000Z'),
          transcriptStatus: 'RETAINED_EXTERNALLY',
          sourceArtifactRef: 'drive://synthetic-launch-transcript',
          processingStatus: 'RECEIVED',
          idempotencyKey: `meeting-unprocessed-${suffix}`,
        },
      })

      const oldDecision = await createCompanyKnowledgeCandidateAction({
        tenantId,
        venueId,
        organizationId,
        type: 'DECISION',
        title: 'Museum Y map pricing',
        summary: 'Old map work was charged separately.',
        body: 'Charge Museum Y for map changes.',
        accessScope: 'ORGANIZATION',
        authority: 'AUTHORITATIVE_CURRENT',
        sourceType: 'MEETING',
        sourceId: meeting.id,
        idempotencyKey: `decision-old-${suffix}`,
        actor: human,
      })
      await promoteCompanyKnowledgeAction({
        knowledgeItemId: oldDecision.id,
        tenantId,
        promotionReason: 'Synthetic prior policy',
        actor: human,
      })
      const currentDecision = await createCompanyKnowledgeCandidateAction({
        tenantId,
        venueId,
        organizationId,
        type: 'DECISION',
        title: 'Museum Y map exception',
        summary: 'Honor map corrections without an add-on through renewal.',
        body: 'Museum Y has a bounded map-correction exception through the current renewal.',
        accessScope: 'ORGANIZATION',
        authority: 'AUTHORITATIVE_CURRENT',
        sourceType: 'MEETING',
        sourceId: meeting.id,
        idempotencyKey: `decision-current-${suffix}`,
        actor: human,
      })
      await promoteCompanyKnowledgeAction({
        knowledgeItemId: currentDecision.id,
        tenantId,
        promotionReason: 'Approved replacement policy',
        actor: human,
      })
      await supersedeCompanyKnowledgeAction({
        priorItemId: oldDecision.id,
        replacementItemId: currentDecision.id,
        tenantId,
        reason: 'Renewal decision replaced prior pricing treatment.',
        actor: human,
      })

      const allVenueKnowledge = await createCompanyKnowledgeCandidateAction({
        tenantId,
        organizationId,
        type: 'OPERATIONAL_LESSON',
        title: 'Museum Y shared operating guidance',
        summary: 'Use concise customer updates across every Museum Y venue.',
        body: 'All Museum Y venues inherit the concise-update operating guidance.',
        accessScope: 'ORGANIZATION',
        authority: 'DURABLE_CONTEXT',
        sourceType: 'MEETING',
        sourceId: meeting.id,
        idempotencyKey: `knowledge-all-venues-${suffix}`,
        actor: human,
      })
      const subsetKnowledge = await createCompanyKnowledgeCandidateAction({
        tenantId,
        organizationId,
        applicableVenueIds: [venueId, secondVenueId],
        type: 'OPERATIONAL_LESSON',
        title: 'Museum Y seasonal sculpture guidance',
        summary: 'Main and sculpture venues share seasonal sculpture guidance.',
        body: 'Apply this guidance only to the main museum and sculpture garden.',
        accessScope: 'ORGANIZATION',
        authority: 'DURABLE_CONTEXT',
        sourceType: 'MEETING',
        sourceId: meeting.id,
        idempotencyKey: `knowledge-venue-subset-${suffix}`,
        actor: human,
      })
      const exactVenueKnowledge = await createCompanyKnowledgeCandidateAction({
        tenantId,
        venueId,
        organizationId,
        type: 'OPERATIONAL_LESSON',
        title: 'Museum Y main-lobby guidance',
        summary: 'The main-lobby guidance is specific to the main museum.',
        body: 'Do not inherit this main-lobby guidance into another venue.',
        accessScope: 'ORGANIZATION',
        authority: 'DURABLE_CONTEXT',
        sourceType: 'MEETING',
        sourceId: meeting.id,
        idempotencyKey: `knowledge-exact-venue-${suffix}`,
        actor: human,
      })
      for (const knowledgeItemId of [
        allVenueKnowledge.id,
        subsetKnowledge.id,
        exactVenueKnowledge.id,
      ]) {
        await promoteCompanyKnowledgeAction({
          knowledgeItemId,
          tenantId,
          promotionReason: 'Disposable scoped-knowledge proof',
          actor: human,
        })
      }

      const searchForVenue = async (requestedVenueId: string) =>
        searchCompanyKnowledge(
          {
            query: 'Museum guidance',
            clientId: tenantId,
            venueId: requestedVenueId,
            organizationId,
            limit: 20,
          },
          { kind: 'CLIENT', clientId: tenantId, roles: ['CLIENT_ADMIN'] },
        )
      const [mainKnowledge, secondKnowledge, thirdKnowledge] = await Promise.all([
        searchForVenue(venueId),
        searchForVenue(secondVenueId),
        searchForVenue(thirdVenueId),
      ])
      const ids = (result: Awaited<ReturnType<typeof searchForVenue>>) =>
        new Set(result.results.map((item) => item.id))
      const mainIds = ids(mainKnowledge)
      const secondIds = ids(secondKnowledge)
      const thirdIds = ids(thirdKnowledge)
      expect(mainIds.has(allVenueKnowledge.id)).toBe(true)
      expect(mainIds.has(subsetKnowledge.id)).toBe(true)
      expect(mainIds.has(exactVenueKnowledge.id)).toBe(true)
      expect(secondIds.has(allVenueKnowledge.id)).toBe(true)
      expect(secondIds.has(subsetKnowledge.id)).toBe(true)
      expect(secondIds.has(exactVenueKnowledge.id)).toBe(false)
      expect(thirdIds.has(allVenueKnowledge.id)).toBe(true)
      expect(thirdIds.has(subsetKnowledge.id)).toBe(false)
      expect(thirdIds.has(exactVenueKnowledge.id)).toBe(false)
      await expect(searchForVenue(`foreign-venue-${suffix}`)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      expect(await db.tenantMembership.count({ where: { tenantId } })).toBe(2)
      expect(await db.venue.count({ where: { tenantId } })).toBe(3)

      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `client-operations-${suffix}`,
          name: 'Client Operations Specialist',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['updates:draft', 'meetings.process'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: human.actorId,
        },
      })
      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor: credentialActor,
        kind: 'MCP',
        label: 'Secondary worker credential',
        capabilities: [
          'resources:read',
          'accounts:read',
          'knowledge:read',
          'meetings:read',
          'meetings:process',
          'integrations:read',
          'updates:draft',
          'agent-runs:execute',
        ],
        expiresAt: new Date('2030-08-22T12:00:00.000Z'),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor: credentialActor,
      })
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const oldNow = new Date(now.getTime() - 10 * 60_000)
      await registerAgentWorkerAction(
        {
          workerKey: primaryKey,
          runtimeType: 'HERMES',
          label: 'Tom primary worker',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'fixture/1',
          capabilities: ['accounts:read'],
          agentRoles: ['client-operations'],
          safeHealth: {},
        },
        credential,
        { now: oldNow, leaseSeconds: 30 },
      )
      const secondary = await registerAgentWorkerAction(
        {
          workerKey: secondaryKey,
          runtimeType: 'OPENAI_COMPATIBLE',
          label: 'Independent worker',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'fixture/1',
          capabilities: [
            'accounts:read',
            'knowledge:read',
            'meetings:read',
            'meetings:process',
            'updates:draft',
          ],
          agentRoles: ['client-operations'],
          modelProvider: 'fixture',
          modelName: 'deterministic',
          safeHealth: { state: 'ready' },
        },
        credential,
        { now, leaseSeconds: 300 },
      )
      const health = await listAgentWorkerHealth({ clientId: tenantId, now })
      expect(health.find((worker) => worker.workerKey === primaryKey)?.status).toBe('OFFLINE')
      expect(health.find((worker) => worker.workerKey === secondaryKey)?.status).toBe('ONLINE')

      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'SUPPORT',
          requestedOperation: 'account-handoff',
          requestPrompt: 'Resolve Museum Y map request.',
          scopeSnapshot: { organizationId },
          status: 'RUNNING',
          modelProvider: 'fixture',
          modelName: 'deterministic',
          initiatedByType: 'HUMAN',
          initiatedById: human.actorId,
          executionWorkerId: health.find((worker) => worker.workerKey === primaryKey)!.id,
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: new Date(now.getTime() - 1_000),
          attemptNumber: 1,
          startedAt: new Date(now.getTime() - 60_000),
        },
      })
      const reclaimed = await claimAgentRunExecution({ tenantId, runId: run.id })
      await db.agentRun.update({
        where: { id: run.id },
        data: { executionWorkerId: secondary.id },
      })
      expect(reclaimed.attemptNumber).toBe(2)

      const startsAt = '2030-08-21T13:00:00.000Z'
      const expiresAt = '2030-08-22T13:00:00.000Z'
      const parameters = {
        clientId: tenantId,
        venueId,
        updateType: 'GENERAL_NOTICE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: 'Lobby map correction',
        body: 'The corrected lobby map is ready for internal review.',
        startsAt,
        expiresAt,
      }
      const approvalRequest = await db.approvalRequest.create({
        data: {
          tenantId,
          venueId,
          agentIdentityId: identityId,
          agentRunId: run.id,
          requestedByType: 'AGENT',
          requestedById: identityId,
          proposedAction: 'pathfinder.create_update_draft',
          scopeSnapshot: { tenantId, venueId, parameters },
          reason: 'Publish the approved internal correction draft.',
          riskCategory: 'LOW',
          expiresAt: new Date('2030-08-22T12:00:00.000Z'),
        },
      })
      const approvalDecision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: approvalRequest.id,
        decision: 'APPROVED',
        reason: 'Exact bounded draft approved by the secondary administrator.',
        actor: { actorType: 'HUMAN', actorId: human.actorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const grant = await issueApprovalGrantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        actionName: 'pathfinder.create_update_draft',
        capability: 'updates:draft',
        mode: 'ONE_SHOT',
        scope: { tenantId, venueId },
        parameters,
        approvalDecisionId: approvalDecision.id,
        issueReason: 'Approve this exact synthetic operational-update draft for the shakedown.',
        expiresAt: new Date('2030-08-22T12:00:00.000Z'),
        actor: credentialActor,
      })
      const registry = createSafeOperationalMcpRegistry(db)
      const context = { credential, approvalGrantId: grant.id }
      const account = await registry.callTool(
        'torchiko.account.get_context',
        {
          clientId: tenantId,
          venueId,
          organizationId,
          recentLimit: 8,
        },
        { credential },
      )
      expect(JSON.stringify(account)).toContain('Museum Y')
      expect(JSON.stringify(account)).toContain('Publish corrected lobby map')
      const knowledge = await registry.callTool(
        'torchiko.knowledge.search',
        {
          clientId: tenantId,
          organizationId,
          query: 'map exception pricing',
          limit: 5,
        },
        { credential },
      )
      expect(JSON.stringify(knowledge)).toContain('Museum Y map exception')
      expect(JSON.stringify(knowledge)).not.toContain('Old map work was charged separately')
      const meetingResult = await registry.callTool(
        'torchiko.account.meeting_get',
        {
          clientId: tenantId,
          venueId,
          meetingId: meeting.id,
        },
        { credential },
      )
      expect(JSON.stringify(meetingResult)).toContain('drive://synthetic-transcript')
      const processedMeeting = await registry.callTool(
        'torchiko.meeting.process',
        {
          clientId: tenantId,
          venueId,
          operationId: randomUUID(),
          meetingId: unprocessedMeeting.id,
          agentIdentityId: identityId,
          agentRunId: run.id,
          workerKey: secondaryKey,
          summary: 'Confirmed September launch and a concise customer review.',
          extractions: [
            {
              type: 'DECISION',
              content: 'Launch on September 1.',
              structuredData: { date: '2030-09-01' },
              confidence: 0.99,
            },
            {
              type: 'CLIENT_PREFERENCE',
              content: 'Keep the launch review concise.',
              structuredData: {},
            },
          ],
        },
        { credential },
      )
      expect(JSON.stringify(processedMeeting)).toContain('processing completed')
      expect(
        await db.companyMeeting.findUniqueOrThrow({
          where: { id: unprocessedMeeting.id },
          select: { processingStatus: true, _count: { select: { extractions: true } } },
        }),
      ).toEqual({ processingStatus: 'COMPLETE', _count: { extractions: 2 } })

      const operationId = randomUUID()
      const writeInput = {
        clientId: tenantId,
        venueId,
        operationId,
        agentIdentityId: identityId,
        agentRunId: run.id,
        workerKey: secondaryKey,
        title: parameters.title,
        body: parameters.body,
        startsAt,
        expiresAt,
      }
      const created = await registry.callTool('pathfinder.create_update_draft', writeInput, context)
      const replayed = await registry.callTool(
        'pathfinder.create_update_draft',
        writeInput,
        context,
      )
      expect(JSON.stringify(created)).toContain('Approved draft created')
      expect(JSON.stringify(replayed)).toContain('Existing approved draft returned')
      await expect(
        registry.callTool(
          'pathfinder.create_update_draft',
          {
            ...writeInput,
            operationId: randomUUID(),
            title: 'Out-of-scope second write',
          },
          context,
        ),
      ).rejects.toThrow('no remaining uses')
      expect(await db.operationalUpdate.count({ where: { tenantId, venueId } })).toBe(1)
      expect(
        await db.approvalGrantConsumption.count({ where: { approvalGrantId: grant.id } }),
      ).toBe(1)
      const audit = await db.auditLog.findFirstOrThrow({
        where: { tenantId, action: 'operational-update.created-draft' },
        orderBy: { createdAt: 'desc' },
      })
      expect(audit).toMatchObject({
        actorType: 'AGENT',
        actorId: identityId,
        agentRunId: run.id,
        workerId: secondaryKey,
        credentialId: credential.credentialId,
        approvalGrantId: grant.id,
        capability: 'updates:draft',
      })

      const policyOperationId = randomUUID()
      const policyInput = {
        operationId: policyOperationId,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        actionName: 'pathfinder.create_update_draft',
        capability: 'updates:draft',
        mode: 'POLICY_BACKED' as const,
        scope: { contractVersion: 1, tenantId, venueId, effect: 'DRAFT_ONLY' },
        policyKey: `reviewed-update-drafts-${suffix}`,
        constraints: {
          ...defaultOperationalUpdateDraftPolicyConstraints(),
          maxTitleChars: 40,
          maxBodyChars: 200,
        },
        issueReason: 'Synthetic reviewed evidence authorizes bounded informational drafts.',
        maxUses: 2,
        actor: credentialActor,
      }
      const policyGrant = await issueApprovalGrantAction(policyInput)
      const policyReplay = await issueApprovalGrantAction(policyInput)
      expect(policyGrant.replayed).toBe(false)
      expect(policyReplay).toMatchObject({ id: policyGrant.id, replayed: true })

      const policyContext = { credential, approvalGrantId: policyGrant.id }
      const policyWriteInput = {
        ...writeInput,
        operationId: randomUUID(),
        title: 'Gallery review note',
        body: 'A bounded informational draft prepared under reviewed policy.',
      }
      const policyCreated = await registry.callTool(
        'pathfinder.create_update_draft',
        policyWriteInput,
        policyContext,
      )
      expect(JSON.stringify(policyCreated)).toContain('Approved draft created')
      await expect(
        registry.callTool(
          'pathfinder.create_update_draft',
          {
            ...policyWriteInput,
            operationId: randomUUID(),
            title: 'This title deliberately exceeds the reviewed forty character policy limit',
          },
          policyContext,
        ),
      ).rejects.toThrow('outside the reviewed operational-update draft policy')
      expect(await db.operationalUpdate.count({ where: { tenantId, venueId } })).toBe(2)
      expect(
        await db.approvalGrantConsumption.count({ where: { approvalGrantId: policyGrant.id } }),
      ).toBe(1)

      // This entire proof uses only Torchiko's disposable PostgreSQL state. No Obsidian bridge,
      // Tom-local worker, private prompt memory, external provider, or raw transcript is required.
      expect(
        await db.agentRun.findUnique({ where: { id: run.id }, select: { status: true } }),
      ).toEqual({ status: 'RUNNING' })
    })
  }, 60_000)
})
