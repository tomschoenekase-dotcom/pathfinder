import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AnthropicMessagesClient } from '@pathfinder/ai'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'provider-dark-test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/rate-limit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }))
vi.mock('../../lib/guest-query-embedding', () => ({
  generateGuestQueryEmbedding: vi.fn(
    async (
      _text: string,
      _usageSink: unknown,
      _admissionGuard: unknown,
      _budgetGate: unknown,
      _invocationId: string | undefined,
      onBeforeFirstDispatch: (() => Promise<void>) | undefined,
    ) => {
      await onBeforeFirstDispatch?.()
      return null
    },
  ),
}))

import {
  createUniversalContentAction,
  db,
  publishUniversalContentAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { mergeRouters, router } from '../../core'
import type { TRPCContext } from '../../context'
import { _setAnthropicClientForTesting, chatRouter } from '../chat'
import { retrieveGuestKnowledge } from '../../lib/guest-knowledge-retrieval'
import { previewSemanticVenueUpdateFromProposal } from '../../lib/semantic-venue-updater-service'
import { createSemanticUniversalContentDraftService } from '../../lib/semantic-universal-content-handoff-service'
import { adminConversationLearningRouter } from './conversation-learning'
import { adminKnowledgeProposalsRouter } from './knowledge-proposals'

const enabled =
  process.env.RUN_GUIDE_CORRECTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_native_guest_read_[a-f0-9]{12}$/.test(process.env.DATABASE_URL ?? '')

const app = router({
  chat: chatRouter,
  admin: mergeRouters(adminConversationLearningRouter, adminKnowledgeProposalsRouter),
})

describe.skipIf(!enabled)('reviewed guide correction across two disposable venues', () => {
  afterAll(async () => {
    _setAnthropicClientForTesting(null)
    await db.$disconnect()
  })

  it('keeps claims inert until a reviewer publishes each scoped correction', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-guide-correction-${suffix}`
      const adminId = `admin-guide-correction-${suffix}`
      const actor = { type: 'HUMAN' as const, id: adminId, role: 'PLATFORM_ADMIN' as const }
      const cases = [
        {
          venueId: `museum-correction-${suffix}`,
          title: 'Case 12 house date',
          query: 'When was the Case 12 house created?',
          wrong: 'The Case 12 house was created in 1914.',
          correct: 'The Case 12 house was created in 1904.',
        },
        {
          venueId: `gallery-correction-${suffix}`,
          title: 'Lantern mural date',
          query: 'When was the Lantern mural created?',
          wrong: 'The Lantern mural was created in 1982.',
          correct: 'The Lantern mural was created in 1992.',
        },
      ] as const
      const addedFact = 'The Case 12 house has a copper roof.'
      const additionQuery = 'What kind of roof does the Case 12 house have?'
      await db.tenant.create({
        data: { id: tenantId, slug: tenantId, name: 'Guide correction fixture' },
      })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.createMany({
        data: cases.map(({ venueId }) => ({
          id: venueId,
          tenantId,
          slug: venueId,
          name: venueId,
          guideMode: 'non_location',
        })),
      })

      const initial = new Map<string, { moduleId: string; revisionId: string }>()
      for (const item of cases) {
        const created = await createUniversalContentAction({
          db,
          tenantId,
          venueId: item.venueId,
          moduleId: randomUUID(),
          actor,
          draft: {
            audience: 'PUBLIC',
            evidence: [],
            payload: { kind: 'POLICY', title: item.title, rule: item.wrong, appliesTo: [] },
          },
        })
        await publishUniversalContentAction({
          db,
          tenantId,
          venueId: item.venueId,
          moduleId: created.moduleId,
          revisionId: created.revisionId,
          expectedLatestVersion: 1,
          requestId: randomUUID(),
          actor,
        })
        initial.set(item.venueId, created)
      }

      const provider = vi.fn(async (request: { system: Array<{ text: string }> }) => {
        const grounding = request.system.map((block) => block.text).join('')
        const answer =
          (grounding.includes(addedFact) ? addedFact : null) ??
          cases.find((item) => grounding.includes(item.correct))?.correct ??
          cases.find((item) => grounding.includes(item.wrong))?.wrong ??
          'No fixture fact was supplied.'
        return {
          content: [{ type: 'text', text: answer }],
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }
      })
      _setAnthropicClientForTesting({ messages: { create: provider } } as AnthropicMessagesClient)
      const visitorContext: TRPCContext = {
        db,
        headers: new Headers(),
        session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
      }
      const adminContext: TRPCContext = {
        db,
        headers: new Headers(),
        session: { userId: adminId, activeTenantId: null, role: null, isPlatformAdmin: true },
      }
      const admin = app.createCaller(adminContext).admin
      const send = (venueId: string, anonymousToken: string, message: string) =>
        app.createCaller(visitorContext).chat.send({
          venueId,
          anonymousToken,
          operationId: randomUUID(),
          message,
        })
      const read = (venueId: string, query: string) =>
        retrieveGuestKnowledge({
          reader: db,
          tenantId,
          venueId,
          query,
          includeSecondLayer: false,
          queryEmbedding: null,
        })

      for (const item of cases) {
        const token = randomUUID()
        const original = await send(item.venueId, token, item.query)
        expect(original.response).toContain(item.wrong)
        const correction = await send(
          item.venueId,
          token,
          item === cases[0]
            ? `This isn't quite right. ${item.correct}`
            : `Your answer is wrong. ${item.correct}`,
        )
        expect(correction.response).toContain(item.wrong)
        const session = await db.visitorSession.findFirstOrThrow({
          where: { tenantId, venueId: item.venueId, anonymousToken: token },
          select: { id: true },
        })
        const turns = await db.guestChatTurn.findMany({
          where: { tenantId, venueId: item.venueId, sessionId: session.id },
          orderBy: { turnSequence: 'asc' },
          select: { assistantMessageId: true, userMessageId: true },
        })
        expect(turns).toHaveLength(2)
        const candidate = await db.conversationInsight.findFirstOrThrow({
          where: {
            tenantId,
            venueId: item.venueId,
            sessionId: session.id,
            category: 'CONTENT_UPDATE_CANDIDATE',
          },
          select: {
            id: true,
            candidateRevision: true,
            candidateProvenance: true,
            evidenceMessageIds: true,
          },
        })
        expect(candidate.candidateProvenance).toMatchObject({
          verification: 'UNVERIFIED',
          classifier: { kind: 'FACTUAL_CORRECTION' },
        })
        expect(candidate.evidenceMessageIds).toEqual([
          turns[0]!.assistantMessageId,
          turns[1]!.userMessageId,
        ])
        const beforeReview = await read(item.venueId, item.query)
        expect(beforeReview.entries.map((entry) => entry.content)).toContain(item.wrong)
        expect(beforeReview.entries.map((entry) => entry.content)).not.toContain(item.correct)

        await admin.reviewConversationLearningCandidate({
          tenantId,
          venueId: item.venueId,
          operationId: randomUUID(),
          insightId: candidate.id,
          expectedRevision: candidate.candidateRevision,
          action: 'ACCEPT_FOR_PROPOSAL',
          reviewerFeedback: 'Checked the label against the venue-approved source.',
        })
        const target = await db.venueKnowledgeEntry.findFirstOrThrow({
          where: {
            tenantId,
            venueId: item.venueId,
            contentModuleId: initial.get(item.venueId)!.moduleId,
          },
          select: { id: true },
        })
        const proposal = await admin.createKnowledgeProposal({
          operationId: randomUUID(),
          tenantId,
          venueId: item.venueId,
          conversationInsightId: candidate.id,
          targetKnowledgeEntryId: target.id,
          observedVisitorClaim: item.correct,
          proposedChange: item.correct,
          reason: 'Reviewed fixture label confirms the corrected date.',
          confidence: 1,
          evidenceMessageIds: [turns[0]!.assistantMessageId!, turns[1]!.userMessageId!],
          submitForReview: true,
        })
        const pending = await db.knowledgeChangeProposal.findUniqueOrThrow({
          where: { id: proposal.id },
          select: { updatedAt: true },
        })
        await admin.reviewKnowledgeProposal({
          operationId: randomUUID(),
          tenantId,
          venueId: item.venueId,
          proposalId: proposal.id,
          expectedUpdatedAt: pending.updatedAt.toISOString(),
          decision: 'APPROVED',
          reviewNote: 'Fixture source confirms the corrected date.',
        })
        const approved = await db.knowledgeChangeProposal.findUniqueOrThrow({
          where: { id: proposal.id },
          select: { updatedAt: true },
        })
        const desired = {
          title: item.title,
          category: 'POLICY',
          content: item.correct,
          isEnabled: true,
        }
        const preview = await previewSemanticVenueUpdateFromProposal({
          db,
          tenantId,
          venueId: item.venueId,
          proposalId: proposal.id,
          expectedUpdatedAt: approved.updatedAt,
          relation: 'CORRECTS',
          desired,
        })
        expect(preview.classification).toBe('CORRECTION')
        const drafted = await createSemanticUniversalContentDraftService({
          db,
          actorId: adminId,
          input: {
            tenantId,
            venueId: item.venueId,
            proposalId: proposal.id,
            expectedProposalUpdatedAt: approved.updatedAt.toISOString(),
            expectedPreviewHash: preview.previewHash,
            relation: 'CORRECTS',
            desired,
            draft: {
              audience: 'PUBLIC',
              evidence: [
                {
                  sourceId: `fixture-reviewed-label:${item.venueId}`,
                  locator: 'label',
                  capturedAt: new Date().toISOString(),
                  excerptHash: 'a'.repeat(64),
                },
              ],
              payload: { kind: 'POLICY', title: item.title, rule: item.correct, appliesTo: [] },
            },
          },
        })
        expect(drafted.version).toBe(2)
        const stillUnpublished = await read(item.venueId, item.query)
        expect(stillUnpublished.entries.map((entry) => entry.content)).toContain(item.wrong)
        expect(stillUnpublished.entries.map((entry) => entry.content)).not.toContain(item.correct)
        await publishUniversalContentAction({
          db,
          tenantId,
          venueId: item.venueId,
          moduleId: drafted.moduleId,
          revisionId: drafted.revisionId,
          expectedLatestVersion: 2,
          requestId: randomUUID(),
          actor,
        })
        const fresh = await send(item.venueId, randomUUID(), item.query)
        expect(fresh.response).toContain(item.correct)
        expect(fresh.response).not.toContain(item.wrong)
        const freshGrounding = (provider.mock.calls.at(-1)![0].system as Array<{ text: string }>)
          .map((block) => block.text)
          .join('')
        expect(freshGrounding).toContain(item.correct)
        expect(freshGrounding).not.toContain(item.wrong)
        const retrieved = await read(item.venueId, item.query)
        expect(retrieved.entries.map((entry) => entry.content)).toContain(item.correct)
        expect(retrieved.entries.map((entry) => entry.content)).not.toContain(item.wrong)
        const other = cases.find((entry) => entry.venueId !== item.venueId)!
        expect(freshGrounding).not.toContain(other.wrong)
        expect(freshGrounding).not.toContain(other.correct)
        const otherRead = await read(other.venueId, other.query)
        expect(otherRead.entries.map((entry) => entry.content)).not.toContain(item.correct)
      }

      const museum = cases[0]!
      const gallery = cases[1]!
      const additionToken = randomUUID()
      await send(
        museum.venueId,
        additionToken,
        `Oh! One thing I forgot to mention is that ${addedFact.toLowerCase()}`,
      )
      const additionSession = await db.visitorSession.findFirstOrThrow({
        where: { tenantId, venueId: museum.venueId, anonymousToken: additionToken },
        select: { id: true },
      })
      const additionTurn = await db.guestChatTurn.findFirstOrThrow({
        where: { tenantId, venueId: museum.venueId, sessionId: additionSession.id },
        select: { userMessageId: true },
      })
      const additionCandidate = await db.conversationInsight.findFirstOrThrow({
        where: {
          tenantId,
          venueId: museum.venueId,
          sessionId: additionSession.id,
          category: 'CONTENT_UPDATE_CANDIDATE',
        },
        select: {
          id: true,
          candidateRevision: true,
          candidateProvenance: true,
          evidenceMessageIds: true,
        },
      })
      expect(additionCandidate.candidateProvenance).toMatchObject({
        verification: 'UNVERIFIED',
        classifier: { kind: 'FACTUAL_ADDITION' },
      })
      expect(additionCandidate.evidenceMessageIds).toEqual([additionTurn.userMessageId])
      expect(
        (await read(museum.venueId, additionQuery)).entries.map((entry) => entry.content),
      ).not.toContain(addedFact)
      expect((await send(museum.venueId, randomUUID(), additionQuery)).response).not.toContain(
        addedFact,
      )
      await admin.reviewConversationLearningCandidate({
        tenantId,
        venueId: museum.venueId,
        operationId: randomUUID(),
        insightId: additionCandidate.id,
        expectedRevision: additionCandidate.candidateRevision,
        action: 'ACCEPT_FOR_PROPOSAL',
        reviewerFeedback: 'Checked the roof against the venue-approved source.',
      })
      const additionProposal = await admin.createKnowledgeProposal({
        operationId: randomUUID(),
        tenantId,
        venueId: museum.venueId,
        conversationInsightId: additionCandidate.id,
        observedVisitorClaim: addedFact,
        proposedChange: addedFact,
        reason: 'Reviewed fixture label confirms the roof material.',
        confidence: 1,
        evidenceMessageIds: [additionTurn.userMessageId!],
        submitForReview: true,
      })
      const additionPending = await db.knowledgeChangeProposal.findUniqueOrThrow({
        where: { id: additionProposal.id },
        select: { updatedAt: true },
      })
      await admin.reviewKnowledgeProposal({
        operationId: randomUUID(),
        tenantId,
        venueId: museum.venueId,
        proposalId: additionProposal.id,
        expectedUpdatedAt: additionPending.updatedAt.toISOString(),
        decision: 'APPROVED',
        reviewNote: 'Fixture source confirms the roof material.',
      })
      const additionApproved = await db.knowledgeChangeProposal.findUniqueOrThrow({
        where: { id: additionProposal.id },
        select: { updatedAt: true },
      })
      const additionDesired = {
        title: 'Case 12 house roof',
        category: 'POLICY',
        content: addedFact,
        isEnabled: true,
      }
      const additionPreview = await previewSemanticVenueUpdateFromProposal({
        db,
        tenantId,
        venueId: museum.venueId,
        proposalId: additionProposal.id,
        expectedUpdatedAt: additionApproved.updatedAt,
        relation: 'NEW_FACT',
        desired: additionDesired,
      })
      expect(additionPreview.classification).toBe('ADDITION')
      const additionDraft = await createSemanticUniversalContentDraftService({
        db,
        actorId: adminId,
        input: {
          tenantId,
          venueId: museum.venueId,
          proposalId: additionProposal.id,
          expectedProposalUpdatedAt: additionApproved.updatedAt.toISOString(),
          expectedPreviewHash: additionPreview.previewHash,
          relation: 'NEW_FACT',
          desired: additionDesired,
          draft: {
            audience: 'PUBLIC',
            evidence: [
              {
                sourceId: `fixture-reviewed-label:${museum.venueId}:roof`,
                locator: 'label',
                capturedAt: new Date().toISOString(),
                excerptHash: 'b'.repeat(64),
              },
            ],
            payload: {
              kind: 'POLICY',
              title: additionDesired.title,
              rule: addedFact,
              appliesTo: [],
            },
          },
        },
      })
      expect(
        (await read(museum.venueId, additionQuery)).entries.map((entry) => entry.content),
      ).not.toContain(addedFact)
      expect((await send(museum.venueId, randomUUID(), additionQuery)).response).not.toContain(
        addedFact,
      )
      await publishUniversalContentAction({
        db,
        tenantId,
        venueId: museum.venueId,
        moduleId: additionDraft.moduleId,
        revisionId: additionDraft.revisionId,
        expectedLatestVersion: 1,
        requestId: randomUUID(),
        actor,
      })
      const additionFresh = await send(museum.venueId, randomUUID(), additionQuery)
      expect(additionFresh.response).toContain(addedFact)
      const galleryFresh = await send(gallery.venueId, randomUUID(), gallery.query)
      expect(galleryFresh.response).toContain(gallery.correct)
      expect(galleryFresh.response).not.toContain(addedFact)
      expect(
        (await read(gallery.venueId, gallery.query)).entries.map((entry) => entry.content),
      ).not.toContain(addedFact)
    })
  })
})
