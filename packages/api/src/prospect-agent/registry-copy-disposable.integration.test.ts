import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  activateAgentBridgeCredentialAction,
  claimAgentBridgeTask,
  createCompanyKnowledgeCandidateAction,
  createProspectAction,
  createProspectCampaignAction,
  db,
  issueExternalCredentialAction,
  registerAgentBridgeSession,
  registerAgentWorkerAction,
  reviewProspectContactReadinessAction,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { createProspectAgentRegistry, type ProspectAgentInvocation } from './registry'

const enabled =
  process.env.RUN_PROSPECT_AGENT_COPY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

type PersistedGrounding = {
  resolvedSourceEvidence?: Array<{ id: string; sourceUrl: string; sha256: string }>
  copyHandoff?: {
    copySources?: Array<{ id: string; version: string; status: string; provenance: string }>
    warnings?: string[]
    reviewRequired?: boolean
    sendAuthorized?: boolean
  }
}

describe.skipIf(!enabled)('prospect registry candidate-copy disposable boundary', () => {
  afterAll(async () => db.$disconnect())

  it('persists a proposed candidate-copy handoff through a live bridge lease without send authority', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 12)
      const tenantId = `prospect-copy-tenant-${suffix}`
      const venueId = `prospect-copy-venue-${suffix}`
      const identityId = `prospect-copy-agent-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: `prospect-copy-operator-${suffix}`,
        role: 'PLATFORM_ADMIN' as const,
      }
      const knowledgeActor = {
        type: 'HUMAN' as const,
        actorId: actor.id,
        role: 'PLATFORM_ADMIN' as const,
      }
      await db.tenant.create({
        data: { id: tenantId, name: `Prospect copy tenant ${suffix}`, slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: `Prospect copy venue ${suffix}`, slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `prospect.copy.${suffix}`,
          name: 'Disposable prospect copy agent',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['prospects.read', 'prospects.draft'],
          autonomyLevel: 'READ_ONLY',
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
          enabled: true,
          createdBy: actor.id,
        },
      })

      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Disposable prospect-copy registry credential',
        capabilities: ['agent-runs:execute'],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      const activated = await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor,
      })
      expect(activated.credential.enabled).toBe(true)
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const workerKey = `prospect-copy-worker-${suffix}`
      await registerAgentWorkerAction(
        {
          workerKey,
          runtimeType: 'CODEX',
          label: 'Disposable prospect-copy worker',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'fixture/1',
          capabilities: ['agent-runs:execute'],
          agentRoles: ['operations'],
          safeHealth: {},
        },
        credential,
      )
      const sessionId = randomUUID()
      await registerAgentBridgeSession({
        sessionId,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Disposable prospect-copy runner',
        runnerVersion: 'fixture/1',
        supportedModels: ['subscription-default'],
        credential,
      })
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'prospect_copy_fixture',
          requestPrompt: 'Create a review-only prospect draft from bounded candidate copy.',
          scopeSnapshot: {
            accessCapabilities: ['prospects.read', 'prospects.draft'],
            prospectScope: { mode: 'ALL' },
            promptIdentity: 'prospect-copy-fixture@1',
          },
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
        },
      })
      const claim = await claimAgentBridgeTask({ sessionId, venueId, workerKey, credential })
      expect(claim.task).toMatchObject({
        id: run.id,
        agent: { identityKey: `prospect.copy.${suffix}` },
      })
      if (!claim.task) throw new Error('Fixture bridge did not claim the prospect-copy AgentRun')

      const candidate = await createCompanyKnowledgeCandidateAction({
        type: 'POLICY_CONTEXT',
        title: 'Disposable proposed outreach opening',
        summary: 'A fictional opening for review-only copy handoff coverage.',
        body: 'Use this fictional opening only as a proposed review input.',
        structuredData: { allowedUses: ['OUTREACH'] },
        accessScope: 'PLATFORM',
        authority: 'DURABLE_CONTEXT',
        sourceType: 'HUMAN_ENTRY',
        sourceRef: `fixture://prospect-copy/${suffix}`,
        idempotencyKey: `prospect-copy-candidate-${suffix}`,
        actor: knowledgeActor,
      })
      expect(candidate.promotionStatus).toBe('CANDIDATE')
      const candidateRevision = await db.companyKnowledgeItem.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { revisions: { where: { revision: 1 }, select: { sourceDigest: true } } },
      })
      const candidateSourceDigest = candidateRevision.revisions[0]?.sourceDigest
      if (!candidateSourceDigest)
        throw new Error('Fixture candidate requires revision-one source digest')

      const prospect = await createProspectAction({
        organization: {
          canonicalName: `Fictional prospect organization ${suffix}`,
          source: 'disposable-prospect-copy-fixture',
        },
        venue: { name: `Fictional prospect venue ${suffix}`, city: 'Chicago', region: 'IL' },
        contact: {
          fullName: 'Fixture Contact',
          email: `prospect-copy-${suffix}@example.test`,
          source: 'disposable-prospect-copy-fixture',
        },
        actor,
      })
      if (!prospect.venue || !prospect.contact)
        throw new Error('Fixture prospect requires a venue and contact')
      const source = await db.prospectSourceEvidence.create({
        data: {
          organizationId: prospect.organization.id,
          venueId: prospect.venue.id,
          contactId: prospect.contact.id,
          sourceType: 'WEBSITE',
          sourceUrl: 'https://example.test/fictional-venue',
          sourceLabel: 'Fictional venue page',
          capturedValue: { detail: 'A fictional venue detail for draft-only proof.' },
          researchedAt: new Date('2026-09-25T12:00:00.000Z'),
          createdBy: actor.id,
        },
        select: { id: true },
      })
      await reviewProspectContactReadinessAction({
        contactId: prospect.contact.id,
        emailReadiness: 'VALID',
        permissionState: 'LEGITIMATE_INTEREST_RECORDED',
        evidence: {
          reviewReason: 'Disposable contact fixture reviewed for draft-only testing.',
          source: 'disposable-prospect-copy-fixture',
          reviewedFor: 'draft-only',
        },
        actor,
      })
      const campaign = await createProspectCampaignAction({
        name: `Disposable prospect-copy campaign ${suffix}`,
        organizationIds: [prospect.organization.id],
        cohortSnapshot: { source: 'disposable-prospect-copy-fixture' },
        actor,
      })
      const member = await db.prospectCampaignMember.findFirstOrThrow({
        where: { campaignId: campaign.id, organizationId: prospect.organization.id },
        select: { id: true },
      })
      const invocation: ProspectAgentInvocation = {
        tenantId,
        venueId,
        sessionId,
        agentRunId: run.id,
        leaseToken: claim.task.leaseToken,
        credentialId: issued.credential.id,
        correlationId: randomUUID(),
      }
      const registry = createProspectAgentRegistry()
      const found = (await registry.callTool(
        'torchiko.prospects.search',
        { query: prospect.organization.canonicalName },
        invocation,
      )) as Array<{ id: string }>
      expect(found.map((organization) => organization.id)).toContain(prospect.organization.id)
      const intelligence = (await registry.callTool(
        'torchiko.prospects.get_intelligence',
        { organizationId: prospect.organization.id },
        invocation,
      )) as { prospect: { sources: Array<{ id: string; sourceUrl: string }> } }
      expect(intelligence.prospect.sources).toContainEqual(
        expect.objectContaining({ id: source.id, sourceUrl: 'https://example.test/fictional-venue' }),
      )
      const members = (await registry.callTool(
        'torchiko.prospects.list_campaign_members',
        { campaignId: campaign.id },
        invocation,
      )) as Array<{ id: string }>
      expect(members.map((campaignMember) => campaignMember.id)).toContain(member.id)
      const draft = (await registry.callTool(
        'torchiko.prospects.save_outreach_draft',
        {
          memberId: member.id,
          subject: 'A fictional review-only opening',
          textBody: 'This fictional draft remains a proposed opening for human review.',
          evidence: [{ kind: 'SOURCE_EVIDENCE', reference: source.id }],
          sourceEvidenceIds: [source.id],
          template: { id: 'fixture-intro', version: '1' },
          prompt: { id: 'fixture-prospect-copy', version: '1' },
          copySources: [{ id: candidate.id, version: '1' }],
        },
        invocation,
      )) as { id: string }
      const persisted = await db.prospectOutreachDraft.findUniqueOrThrow({
        where: { id: draft.id },
        select: { id: true, status: true, groundingSnapshot: true, memberId: true, contentHash: true },
      })
      const grounding = persisted.groundingSnapshot as PersistedGrounding
      expect(persisted).toMatchObject({ id: draft.id, memberId: member.id, status: 'NEEDS_REVIEW' })
      expect(grounding.resolvedSourceEvidence).toContainEqual(
        expect.objectContaining({
          id: source.id,
          sourceUrl: 'https://example.test/fictional-venue',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      )
      expect(grounding.copyHandoff).toMatchObject({
        copySources: [
          {
            id: candidate.id,
            version: '1',
            status: 'PROPOSED',
            provenance: candidateSourceDigest,
          },
        ],
        warnings: ['Draft uses proposed copy that still needs founder approval.'],
        reviewRequired: true,
        sendAuthorized: false,
      })
      const ownerReadback = (await registry.callTool(
        'torchiko.prospects.get_outreach_draft',
        { memberId: member.id, draftId: draft.id },
        invocation,
      )) as { id: string; status: string; contentHash: string; groundingSnapshot: PersistedGrounding }
      expect(ownerReadback).toMatchObject({
        id: persisted.id,
        status: 'NEEDS_REVIEW',
        contentHash: persisted.contentHash,
      })
      expect(ownerReadback.groundingSnapshot.copyHandoff).toEqual(grounding.copyHandoff)
      expect(ownerReadback.groundingSnapshot.resolvedSourceEvidence).toEqual(
        grounding.resolvedSourceEvidence,
      )
      expect(await db.prospectSendBatch.count({ where: { campaignId: campaign.id } })).toBe(0)
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { memberId: member.id } } })).toBe(0)

      const draftCount = await db.prospectOutreachDraft.count({ where: { memberId: member.id } })
      await expect(
        registry.callTool(
          'torchiko.prospects.save_outreach_draft',
          {
            memberId: member.id,
            subject: 'A version-mismatch copy attempt',
            textBody: 'This fixture must not create a later draft version.',
            evidence: [{ kind: 'CRM_FIELD', reference: 'fixture:prospect-name' }],
            template: { id: 'fixture-intro', version: '1' },
            prompt: { id: 'fixture-prospect-copy', version: '1' },
            copySources: [{ id: candidate.id, version: '2' }],
          },
          invocation,
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
      expect(await db.prospectOutreachDraft.count({ where: { memberId: member.id } })).toBe(
        draftCount,
      )

      const unsuitableCandidate = await createCompanyKnowledgeCandidateAction({
        type: 'POLICY_CONTEXT',
        title: 'Disposable non-outreach candidate',
        summary: 'A fictional candidate that cannot support outreach.',
        body: 'This fictional candidate allows proposals only.',
        structuredData: { allowedUses: ['PROPOSAL'] },
        accessScope: 'PLATFORM',
        authority: 'INFERENCE',
        sourceType: 'HUMAN_ENTRY',
        sourceRef: `fixture://prospect-copy/no-outreach/${suffix}`,
        idempotencyKey: `prospect-copy-no-outreach-${suffix}`,
        actor: knowledgeActor,
      })
      await expect(
        registry.callTool(
          'torchiko.prospects.save_outreach_draft',
          {
            memberId: member.id,
            subject: 'A disallowed copy attempt',
            textBody: 'This fixture must not create a later draft version.',
            evidence: [{ kind: 'CRM_FIELD', reference: 'fixture:prospect-name' }],
            template: { id: 'fixture-intro', version: '1' },
            prompt: { id: 'fixture-prospect-copy', version: '1' },
            copySources: [{ id: unsuitableCandidate.id, version: '1' }],
          },
          invocation,
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' })
      expect(await db.prospectOutreachDraft.count({ where: { memberId: member.id } })).toBe(
        draftCount,
      )
      expect(await db.prospectSendBatch.count({ where: { campaignId: campaign.id } })).toBe(0)
      expect(await db.prospectSendOutbox.count({ where: { sendItem: { memberId: member.id } } })).toBe(0)
    })
  }, 30_000)
})
