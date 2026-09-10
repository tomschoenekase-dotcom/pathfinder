import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import { db } from '@pathfinder/db'
import { WEEKLY_REPORT_QUEUE } from '@pathfinder/jobs'

import { requestWeeklyReportDraftAction } from '../lib/weekly-report-generation'
import { createSafeOperationalMcpRegistry } from './composition'

const enabled =
  process.env.RUN_REPORT_ACTIVITY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_report_activity_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

type WeeklyReportWorker = {
  _setAnthropicClientForTesting(client: AnthropicMessagesClient | null): void
  processWeeklyReportJob(
    payload: {
      reportId: string
      tenantId: string
      venueId: string
      weekStart: string
      weekEnd: string
    },
    execution: { bullJobId: string; attemptNumber: number; maxAttempts: number },
  ): Promise<void>
}

describe.skipIf(!enabled)('weekly report activity generation disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('generates scoped high low and zero activity drafts through the worker and lifecycle', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `report-activity-${suffix}`
    const privateMarker = `private-${suffix}`
    const weekStart = new Date('2026-09-01T00:00:00.000Z')
    const weekEnd = new Date('2026-09-07T23:59:59.999Z')
    const highVenueId = `high-${suffix}`
    const lowVenueId = `low-${suffix}`
    const zeroVenueId = `zero-${suffix}`
    await db.tenant.create({
      data: { id: tenantId, name: 'Report activity proof', slug: tenantId },
    })
    for (const [id, name] of [
      [highVenueId, 'High activity venue'],
      [lowVenueId, 'Low activity venue'],
      [zeroVenueId, 'Zero activity venue'],
    ] as const) {
      await db.venue.create({ data: { id, tenantId, name, slug: id } })
      await db.venueReportConfiguration.create({
        data: { tenantId, venueId: id, enabled: true, updatedBy: 'integration-operator' },
      })
    }
    const sessionFor = async (venueId: string, key: string, experienceScope = 'PUBLIC') =>
      db.visitorSession.create({
        data: {
          tenantId,
          venueId,
          anonymousToken: `${tenantId}-${key}`,
          experienceScope,
          startedAt: weekStart,
          lastActiveAt: weekStart,
        },
      })
    const highSessions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => sessionFor(highVenueId, `high-${index}`)),
    )
    const lowSession = await sessionFor(lowVenueId, 'low')
    const privateSession = await sessionFor(highVenueId, 'private', 'SECOND_LAYER')
    await db.message.createMany({
      data: [
        ...highSessions.map((session, index) => ({
          id: index === 0 ? `high-message-${suffix}` : `high-message-${index}-${suffix}`,
          tenantId,
          venueId: highVenueId,
          sessionId: session.id,
          sessionSequence: 1,
          role: 'user' as const,
          content: index === 0 ? 'Where are the restrooms?' : `Public visitor question ${index}.`,
          createdAt: weekStart,
        })),
        {
          id: `low-message-${suffix}`,
          tenantId,
          venueId: lowVenueId,
          sessionId: lowSession.id,
          sessionSequence: 1,
          role: 'user',
          content: 'When does the gallery close?',
          createdAt: weekStart,
        },
        {
          id: `private-message-${suffix}`,
          tenantId,
          venueId: highVenueId,
          sessionId: privateSession.id,
          sessionSequence: 1,
          role: 'user',
          content: privateMarker,
          createdAt: weekStart,
        },
      ],
    })
    const worker = (await import(
      /* @vite-ignore */ new URL(
        '../../../../apps/workers/src/processors/weekly-report.ts',
        import.meta.url,
      ).href
    )) as WeeklyReportWorker
    const providerCreate = vi.fn(async (request: { messages: Array<{ content: string }> }) => {
      const prompt = request.messages[0]?.content ?? ''
      const low = prompt.includes('When does the gallery close?')
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              nextSteps: ['Review the public visitor questions before changing guidance.'],
              findings: [
                {
                  statement: low
                    ? 'One visitor asked when the gallery closes.'
                    : 'A visitor asked where the restrooms are.',
                  evidence: [
                    {
                      sourceId: low
                        ? `public-message:low-message-${suffix}`
                        : `public-message:high-message-${suffix}`,
                      excerpt: low ? 'When does the gallery close?' : 'Where are the restrooms?',
                    },
                  ],
                },
                {
                  statement: 'Unsupported private trend.',
                  evidence: [{ sourceId: 'public-message:unknown', excerpt: 'invented excerpt' }],
                },
              ],
            }),
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }
    })
    worker._setAnthropicClientForTesting({
      messages: { create: providerCreate },
    } as AnthropicMessagesClient)
    try {
      const request = async (venueId: string, label: string) => {
        const generated = await requestWeeklyReportDraftAction({
          tenantId,
          venueId,
          weekStart,
          weekEnd,
          requestId: randomUUID(),
          title: `Synthetic ${label} report`,
          actor: { id: 'integration-operator', role: 'PLATFORM_ADMIN' },
        })
        await worker.processWeeklyReportJob(
          {
            reportId: generated.reportId,
            tenantId,
            venueId,
            weekStart: weekStart.toISOString(),
            weekEnd: weekEnd.toISOString(),
          },
          { bullJobId: `report-activity-${label}-${suffix}`, attemptNumber: 1, maxAttempts: 1 },
        )
        return generated.reportId
      }
      const highReportId = await request(highVenueId, 'high')
      const lowReportId = await request(lowVenueId, 'low')
      const callsBeforeZero = providerCreate.mock.calls.length
      const zeroReportId = await request(zeroVenueId, 'zero')
      expect(providerCreate).toHaveBeenCalledTimes(callsBeforeZero)
      expect(providerCreate).toHaveBeenCalledTimes(2)
      const prompts = providerCreate.mock.calls.map(
        ([request]) =>
          (request as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
      )
      expect(prompts).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Where are the restrooms?'),
          expect.stringContaining('When does the gallery close?'),
        ]),
      )
      expect(prompts.every((prompt) => !prompt.includes(privateMarker))).toBe(true)
      expect(prompts.find((prompt) => prompt.includes('Where are the restrooms?'))).not.toContain(
        'When does the gallery close?',
      )

      const reports = await db.weeklyReport.findMany({
        where: { tenantId, id: { in: [highReportId, lowReportId, zeroReportId] } },
        select: { id: true, status: true, content: true, generatedAt: true, publishedAt: true },
      })
      expect(reports).toHaveLength(3)
      expect(
        reports.every(
          (report) => report.status === 'DRAFT' && report.generatedAt && !report.publishedAt,
        ),
      ).toBe(true)
      expect(reports.find((report) => report.id === highReportId)?.content).toContain(
        'Where are the restrooms?',
      )
      expect(reports.find((report) => report.id === highReportId)?.content).not.toContain(
        'Unsupported private trend.',
      )
      expect(reports.find((report) => report.id === highReportId)?.content).toContain(
        'Observations reflect only the public interactions',
      )
      expect(reports.find((report) => report.id === lowReportId)?.content).toContain('Low sample:')
      expect(reports.find((report) => report.id === zeroReportId)?.content).toContain(
        'No public text conversations were recorded',
      )
      expect(JSON.stringify(reports)).not.toContain(privateMarker)

      const registry = createSafeOperationalMcpRegistry(db)
      const lifecycleFor = async (venueId: string, reportId: string) =>
        registry.callTool(
          'torchiko.reports.get_lifecycle',
          { clientId: tenantId, venueId, reportId },
          {
            credential: {
              credentialId: `credential-${suffix}`,
              tenantId,
              clientId: tenantId,
              venueIds: [venueId],
              capabilities: ['reports:read'],
            } satisfies VerifiedMcpCredentialScope,
          },
        )
      const [highLifecycle, lowLifecycle, zeroLifecycle] = await Promise.all([
        lifecycleFor(highVenueId, highReportId),
        lifecycleFor(lowVenueId, lowReportId),
        lifecycleFor(zeroVenueId, zeroReportId),
      ])
      for (const lifecycle of [highLifecycle, lowLifecycle, zeroLifecycle]) {
        expect(lifecycle.structuredContent).toMatchObject({
          kind: 'torchiko.weekly-report-lifecycle',
          data: {
            status: 'REVIEW',
            publication: { state: 'NOT_PUBLISHED', clientVisible: false },
            generation: {
              dispatch: { state: 'CONSUMED' },
              jobs: { count: 1, latest: { status: 'COMPLETE' } },
            },
          },
        })
        expect(JSON.stringify(lifecycle)).not.toContain(privateMarker)
      }
      expect(zeroLifecycle.structuredContent).toMatchObject({
        data: { report: { sourceEvidence: { capturedAnswerCount: 0, publicSessionCount: 0 } } },
      })
      expect(highLifecycle.structuredContent).toMatchObject({
        data: { report: { sourceEvidence: { capturedAnswerCount: 0, publicSessionCount: 6 } } },
      })
      expect(lowLifecycle.structuredContent).toMatchObject({
        data: { report: { sourceEvidence: { capturedAnswerCount: 0, publicSessionCount: 1 } } },
      })
      expect(
        await db.operationalEventDelivery.count({
          where: { tenantId },
        }),
      ).toBe(0)
      expect(
        await db.jobRecord.count({ where: { tenantId, queue: { not: WEEKLY_REPORT_QUEUE } } }),
      ).toBe(0)
    } finally {
      worker._setAnthropicClientForTesting(null)
    }
  }, 120_000)
})
