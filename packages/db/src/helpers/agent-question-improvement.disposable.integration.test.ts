import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareAgentImprovementProposalAction } from './agent-improvement-proposal-actions'
import { answerAgentQuestionAction, askAgentQuestionAction } from './agent-question-actions'
import { recordAgentOutcomeAction } from './agent-outcome-actions'
import { claimAgentRunExecution, completeAgentRunExecution } from './agent-run-execution-actions'
import { createAgentTaskAction } from './agent-task-actions'

const enabled =
  process.env.RUN_AGENT_QUESTION_IMPROVEMENT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_agent_question_improvement_[a-f0-9]{12}$/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('agent question improvement disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('retains two answered founder corrections as safe, scoped evidence for one generalized candidate', async () =>
    withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `tenant-question-improvement-${suffix}`
      const venueId = `venue-question-improvement-${suffix}`
      const wrongVenueId = `venue-question-improvement-wrong-${suffix}`
      const identityId = `identity-question-improvement-${suffix}`
      const wrongIdentityId = `identity-question-improvement-wrong-${suffix}`
      const actor = {
        type: 'HUMAN' as const,
        id: 'fixture-founder',
        role: 'PLATFORM_ADMIN' as const,
      }
      const taskActor = {
        actorType: 'HUMAN' as const,
        actorId: actor.id,
        auditRole: 'PLATFORM_ADMIN' as const,
      }

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic question improvement tenant', slug: tenantId },
      })
      await db.venue.create({
        data: {
          id: venueId,
          tenantId,
          name: 'Synthetic question improvement venue',
          slug: venueId,
        },
      })
      await db.venue.create({
        data: {
          id: wrongVenueId,
          tenantId,
          name: 'Synthetic wrong question improvement venue',
          slug: wrongVenueId,
        },
      })
      await Promise.all([
        db.agentIdentity.create({
          data: {
            id: identityId,
            tenantId,
            venueId,
            identityKey: `question-improvement.${suffix}`,
            name: 'Question improvement reviewer',
            agentType: 'QUALITY_REVIEW',
            accessScope: 'VENUE',
            autonomyLevel: 'READ_ONLY',
            enabled: true,
            createdBy: actor.id,
          },
        }),
        db.agentIdentity.create({
          data: {
            id: wrongIdentityId,
            tenantId,
            venueId,
            identityKey: `question-improvement-wrong.${suffix}`,
            name: 'Other question improvement reviewer',
            agentType: 'QUALITY_REVIEW',
            accessScope: 'VENUE',
            autonomyLevel: 'READ_ONLY',
            enabled: true,
            createdBy: actor.id,
          },
        }),
      ])

      const queueRun = async (agentIdentityId: string, venue = venueId, label = 'review') => {
        const queued = await createAgentTaskAction({
          operationId: randomUUID(),
          tenantId,
          venueId: venue,
          agentIdentityId,
          prompt: `Review synthetic repeated workflow evidence: ${label}.`,
          actor: taskActor,
        })
        return queued.run
      }
      const complete = async (runId: string) => {
        const claimed = await claimAgentRunExecution({ tenantId, runId })
        await expect(
          completeAgentRunExecution({
            tenantId,
            runId,
            leaseToken: claimed.leaseToken,
            summary: 'Synthetic terminal review completed without external effects.',
          }),
        ).resolves.toMatchObject({ status: 'COMPLETED' })
      }
      const createCorrection = async (
        label: string,
        answer: string,
        verdict: 'MIXED' | 'NEGATIVE',
      ) => {
        const run = await queueRun(identityId, venueId, label)
        const asked = await askAgentQuestionAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          agentRunId: run.id,
          question: `Which safe correction applies to repeated workflow ${label}?`,
          category: 'quality-correction',
          blocking: true,
        })
        await answerAgentQuestionAction({
          tenantId,
          venueId,
          questionId: asked.question.id,
          expectedUpdatedAt: asked.question.updatedAt,
          outcome: 'ANSWERED',
          answer,
          actor: taskActor,
        })
        const question = await db.agentQuestion.findUniqueOrThrow({
          where: { id: asked.question.id },
          select: { id: true, answer: true, answeredAt: true, updatedAt: true },
        })
        expect(question.answer).toBe(answer)
        expect(question.answeredAt).toBeInstanceOf(Date)
        await complete(run.id)
        const request = {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentRunId: run.id,
          verdict,
          summary: `Founder correction classified the ${label} workflow issue without copying the answer.`,
          evidenceRef: `fixture:question-correction:${label}`,
          sourceQuestion: { questionId: question.id, expectedUpdatedAt: question.updatedAt },
          actor,
        }
        const outcome = await recordAgentOutcomeAction(request)
        await expect(recordAgentOutcomeAction(request)).resolves.toMatchObject({
          id: outcome.id,
          replayed: true,
        })
        return { run, question, outcome, request }
      }

      const privateMarkerOne = `private-founder-correction-one-${suffix}`
      const privateMarkerTwo = `private-founder-correction-two-${suffix}`
      const rawAnswerOne = `When a reviewed source is missing, ask a clarification question; do not infer private opening hours. ${privateMarkerOne}`
      const rawAnswerTwo = `Distinguish reviewed source material from a draft before answering. ${privateMarkerTwo}`
      const first = await createCorrection('missing-source-a', rawAnswerOne, 'NEGATIVE')
      const second = await createCorrection('missing-source-b', rawAnswerTwo, 'MIXED')

      const counterexampleRun = await queueRun(identityId, venueId, 'counterexample')
      await complete(counterexampleRun.id)
      const counterexample = await recordAgentOutcomeAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentRunId: counterexampleRun.id,
        verdict: 'POSITIVE',
        summary: 'The same workflow already succeeded when a retained source was available.',
        evidenceRef: 'fixture:counterexample',
        actor,
      })

      const proposalBase = {
        tenantId,
        venueId,
        agentIdentityId: identityId,
        outcomeObservationIds: [second.outcome.id, counterexample.id, first.outcome.id],
        proposalKey: 'repeat-source-check',
        revision: 1,
        targetKind: 'WORKFLOW' as const,
        title: 'Require retained-source review for repeated corrections',
        hypothesis:
          'Two founder corrections show a recurring source-review issue in this workflow.',
        proposedChange:
          'Add a draft-only retained-source review step before returning this workflow result.',
        validationPlan: 'Compare a held-out fixture before any separate approval or activation.',
        actor,
      }
      const generalizationRationale =
        'Two accepted corrections show one bounded source-state rule: distinguish reviewed source from draft material and ask for clarification when reviewed evidence is missing.'
      const generalizationExclusions = [
        'Do not infer private opening hours.',
        'Do not treat draft material as reviewed source evidence.',
        'Do not generalize beyond source-state handling in this workflow.',
      ]
      await expect(
        prepareAgentImprovementProposalAction({ ...proposalBase, operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        prepareAgentImprovementProposalAction({
          ...proposalBase,
          operationId: randomUUID(),
          generalization: {
            rationale: generalizationRationale,
            counterexampleObservationIds: [counterexample.id],
            exclusions: [],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        prepareAgentImprovementProposalAction({
          ...proposalBase,
          operationId: randomUUID(),
          generalization: {
            rationale: generalizationRationale,
            counterexampleObservationIds: [first.outcome.id],
            exclusions: generalizationExclusions,
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        prepareAgentImprovementProposalAction({
          ...proposalBase,
          operationId: randomUUID(),
          outcomeObservationIds: [second.outcome.id, first.outcome.id],
          generalization: {
            rationale: generalizationRationale,
            counterexampleObservationIds: [counterexample.id],
            exclusions: generalizationExclusions,
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

      const proposalRequest = {
        ...proposalBase,
        operationId: randomUUID(),
        generalization: {
          rationale: generalizationRationale,
          counterexampleObservationIds: [counterexample.id],
          exclusions: generalizationExclusions,
        },
      }
      const proposal = await prepareAgentImprovementProposalAction(proposalRequest)
      await expect(prepareAgentImprovementProposalAction(proposalRequest)).resolves.toMatchObject({
        id: proposal.id,
        replayed: true,
      })

      const expectedSources = [first, second]
        .map(({ outcome, question }) => ({
          outcomeObservationId: outcome.id,
          questionId: question.id,
          questionUpdatedAt: question.updatedAt.toISOString(),
          answeredAt: question.answeredAt!.toISOString(),
          answerSha256: createHash('sha256').update(question.answer!, 'utf8').digest('hex'),
        }))
        .sort((left, right) => left.outcomeObservationId.localeCompare(right.outcomeObservationId))
      expect(proposal.baselineSnapshot).toMatchObject({
        observationCount: 3,
        verdictCounts: { POSITIVE: 1, MIXED: 1, NEGATIVE: 1, INCONCLUSIVE: 0 },
        generalization: {
          rationale: proposalRequest.generalization.rationale,
          counterexampleObservationIds: [counterexample.id],
          exclusions: proposalRequest.generalization.exclusions,
        },
        questionSources: expectedSources,
      })

      await expect(
        recordAgentOutcomeAction({
          ...first.request,
          operationId: randomUUID(),
          sourceQuestion: {
            questionId: first.question.id,
            expectedUpdatedAt: new Date(first.question.updatedAt.getTime() - 1),
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const wrongIdentityRun = await queueRun(wrongIdentityId, venueId, 'wrong-identity')
      await complete(wrongIdentityRun.id)
      await expect(
        recordAgentOutcomeAction({
          ...first.request,
          operationId: randomUUID(),
          agentRunId: wrongIdentityRun.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const wrongVenueIdentityId = `identity-question-improvement-wrong-venue-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: wrongVenueIdentityId,
          tenantId,
          venueId: wrongVenueId,
          identityKey: `question-improvement-wrong-venue.${suffix}`,
          name: 'Wrong venue reviewer',
          agentType: 'QUALITY_REVIEW',
          accessScope: 'VENUE',
          autonomyLevel: 'READ_ONLY',
          enabled: true,
          createdBy: actor.id,
        },
      })
      const wrongVenueRun = await queueRun(wrongVenueIdentityId, wrongVenueId, 'wrong-venue')
      await complete(wrongVenueRun.id)
      await expect(
        recordAgentOutcomeAction({
          ...first.request,
          operationId: randomUUID(),
          venueId: wrongVenueId,
          agentRunId: wrongVenueRun.id,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const unansweredRun = await queueRun(identityId, venueId, 'unanswered')
      const unanswered = await askAgentQuestionAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        agentRunId: unansweredRun.id,
        question: 'Remain unanswered for the source guard.',
        category: 'quality-correction',
        blocking: false,
      })
      await complete(unansweredRun.id)
      await expect(
        recordAgentOutcomeAction({
          ...first.request,
          operationId: randomUUID(),
          agentRunId: unansweredRun.id,
          sourceQuestion: {
            questionId: unanswered.question.id,
            expectedUpdatedAt: unanswered.question.updatedAt,
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const directSource = {
        sourceQuestionId: first.question.id,
        sourceQuestionUpdatedAt: first.question.updatedAt,
        sourceAnsweredAt: first.question.answeredAt!,
        sourceAnswerSha256: createHash('sha256')
          .update(first.question.answer!, 'utf8')
          .digest('hex'),
      }
      const directBase = (operationId: string) => ({
        operationId,
        tenantId,
        venueId,
        agentRunId: first.run.id,
        agentIdentityId: identityId,
        signalKind: 'HUMAN_REVIEW' as const,
        verdict: 'NEGATIVE' as const,
        summary: 'Direct fixture guard check.',
        evidenceRef: 'fixture:direct-guard',
        taskClass: 'QUALITY_REVIEW',
        actorType: 'HUMAN' as const,
        actorId: actor.id,
      })
      const expectDatabaseConstraint = async (operation: Promise<unknown>, constraint: string) => {
        const error = await operation.then(
          () => new Error(`Expected database constraint ${constraint} to reject the fixture row.`),
          (reason: unknown) => reason,
        )
        const detail = JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          meta:
            error && typeof error === 'object' && 'meta' in error
              ? (error as { meta?: unknown }).meta
              : undefined,
        })
        expect(detail).toContain(constraint)
      }
      const outcomeCount = await db.agentOutcomeObservation.count({ where: { tenantId, venueId } })
      await expect(
        db.$transaction(async (transaction) => {
          const valid = await transaction.agentOutcomeObservation.create({
            data: { ...directBase(randomUUID()), ...directSource },
            select: {
              sourceQuestionId: true,
              sourceQuestionUpdatedAt: true,
              sourceAnsweredAt: true,
              sourceAnswerSha256: true,
            },
          })
          expect(valid).toEqual(directSource)
          throw new Error('intentional fixture rollback after valid source provenance control')
        }),
      ).rejects.toThrow('intentional fixture rollback')
      for (const partial of [
        { sourceQuestionId: null },
        { sourceQuestionUpdatedAt: null },
        { sourceAnsweredAt: null },
        { sourceAnswerSha256: null },
        { sourceAnswerSha256: 'g'.repeat(64) },
      ]) {
        await expectDatabaseConstraint(
          db.$transaction((transaction) =>
            transaction.agentOutcomeObservation.create({
              data: { ...directBase(randomUUID()), ...directSource, ...partial },
            }),
          ),
          'agent_outcome_observations_source_question_provenance_check',
        )
      }
      await expectDatabaseConstraint(
        db.$transaction((transaction) =>
          transaction.agentOutcomeObservation.create({
            data: {
              ...directBase(randomUUID()),
              ...directSource,
              venueId: wrongVenueId,
              agentRunId: wrongVenueRun.id,
              agentIdentityId: wrongVenueIdentityId,
            },
          }),
        ),
        'agent_outcome_observations_source_question_scope_fkey',
      )
      expect(await db.agentOutcomeObservation.count({ where: { tenantId, venueId } })).toBe(
        outcomeCount,
      )

      const [safeOutcomes, storedProposal, audit] = await Promise.all([
        db.agentOutcomeObservation.findMany({
          where: { id: { in: [first.outcome.id, second.outcome.id] }, tenantId, venueId },
          select: {
            sourceQuestionId: true,
            sourceQuestionUpdatedAt: true,
            sourceAnsweredAt: true,
            sourceAnswerSha256: true,
            summary: true,
            evidenceRef: true,
          },
        }),
        db.agentImprovementProposal.findUniqueOrThrow({
          where: { id: proposal.id },
          select: {
            baselineSnapshot: true,
            hypothesis: true,
            proposedChange: true,
            validationPlan: true,
          },
        }),
        db.auditLog.findMany({
          where: {
            tenantId,
            action: { in: ['agent-outcome.observed', 'agent-improvement.proposal-prepared'] },
          },
          select: { sourceReferences: true, beforeState: true, afterState: true },
        }),
      ])
      const safeProjection = JSON.stringify({ safeOutcomes, storedProposal, audit })
      expect(safeProjection).not.toContain(rawAnswerOne)
      expect(safeProjection).not.toContain(rawAnswerTwo)
      expect(safeProjection).not.toContain(privateMarkerOne)
      expect(safeProjection).not.toContain(privateMarkerTwo)
      expect(safeProjection).toContain(expectedSources[0]!.answerSha256)
      expect(safeProjection).toContain(expectedSources[1]!.answerSha256)
      expect(
        await db.agentQuestion.findMany({
          where: { id: { in: [first.question.id, second.question.id] } },
          select: { answer: true },
        }),
      ).toEqual(expect.arrayContaining([{ answer: rawAnswerOne }, { answer: rawAnswerTwo }]))
    }))
})
