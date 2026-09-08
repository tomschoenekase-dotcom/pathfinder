import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  askAgentQuestionAction,
  db,
  expireAgentQuestionIfDue,
  withTenantIsolationBypass,
} from './index'

const confirmation = 'pathfinder_disposable_agent_question_dedup'
const databaseUrl = process.env.DATABASE_URL ?? ''
const directDatabaseUrl = process.env.DIRECT_DATABASE_URL ?? ''

function isApprovedDisposableDatabase(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      url.port === '55489' &&
      url.search === '' &&
      /^\/pathfinder_disposable_agent_question_dedup_[a-f0-9]{12}$/u.test(url.pathname)
    )
  } catch {
    return false
  }
}

const enabled =
  process.env.RUN_AGENT_QUESTION_DEDUP_DB_INTEGRATION === '1' &&
  process.env.PATHFINDER_DISPOSABLE_AGENT_QUESTION_DEDUP_CONFIRMATION === confirmation &&
  databaseUrl === directDatabaseUrl &&
  isApprovedDisposableDatabase(databaseUrl)

describe.skipIf(!enabled)(
  'agent question exact active-workflow dedup disposable persistence',
  () => {
    afterAll(async () => db.$disconnect(), 30_000)

    it(
      'retains operation aliases only for exact pending questions in the same non-null run',
      async () =>
        withTenantIsolationBypass(async () => {
          const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
          const tenantId = 'tenant-question-dedup-' + suffix
          const venueId = 'venue-question-dedup-' + suffix
          const otherVenueId = 'venue-question-dedup-other-' + suffix
          const foreignTenantId = 'tenant-question-dedup-foreign-' + suffix
          const foreignVenueId = 'venue-question-dedup-foreign-' + suffix
          const identityId = 'identity-question-dedup-' + suffix
          const otherIdentityId = 'identity-question-dedup-other-' + suffix
          const operatorId = 'operator-question-dedup-' + suffix
          const scope = { tenantId, venueId }

          await db.tenant.create({
            data: { id: tenantId, name: 'Synthetic question dedup tenant', slug: tenantId },
          })
          await db.tenant.create({
            data: {
              id: foreignTenantId,
              name: 'Synthetic question dedup foreign tenant',
              slug: foreignTenantId,
            },
          })
          await Promise.all([
            db.venue.create({
              data: {
                id: venueId,
                tenantId,
                name: 'Synthetic question dedup venue',
                slug: venueId,
              },
            }),
            db.venue.create({
              data: {
                id: foreignVenueId,
                tenantId: foreignTenantId,
                name: 'Synthetic question dedup foreign venue',
                slug: foreignVenueId,
              },
            }),
            db.venue.create({
              data: {
                id: otherVenueId,
                tenantId,
                name: 'Synthetic question dedup other venue',
                slug: otherVenueId,
              },
            }),
          ])
          await Promise.all([
            db.agentIdentity.create({
              data: {
                id: identityId,
                ...scope,
                identityKey: 'question.dedup.' + suffix,
                name: 'Synthetic dedup operator',
                agentType: 'OPERATIONS',
                accessScope: 'VENUE',
                autonomyLevel: 'READ_ONLY',
                enabled: true,
                createdBy: operatorId,
              },
            }),
            db.agentIdentity.create({
              data: {
                id: otherIdentityId,
                tenantId,
                venueId: otherVenueId,
                identityKey: 'question.dedup.other.' + suffix,
                name: 'Synthetic other dedup operator',
                agentType: 'OPERATIONS',
                accessScope: 'VENUE',
                autonomyLevel: 'READ_ONLY',
                enabled: true,
                createdBy: operatorId,
              },
            }),
          ])

          const createRun = (
            label: string,
            { venue = venueId, identity = identityId }: { venue?: string; identity?: string } = {},
          ) =>
            db.agentRun.create({
              data: {
                id: 'run-question-dedup-' + label + '-' + suffix,
                operationId: randomUUID(),
                tenantId,
                venueId: venue,
                agentIdentityId: identity,
                runType: 'QUESTION_DEDUP_FIXTURE',
                requestedOperation: 'question-dedup.fixture',
                scopeSnapshot: { authority: 'none' },
                status: 'RUNNING',
                startedAt: new Date(),
                initiatedByType: 'HUMAN',
                initiatedById: operatorId,
              },
            })
          const [run, otherRun, unrelatedRun, otherVenueRun] = await Promise.all([
            createRun('canonical'),
            createRun('other'),
            createRun('unrelated'),
            createRun('other-venue', { venue: otherVenueId, identity: otherIdentityId }),
          ])

          const legacyCreatedAt = new Date('2026-09-08T18:00:00.000Z')
          const legacyOperationId = randomUUID()
          const legacy = await db.agentQuestion.create({
            data: {
              id: 'question-question-dedup-legacy-' + suffix,
              operationId: legacyOperationId,
              ...scope,
              agentIdentityId: identityId,
              question: 'Which source applies to the legacy synthetic question?',
              context: null,
              questionType: 'SHORT_TEXT',
              category: 'synthetic-dedup',
              urgency: 'NORMAL',
              choices: [],
              evidence: [],
              blocking: false,
              status: 'PENDING',
              createdAt: legacyCreatedAt,
            },
            select: { id: true, operationId: true, createdAt: true },
          })
          expect(
            await db.agentQuestionOperation.count({
              where: { tenantId, operationId: legacyOperationId },
            }),
          ).toBe(0)
          const migrationSql = await readFile(
            new URL(
              '../prisma/migrations/20260908160000_add_agent_question_operations/migration.sql',
              import.meta.url,
            ),
            'utf8',
          )
          const backfillStart = migrationSql.lastIndexOf('INSERT INTO')
          const backfillEnd = migrationSql.indexOf(';', backfillStart)
          const exactBackfillStatement =
            backfillStart >= 0 && backfillEnd > backfillStart
              ? migrationSql.slice(backfillStart, backfillEnd + 1)
              : null
          expect(exactBackfillStatement).not.toBeNull()
          // This replays the migration's retained final statement only; it is not a full 235-to-236 upgrade.
          await db.$executeRawUnsafe(exactBackfillStatement as string)
          expect(
            await db.agentQuestionOperation.findUnique({
              where: { tenantId_operationId: { tenantId, operationId: legacyOperationId } },
              select: { questionId: true, venueId: true, createdAt: true },
            }),
          ).toEqual({ questionId: legacy.id, venueId, createdAt: legacy.createdAt })

          const questionInput = (
            operationId: string,
            overrides: Partial<Parameters<typeof askAgentQuestionAction>[0]> = {},
          ) => ({
            operationId,
            tenantId,
            venueId,
            agentIdentityId: identityId,
            agentRunId: run.id,
            question: 'Which retained source should guide the synthetic visitor directions?',
            context: 'Use only the reviewed source attached to this run.',
            questionType: 'SHORT_TEXT' as const,
            category: 'synthetic-dedup',
            urgency: 'NORMAL' as const,
            choices: [],
            evidence: [
              {
                label: 'Synthetic reviewed source',
                reference: 'fixture:reviewed-source:' + suffix,
                summary: 'The source identifies the accessible entrance.',
              },
            ],
            callbackMetadata: { workflow: 'synthetic-question-dedup' },
            blocking: true,
            ...overrides,
          })

          const firstOperationId = randomUUID()
          const secondOperationId = randomUUID()
          const [first, second] = await Promise.all([
            askAgentQuestionAction(questionInput(firstOperationId)),
            askAgentQuestionAction(questionInput(secondOperationId)),
          ])
          expect(first.question.id).toBe(second.question.id)
          expect([first.replayed, second.replayed]).toEqual([false, false])
          expect([first.consolidated, second.consolidated].sort()).toEqual([false, true])

          const canonicalId = first.question.id
          expect(
            await db.agentQuestion.count({
              where: { tenantId, venueId, agentRunId: run.id },
            }),
          ).toBe(1)
          const aliases = await db.agentQuestionOperation.findMany({
            where: { tenantId, venueId, questionId: canonicalId },
            orderBy: { operationId: 'asc' },
            select: { operationId: true, questionId: true, venueId: true },
          })
          expect(aliases).toEqual(
            expect.arrayContaining([
              { operationId: firstOperationId, questionId: canonicalId, venueId },
              { operationId: secondOperationId, questionId: canonicalId, venueId },
            ]),
          )
          expect(aliases).toHaveLength(2)
          await expect(
            db.agentTimelineEvent.count({
              where: { tenantId, venueId, agentRunId: run.id, eventType: 'QUESTION_ASKED' },
            }),
          ).resolves.toBe(1)
          await expect(
            db.agentMessage.count({
              where: {
                tenantId,
                venueId,
                agentRunId: run.id,
                role: 'AGENT',
                messageType: 'STATUS',
                content: questionInput(firstOperationId).question,
              },
            }),
          ).resolves.toBe(1)
          await expect(
            db.auditLog.count({
              where: {
                tenantId,
                action: 'agent-question.consolidated',
                targetId: canonicalId,
              },
            }),
          ).resolves.toBe(1)
          await expect(
            db.agentQuestionOperation.create({
              data: {
                tenantId,
                venueId: otherVenueId,
                operationId: randomUUID(),
                questionId: canonicalId,
              },
            }),
          ).rejects.toMatchObject({ code: 'P2003' })
          await expect(
            db.agentQuestionOperation.create({
              data: {
                tenantId: foreignTenantId,
                venueId: foreignVenueId,
                operationId: randomUUID(),
                questionId: canonicalId,
              },
            }),
          ).rejects.toMatchObject({ code: 'P2003' })

          const [changedEvidence, changedCallback, changedType, differentRun, differentVenue] =
            await Promise.all([
              askAgentQuestionAction(
                questionInput(randomUUID(), {
                  evidence: [
                    {
                      label: 'Different synthetic source',
                      reference: 'fixture:different-source:' + suffix,
                      summary: 'This evidence is intentionally distinct.',
                    },
                  ],
                }),
              ),
              askAgentQuestionAction(
                questionInput(randomUUID(), {
                  callbackMetadata: { workflow: 'synthetic-question-dedup', mode: 'different' },
                }),
              ),
              askAgentQuestionAction(questionInput(randomUUID(), { questionType: 'LONG_TEXT' })),
              askAgentQuestionAction(questionInput(randomUUID(), { agentRunId: otherRun.id })),
              askAgentQuestionAction(
                questionInput(randomUUID(), {
                  venueId: otherVenueId,
                  agentIdentityId: otherIdentityId,
                  agentRunId: otherVenueRun.id,
                }),
              ),
            ])
          for (const separate of [
            changedEvidence,
            changedCallback,
            changedType,
            differentRun,
            differentVenue,
          ])
            expect(separate.question.id).not.toBe(canonicalId)
          for (const separate of [
            changedEvidence,
            changedCallback,
            changedType,
            differentRun,
            differentVenue,
          ])
            expect(separate).toMatchObject({ replayed: false, consolidated: false })
          await expect(
            db.$executeRaw`
            UPDATE "agent_question_operations"
            SET "question_id" = ${changedEvidence.question.id}
            WHERE "tenant_id" = ${tenantId}
              AND "operation_id" = ${firstOperationId}::uuid
          `,
          ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })
          await expect(
            db.$executeRaw`
            DELETE FROM "agent_question_operations"
            WHERE "tenant_id" = ${tenantId}
              AND "operation_id" = ${firstOperationId}::uuid
          `,
          ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '55000' }) })
          await expect(db.$executeRaw`TRUNCATE "agent_question_operations"`).rejects.toMatchObject({
            meta: expect.objectContaining({ code: '55000' }),
          })
          await expect(
            db.agentQuestionOperation.findUnique({
              where: { tenantId_operationId: { tenantId, operationId: firstOperationId } },
              select: { questionId: true, venueId: true },
            }),
          ).resolves.toEqual({ questionId: canonicalId, venueId })

          const runlessOne = await askAgentQuestionAction(
            questionInput(randomUUID(), { agentRunId: undefined }),
          )
          const runlessTwo = await askAgentQuestionAction(
            questionInput(randomUUID(), { agentRunId: undefined }),
          )
          expect(runlessOne.question.id).not.toBe(runlessTwo.question.id)
          expect(runlessOne).toMatchObject({ replayed: false, consolidated: false })
          expect(runlessTwo).toMatchObject({ replayed: false, consolidated: false })

          const canonicalBeforeAnswer = await db.agentQuestion.findUniqueOrThrow({
            where: { id: canonicalId },
            select: { id: true, updatedAt: true, status: true },
          })
          await expect(
            answerAgentQuestionAction({
              ...scope,
              questionId: canonicalBeforeAnswer.id,
              expectedUpdatedAt: canonicalBeforeAnswer.updatedAt,
              outcome: 'ANSWERED',
              answer: 'Use the verified accessible entrance.',
              actor: {
                actorType: 'HUMAN',
                actorId: operatorId,
                auditRole: 'PLATFORM_ADMIN',
              },
            }),
          ).resolves.toMatchObject({ replayed: false })

          const [answeredReplayOne, answeredReplayTwo] = await Promise.all([
            askAgentQuestionAction(questionInput(firstOperationId)),
            askAgentQuestionAction(questionInput(secondOperationId)),
          ])
          expect(answeredReplayOne).toMatchObject({
            replayed: true,
            consolidated: false,
            question: { id: canonicalId },
          })
          expect(answeredReplayTwo).toMatchObject({
            replayed: true,
            consolidated: false,
            question: { id: canonicalId },
          })
          await expect(
            askAgentQuestionAction(
              questionInput(firstOperationId, {
                question: 'Changed text for an existing operation.',
              }),
            ),
          ).rejects.toMatchObject({ code: 'CONFLICT' })

          const afterAnswered = await askAgentQuestionAction(questionInput(randomUUID()))
          expect(afterAnswered.question.id).not.toBe(canonicalId)
          expect(afterAnswered).toMatchObject({
            replayed: false,
            consolidated: false,
            question: { status: 'PENDING' },
          })

          const expiringInput = questionInput(randomUUID(), {
            question: 'Which source applies to the expired synthetic review?',
            expiresAt: new Date(Date.now() - 1_000),
          })
          const expiring = await askAgentQuestionAction(expiringInput)
          const expiringWhilePending = await askAgentQuestionAction({
            ...expiringInput,
            operationId: randomUUID(),
          })
          expect(expiringWhilePending).toMatchObject({
            replayed: false,
            consolidated: false,
            question: { status: 'PENDING' },
          })
          expect(expiringWhilePending.question.id).not.toBe(expiring.question.id)
          await expect(
            db.$transaction((transaction) =>
              expireAgentQuestionIfDue(transaction, {
                ...scope,
                questionId: expiring.question.id,
              }),
            ),
          ).resolves.toBe('EXPIRED')
          const afterExpired = await askAgentQuestionAction({
            ...expiringInput,
            operationId: randomUUID(),
          })
          expect(afterExpired.question.id).not.toBe(expiring.question.id)
          expect(afterExpired).toMatchObject({
            replayed: false,
            consolidated: false,
            question: { status: 'PENDING' },
          })

          expect(
            await db.agentRun.findUniqueOrThrow({
              where: { id: unrelatedRun.id },
              select: { status: true },
            }),
          ).toEqual({ status: 'RUNNING' })
          expect(await db.approvalGrant.count({ where: { tenantId } })).toBe(0)

          expect(await db.agentQuestion.count({ where: { tenantId } })).toBe(13)
          expect(await db.agentQuestionOperation.count({ where: { tenantId } })).toBe(14)
        }),
      90_000,
    )
  },
)
