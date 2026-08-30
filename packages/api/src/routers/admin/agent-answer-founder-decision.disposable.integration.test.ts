import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db, getFounderDecisionCurrentTruth, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminAgentQuestionsRouter } from './agent-questions'

const enabled =
  process.env.RUN_FOUNDER_DECISION_PACKET_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('answered founder question promotion disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('promotes, replays, supersedes, and preserves exact answer provenance', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-founder-answer-${suffix}`
      const venueId = `venue-founder-answer-${suffix}`
      const identityId = `identity-founder-answer-${suffix}`
      const operatorId = `operator-founder-answer-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic founder-answer tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic founder-answer venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `founder.answer.${suffix}`,
          name: 'Synthetic founder-question agent',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          enabled: true,
          createdBy: operatorId,
        },
      })
      const firstAnsweredAt = new Date('2026-08-22T18:30:00.000Z')
      const firstQuestion = await db.agentQuestion.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          question: 'Should routine support wait for founder approval?',
          status: 'ANSWERED',
          answer: 'Routine support may proceed autonomously when policy permits it.',
          answeredById: operatorId,
          answeredAt: firstAnsweredAt,
        },
      })
      const context: TRPCContext = {
        db,
        headers: new Headers(),
        session: {
          userId: operatorId,
          activeTenantId: null,
          role: null,
          isPlatformAdmin: true,
        },
      }
      const caller = router({ questions: adminAgentQuestionsRouter }).createCaller(context)
      const input = {
        tenantId,
        venueId,
        questionId: firstQuestion.id,
        decisionKey: 'routine-support-authority',
        title: 'Routine support authority',
        summary: 'Routine support does not require founder review when policy permits it.',
        rationale: 'Founder judgment should remain focused on consequential exceptions.',
        affectedSystems: ['support', 'agent-policy'],
        scope: { appliesTo: 'torchiko-operations' },
      }

      await expect(
        caller.questions.promoteAgentAnswerToFounderDecision(input),
      ).resolves.toMatchObject({
        state: 'APPLIED',
        source: { questionId: firstQuestion.id, answeredById: operatorId },
      })
      await expect(
        caller.questions.promoteAgentAnswerToFounderDecision(input),
      ).resolves.toMatchObject({ state: 'REPLAYED_CURRENT' })

      const secondAnsweredAt = new Date('2026-08-23T18:30:00.000Z')
      const secondQuestion = await db.agentQuestion.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          question: 'Should routine support remain autonomous after review?',
          status: 'ANSWERED',
          answer: 'Routine support should remain autonomous, with material exceptions escalated.',
          answeredById: operatorId,
          answeredAt: secondAnsweredAt,
        },
      })
      const superseding = await caller.questions.promoteAgentAnswerToFounderDecision({
        ...input,
        questionId: secondQuestion.id,
        summary: 'Routine support remains autonomous while material exceptions escalate.',
      })
      expect(superseding).toMatchObject({
        state: 'APPLIED',
        supersededKnowledgeItemId: expect.any(String),
      })

      const current = await getFounderDecisionCurrentTruth({
        keys: ['routine-support-authority'],
      })
      expect(current.complete).toBe(true)
      expect(current.decisions[0]).toMatchObject({
        key: 'routine-support-authority',
        decision: 'Routine support should remain autonomous, with material exceptions escalated.',
        effectiveAt: secondAnsweredAt.toISOString(),
        provenance: [
          expect.objectContaining({
            sourceType: 'HUMAN_ENTRY',
            sourceRef: `agent-question:${secondQuestion.id}`,
          }),
        ],
        supersedesDecisionId: expect.any(String),
      })
      expect(
        await db.companyKnowledgeItem.count({
          where: {
            type: 'DECISION',
            entityLinks: {
              some: {
                entityType: 'FOUNDER_DECISION_KEY',
                entityId: 'routine-support-authority',
                relationship: 'GOVERNS',
              },
            },
          },
        }),
      ).toBe(2)
    })
  })
})
