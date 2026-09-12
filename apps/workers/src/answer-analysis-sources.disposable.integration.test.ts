import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import { GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256 } from '@pathfinder/config/guest-conversation-disposition-policy'
import {
  db,
  recordGuestConversationDispositionAuthorization,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { loadAnswerAnalysisSources } from './processors/answer-analysis'
import { loadWeeklyReportSources } from './processors/weekly-report'

const enabled =
  process.env.RUN_NATIVE_ANSWER_ANALYSIS_SOURCES_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_answer_analysis_sources_[a-f0-9]{12}$/u.test(
    process.env.DATABASE_URL ?? '',
  )
const dispositionEnabled =
  process.env.RUN_GUEST_CONVERSATION_READER_DB_INTEGRATION === '1' &&
  /^postgresql:\/\/[^@]+@127\.0\.0\.1:51324\/pathfinder_disposable_guest_lifecycle_[a-f0-9]{12}(?:\?|$)/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('native visitor-report source boundaries', () => {
  afterAll(async () => db.$disconnect())

  it('includes ordinary public opinions once while excluding private, sibling, assistant and out-of-range sources', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `report-tenant-${suffix}`
      const foreignTenantId = `report-foreign-${suffix}`
      const venueId = `report-venue-${suffix}`
      const siblingVenueId = `report-sibling-${suffix}`
      const foreignVenueId = `report-foreign-venue-${suffix}`
      const at = new Date('2026-09-08T12:00:00.000Z')
      await db.tenant.createMany({
        data: [tenantId, foreignTenantId].map((id) => ({ id, name: id, slug: id })),
      })
      await db.venue.createMany({
        data: [
          { id: venueId, tenantId, name: 'Public report fixture', slug: venueId },
          { id: siblingVenueId, tenantId, name: 'Sibling report fixture', slug: siblingVenueId },
          {
            id: foreignVenueId,
            tenantId: foreignTenantId,
            name: 'Foreign report fixture',
            slug: foreignVenueId,
          },
        ],
      })
      async function seed(
        scope: { tenantId: string; venueId: string },
        experienceScope: string,
        label: string,
        isAiInvented = true,
      ) {
        const session = await db.visitorSession.create({
          data: { ...scope, anonymousToken: randomUUID(), experienceScope },
        })
        const turnId = randomUUID()
        await db.guestChatTurn.create({
          data: {
            id: turnId,
            ...scope,
            sessionId: session.id,
            requestId: randomUUID(),
            requestHash: 'a'.repeat(64),
            turnSequence: 0,
            userMessageSequence: 1,
            assistantMessageSequence: 2,
          },
        })
        const asked = await db.message.create({
          data: {
            ...scope,
            sessionId: session.id,
            sessionSequence: 0,
            role: 'assistant',
            content: `${label} assistant excluded`,
            createdAt: at,
          },
        })
        const answered = await db.message.create({
          data: {
            ...scope,
            sessionId: session.id,
            guestChatTurnId: turnId,
            sessionSequence: 1,
            role: 'user',
            content: `${label} structured answer`,
            createdAt: at,
          },
        })
        await db.engagementQuestionResponse.create({
          data: {
            ...scope,
            sessionId: session.id,
            guestChatTurnId: turnId,
            askedMessageId: asked.id,
            answerMessageId: answered.id,
            isAiInvented,
            questionText: 'What did you notice?',
            answerType: 'OPEN_ENDED',
            answerText: answered.content,
            askedAt: at,
            answeredAt: at,
          },
        })
        await db.message.create({
          data: {
            ...scope,
            sessionId: session.id,
            sessionSequence: 3,
            role: 'user',
            content: `${label} ordinary opinion`,
            createdAt: at,
          },
        })
        return session.id
      }
      const primary = { tenantId, venueId }
      const publicSessionId = await seed(primary, 'PUBLIC', 'public')
      const privateSessionId = await seed(primary, 'SECOND_LAYER', 'private')
      await seed({ tenantId, venueId: siblingVenueId }, 'PUBLIC', 'sibling')
      await seed({ tenantId: foreignTenantId, venueId: foreignVenueId }, 'PUBLIC', 'foreign')
      await db.message.createMany({
        data: [
          {
            ...primary,
            sessionId: publicSessionId,
            sessionSequence: 4,
            role: 'user',
            content: 'The display is ugly.',
            createdAt: at,
          },
          {
            ...primary,
            sessionId: publicSessionId,
            sessionSequence: 5,
            role: 'user',
            content: 'outside report date',
            createdAt: new Date('2026-09-01T12:00:00.000Z'),
          },
        ],
      })
      const payload = {
        ...primary,
        snapshotId: 'read-only-source-proof',
        rangeStart: '2026-09-08T00:00:00.000Z',
        rangeEnd: '2026-09-09T00:00:00.000Z',
      }
      const sources = await loadAnswerAnalysisSources(payload)
      expect(sources.generalMessages.sort()).toEqual(
        ['The display is ugly.', 'public ordinary opinion'].sort(),
      )
      expect(sources.responses.map((row) => row.answerText)).toEqual(['public structured answer'])
      expect(JSON.stringify(sources)).not.toMatch(
        /private|sibling|foreign|assistant excluded|outside report date/u,
      )
      const sibling = await loadAnswerAnalysisSources({ ...payload, venueId: siblingVenueId })
      expect(sibling.generalMessages).toEqual(['sibling ordinary opinion'])
      expect(sibling.responses.map((row) => row.answerText)).toEqual(['sibling structured answer'])
      const foreign = await loadAnswerAnalysisSources({
        ...payload,
        tenantId: foreignTenantId,
        venueId: foreignVenueId,
      })
      expect(foreign.generalMessages).toEqual(['foreign ordinary opinion'])
      expect(foreign.responses.map((row) => row.answerText)).toEqual(['foreign structured answer'])
      // Positive control: these exact rows become eligible if this synthetic session is public.
      await db.visitorSession.update({
        where: { id: privateSessionId },
        data: { experienceScope: 'PUBLIC' },
      })
      const exposed = await loadAnswerAnalysisSources(payload)
      expect(exposed.generalMessages).toContain('private ordinary opinion')
      expect(exposed.responses.map((row) => row.answerText)).toContain('private structured answer')
      await db.visitorSession.update({
        where: { id: privateSessionId },
        data: { experienceScope: 'SECOND_LAYER' },
      })
      expect(await loadAnswerAnalysisSources(payload)).toEqual({
        ...sources,
        generalMessages: expect.arrayContaining(sources.generalMessages),
      })
      const finalSources = await loadAnswerAnalysisSources(payload)
      expect(finalSources.generalMessages).toHaveLength(2)
      expect(finalSources.responses).toHaveLength(1)
      expect(await db.answerAnalysisSnapshot.count()).toBe(0)
      const weeklyPayload = {
        ...primary,
        reportId: 'read-only-weekly-proof',
        weekStart: payload.rangeStart,
        weekEnd: payload.rangeEnd,
      }
      const invented = await loadWeeklyReportSources(weeklyPayload)
      expect(invented.responses).toHaveLength(0)
      expect(invented.generalMessages.map((row) => row.excerpt)).toContain(
        'public structured answer',
      )
      // Engagement responses are immutable: create a distinct configured answer, never rewrite provenance.
      await seed(primary, 'PUBLIC', 'configured', false)
      const configured = await loadWeeklyReportSources(weeklyPayload)
      expect(configured.responses.map((row) => row.answerText)).toEqual([
        'configured structured answer',
      ])
      expect(configured.generalMessages.map((row) => row.excerpt).sort()).toEqual(
        [
          'The display is ugly.',
          'public ordinary opinion',
          'public structured answer',
          'configured ordinary opinion',
        ].sort(),
      )
      expect(JSON.stringify(configured)).not.toMatch(
        /private|sibling|foreign|assistant excluded|outside report date/u,
      )
      const output = process.env.PATHFINDER_DISPOSABLE_PROOF_OUTPUT
      if (output)
        writeFileSync(
          output,
          JSON.stringify(
            {
              publicOrdinaryCount: 2,
              publicStructuredCount: 1,
              noStructuredDoubleCount: true,
              weeklyInventedAnswerRetained: true,
              weeklyConfiguredAnswerCountedOnce: true,
              privateScopePositiveControl: true,
              siblingAndForeignPositiveControls: true,
              noProviderOrSnapshotWrite: true,
              seededSessionId: publicSessionId,
            },
            null,
            2,
          ),
        )
    })
  })
})

describe.skipIf(!dispositionEnabled)('disposed native visitor-report source boundaries', () => {
  afterAll(async () => db.$disconnect())

  it('excludes authentically disposed prose while preserving structural weekly counts', async () => {
    const rawUrl = process.env.DATABASE_URL ?? ''
    const parsed = new URL(rawUrl)
    const database = parsed.pathname.slice(1)
    function client(user: string, name = database) {
      const url = new URL(rawUrl)
      url.username = user
      url.pathname = `/${name}`
      url.searchParams.set('connection_limit', '1')
      return new PrismaClient({ datasourceUrl: url.toString() })
    }

    const control = client('guest_maintenance', 'postgres')
    const admin = client('postgres')
    const application = client('guest_application')
    const maintenance = client('guest_maintenance')
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `reader-disposition-${suffix}`
    const venueId = `reader-venue-${suffix}`
    const sessionId = `reader-session-${suffix}`
    const operationId = randomUUID()
    const token = randomUUID()
    const at = new Date('2024-01-01T12:00:00.000Z')
    const policyVersion = 'guest-conversations-terminal-text-v1'
    const request = {
      version: 'guest-conversation-disposition-v1' as const,
      operationId,
      tenantId,
      venueId,
      sessionId,
      expectedPolicyVersion: policyVersion,
      expectedPolicySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
      basis: { kind: 'RETENTION_EXPIRY' as const },
    }
    const authority = {
      version: 'guest-disposition-authority-v1' as const,
      actorId: 'synthetic-platform-operator',
      actorRole: 'PLATFORM_ADMIN' as const,
      policyVersion,
      policySha256: GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
      retentionDays: 365 as const,
      holdAssessment: {
        status: 'NO_KNOWN_HOLD' as const,
        referenceSha256: '7'.repeat(64),
      },
      basis: request.basis,
    }
    let reclosed = true

    try {
      const initial = await control.$queryRaw<Array<{ closed: boolean }>>`
        SELECT NOT datallowconn AS closed FROM pg_database WHERE datname = ${database}
      `
      expect(initial).toEqual([{ closed: true }])
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
      reclosed = false

      await admin.tenant.create({
        data: { id: tenantId, name: 'Synthetic reader disposition tenant', slug: tenantId },
      })
      await admin.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic reader disposition venue', slug: venueId },
      })
      await admin.visitorSession.create({
        data: {
          id: sessionId,
          tenantId,
          venueId,
          anonymousToken: token,
          experienceScope: 'PUBLIC',
          startedAt: at,
          lastActiveAt: at,
        },
      })
      const asked = await admin.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 0,
          role: 'assistant',
          content: 'Synthetic disposed prompt',
          createdAt: at,
        },
      })
      const answered = await admin.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 1,
          role: 'user',
          content: 'Synthetic disposed structured answer',
          createdAt: at,
        },
      })
      await admin.engagementQuestionResponse.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          askedMessageId: asked.id,
          answerMessageId: answered.id,
          isAiInvented: false,
          questionText: 'What did you notice?',
          answerType: 'OPEN_ENDED',
          answerText: answered.content,
          askedAt: at,
          answeredAt: at,
        },
      })
      await admin.message.create({
        data: {
          tenantId,
          venueId,
          sessionId,
          sessionSequence: 2,
          role: 'user',
          content: 'Synthetic disposed ordinary opinion',
          createdAt: at,
        },
      })

      const answerPayload = {
        tenantId,
        venueId,
        snapshotId: 'disposed-reader-proof',
        rangeStart: '2024-01-01T00:00:00.000Z',
        rangeEnd: '2024-01-02T00:00:00.000Z',
      }
      const weeklyPayload = {
        tenantId,
        venueId,
        reportId: 'disposed-weekly-reader-proof',
        weekStart: answerPayload.rangeStart,
        weekEnd: answerPayload.rangeEnd,
      }
      const beforeAnswer = await loadAnswerAnalysisSources(answerPayload)
      const beforeWeekly = await loadWeeklyReportSources(weeklyPayload)
      expect(beforeAnswer.responses.map((row) => row.answerText)).toEqual([
        'Synthetic disposed structured answer',
      ])
      expect(beforeAnswer.generalMessages.sort()).toEqual(
        ['Synthetic disposed structured answer', 'Synthetic disposed ordinary opinion'].sort(),
      )
      expect(beforeWeekly).toMatchObject({
        sessionCount: 1,
        messageCount: 3,
        responseCount: 1,
        responseSampleCount: 1,
      })

      const authorized = await recordGuestConversationDispositionAuthorization(
        { request, authority },
        application,
      )
      await db.$disconnect()
      await admin.$disconnect()
      await application.$disconnect()
      await maintenance.$queryRaw`SELECT pg_backend_pid()`
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
      reclosed = true
      const intentRows = await maintenance.$queryRaw<Array<{ result: Record<string, unknown> }>>`
        SELECT public.pathfinder_seal_guest_disposition(
          ${operationId}::uuid, ${authorized.requestSha256}
        ) AS result
      `
      expect(intentRows).toHaveLength(1)
      const intent = intentRows[0]!.result
      expect(intent?.affected).toMatchObject({ sessions: 1, messages: 3 })
      const receiptRows = await maintenance.$queryRaw<Array<{ result: Record<string, unknown> }>>`
        SELECT public.pathfinder_apply_guest_disposition(
          ${operationId}::uuid, ${authorized.requestSha256}, ${'b'.repeat(64)}
        ) AS result
      `
      expect(receiptRows).toHaveLength(1)
      const receipt = receiptRows[0]!.result
      expect(receipt?.affected).toEqual(intent?.affected)
      await maintenance.$disconnect()
      await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`)
      reclosed = false

      const afterAnswer = await loadAnswerAnalysisSources(answerPayload)
      const afterWeekly = await loadWeeklyReportSources(weeklyPayload)
      expect(afterAnswer).toMatchObject({ responses: [], generalMessages: [] })
      expect(afterWeekly).toMatchObject({
        sessionCount: 1,
        messageCount: 3,
        responseCount: 1,
        responseSampleCount: 0,
        responses: [],
        generalMessages: [],
      })
      expect(await db.answerAnalysisSnapshot.count({ where: { tenantId, venueId } })).toBe(0)
      expect(await db.weeklyReport.count({ where: { tenantId, venueId } })).toBe(0)

      const output = process.env.PATHFINDER_DISPOSABLE_PROOF_OUTPUT
      if (output)
        writeFileSync(
          output,
          JSON.stringify(
            {
              authorizedState: authorized.state,
              sealAffected: intent?.affected,
              applyAffected: receipt?.affected,
              disposedAnswerResponses: afterAnswer.responses.length,
              disposedAnswerGeneralMessages: afterAnswer.generalMessages.length,
              structuralSessionCount: afterWeekly.sessionCount,
              structuralMessageCount: afterWeekly.messageCount,
              structuralResponseCount: afterWeekly.responseCount,
              responseEvidenceSampleCount: afterWeekly.responseSampleCount,
              noProviderOrSnapshotWrite: true,
            },
            null,
            2,
          ),
        )
    } finally {
      await Promise.allSettled([
        db.$disconnect(),
        admin.$disconnect(),
        application.$disconnect(),
        maintenance.$disconnect(),
      ])
      if (!reclosed) {
        await control.$executeRawUnsafe(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS false`)
      }
      await control.$disconnect()
    }
  }, 60_000)
})
