import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '@pathfinder/db'

const enabled =
  process.env.RUN_REPORT_SNAPSHOT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_report_snapshot_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

type WeeklyReportWorker = {
  loadWeeklyReportSources(payload: {
    reportId: string
    tenantId: string
    venueId: string
    weekStart: string
    weekEnd: string
  }): Promise<{
    responseCount: number
    responseSampleCount: number
    responses: Array<{ id: string; answerText: string }>
  }>
}

describe.skipIf(!enabled)('weekly report captured-answer snapshot disposable integration', () => {
  afterAll(async () => db.$disconnect())

  it('keeps captured answer counts and bounded samples on one native snapshot', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `report-snapshot-${suffix}`
    const venueId = `report-snapshot-venue-${suffix}`
    const siblingVenueId = `report-snapshot-sibling-${suffix}`
    const weekStart = new Date('2026-09-01T00:00:00.000Z')
    const weekEnd = new Date('2026-09-07T23:59:59.999Z')
    const privateMarker = `private-${suffix}`
    await db.tenant.create({
      data: { id: tenantId, name: 'Report snapshot proof', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Snapshot venue', slug: venueId },
    })
    await db.venue.create({
      data: { id: siblingVenueId, tenantId, name: 'Snapshot sibling', slug: siblingVenueId },
    })

    const createResponseRows = async (params: {
      venueId: string
      prefix: string
      count: number
      experienceScope?: 'PUBLIC' | 'SECOND_LAYER'
      isAiInvented?: boolean
      answer?: (index: number) => string
      answeredAt?: Date
    }) => {
      const sessions = await Promise.all(
        Array.from({ length: params.count }, (_, index) =>
          db.visitorSession.create({
            data: {
              tenantId,
              venueId: params.venueId,
              anonymousToken: `${tenantId}-${params.prefix}-session-${index}`,
              experienceScope: params.experienceScope ?? 'PUBLIC',
              startedAt: weekStart,
              lastActiveAt: weekStart,
            },
          }),
        ),
      )
      const messages = sessions.flatMap((session, index) => {
        const id = `${params.prefix}-${String(index).padStart(3, '0')}`
        return [
          {
            id: `${id}-asked`,
            tenantId,
            venueId: params.venueId,
            sessionId: session.id,
            sessionSequence: 1,
            role: 'assistant' as const,
            content: 'What did you enjoy?',
            createdAt: weekStart,
          },
          {
            id: `${id}-answer`,
            tenantId,
            venueId: params.venueId,
            sessionId: session.id,
            sessionSequence: 2,
            role: 'user' as const,
            content: params.answer?.(index) ?? `Answer ${index}`,
            createdAt: weekStart,
          },
        ]
      })
      await db.message.createMany({ data: messages })
      await db.engagementQuestionResponse.createMany({
        data: sessions.map((session, index) => {
          const id = `${params.prefix}-${String(index).padStart(3, '0')}`
          return {
            id: `${id}-response`,
            tenantId,
            venueId: params.venueId,
            sessionId: session.id,
            isAiInvented: params.isAiInvented ?? false,
            answerType: 'OPEN_ENDED' as const,
            questionText: 'What did you enjoy?',
            askedMessageId: `${id}-asked`,
            answerMessageId: `${id}-answer`,
            answerText: params.answer?.(index) ?? `Answer ${index}`,
            askedAt: params.answeredAt ?? weekStart,
            answeredAt: params.answeredAt ?? weekStart,
          }
        }),
      })
    }

    await createResponseRows({
      venueId,
      prefix: 'old',
      count: 99,
      answer: (index) => `Public answer ${index}`,
      answeredAt: new Date(weekStart.getTime() + 1_000),
    })
    await createResponseRows({
      venueId,
      prefix: 'private',
      count: 1,
      experienceScope: 'SECOND_LAYER',
      answer: () => privateMarker,
    })
    await createResponseRows({
      venueId,
      prefix: 'invented',
      count: 1,
      isAiInvented: true,
      answer: () => `invented-${suffix}`,
    })
    await createResponseRows({
      venueId: siblingVenueId,
      prefix: 'sibling',
      count: 1,
      answer: () => `sibling-${suffix}`,
    })
    const worker = (await import(
      /* @vite-ignore */ new URL(
        '../../../../apps/workers/src/processors/weekly-report.ts',
        import.meta.url,
      ).href
    )) as WeeklyReportWorker

    let resolveCount!: () => void
    let resolveWriter!: () => void
    let rejectWriter!: (error: Error) => void
    const countFinished = new Promise<void>((resolve) => {
      resolveCount = resolve
    })
    const writerCommitted = new Promise<void>((resolve, reject) => {
      resolveWriter = resolve
      rejectWriter = reject
    })
    let repeatableReadTransactionSeen = false
    let countInterceptions = 0
    let findManyInterceptions = 0
    let barrierActive = true
    const originalTransaction = db.$transaction.bind(db)
    ;(db as unknown as { $transaction: typeof db.$transaction }).$transaction = (async (
      callback: (tx: unknown) => unknown,
      options?: { isolationLevel?: string },
    ) => {
      if (options?.isolationLevel !== 'RepeatableRead')
        return originalTransaction(callback as never, options as never)
      repeatableReadTransactionSeen = true
      return originalTransaction(async (tx) => {
        const responseDelegate = tx.engagementQuestionResponse
        const instrumentedResponse = new Proxy(responseDelegate, {
          get(target, property, receiver) {
            if (property === 'count')
              return async (args: { where?: { tenantId?: string; venueId?: string } }) => {
                const result = await target.count(args)
                if (
                  barrierActive &&
                  args.where?.tenantId === tenantId &&
                  args.where.venueId === venueId
                ) {
                  countInterceptions += 1
                  resolveCount()
                }
                return result
              }
            if (property === 'findMany')
              return async (args: { where?: { tenantId?: string; venueId?: string } }) => {
                if (
                  barrierActive &&
                  args.where?.tenantId === tenantId &&
                  args.where.venueId === venueId
                ) {
                  findManyInterceptions += 1
                  await writerCommitted
                }
                return target.findMany(args)
              }
            return Reflect.get(target, property, receiver)
          },
        })
        return callback(
          new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'engagementQuestionResponse') return instrumentedResponse
              return Reflect.get(target, property, receiver)
            },
          }),
        )
      }, options as never)
    }) as typeof db.$transaction

    const payload = {
      reportId: `snapshot-report-${suffix}`,
      tenantId,
      venueId,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
    }
    let snapshotRead: Promise<
      Awaited<ReturnType<WeeklyReportWorker['loadWeeklyReportSources']>>
    > | null = null
    let countTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      snapshotRead = worker.loadWeeklyReportSources(payload)
      // Attach immediately: a timeout or writer failure must not leave a rejected RR transaction unobserved.
      void snapshotRead.catch(() => undefined)
      await Promise.race([
        countFinished,
        snapshotRead.then(
          () => {
            throw new Error('weekly report reader finished before the count barrier')
          },
          (error: unknown) => {
            throw error
          },
        ),
        new Promise<void>((_, reject) => {
          countTimeout = setTimeout(() => reject(new Error('count barrier timed out')), 10_000)
        }),
      ])
      if (countTimeout) clearTimeout(countTimeout)
      await createResponseRows({
        venueId,
        prefix: 'writer',
        count: 3,
        answeredAt: weekStart,
      })
      resolveWriter()
      const snapshot = await snapshotRead
      expect(repeatableReadTransactionSeen).toBe(true)
      expect(countInterceptions).toBe(1)
      expect(findManyInterceptions).toBe(1)
      expect(snapshot.responseCount).toBe(99)
      expect(snapshot.responseSampleCount).toBe(99)
      expect(snapshot.responses).toHaveLength(99)
      expect(snapshot.responses.map(({ id }) => id)).toEqual(
        Array.from({ length: 99 }, (_, index) => `old-${String(index).padStart(3, '0')}-response`),
      )
      expect(JSON.stringify(snapshot)).not.toContain(privateMarker)
      expect(JSON.stringify(snapshot)).not.toContain(`sibling-${suffix}`)
      expect(snapshot.responses.map(({ id }) => id)).not.toContain('invented-000-response')

      barrierActive = false
      const fresh = await worker.loadWeeklyReportSources(payload)
      expect(fresh.responseCount).toBe(102)
      expect(fresh.responseSampleCount).toBe(100)
      expect(fresh.responses).toHaveLength(100)
      expect(fresh.responses.map(({ id }) => id).slice(0, 3)).toEqual(
        Array.from(
          { length: 3 },
          (_, index) => `writer-${String(index).padStart(3, '0')}-response`,
        ),
      )
      expect(fresh.responses.map(({ id }) => id).slice(3)).toEqual(
        Array.from({ length: 97 }, (_, index) => `old-${String(index).padStart(3, '0')}-response`),
      )

      await db.engagementQuestionResponse.updateMany({
        where: { tenantId, venueId, isAiInvented: false },
        data: { answerText: `café 東京 ${'東京 café '.repeat(200)}` },
      })
      const bounded = await worker.loadWeeklyReportSources(payload)
      expect(bounded.responses[0]?.answerText).toContain('café 東京')
      expect(bounded.responses[0]?.answerText.length).toBeLessThanOrEqual(500)
      expect(bounded.responseCount).toBe(102)
      expect(bounded.responseSampleCount).toBeLessThan(100)
      expect(bounded.responseSampleCount).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(bounded.responses), 'utf8')).toBeLessThanOrEqual(
        30_000,
      )
    } finally {
      barrierActive = false
      if (countTimeout) clearTimeout(countTimeout)
      resolveWriter?.()
      rejectWriter?.(new Error('snapshot writer gate released during teardown'))
      await snapshotRead?.catch(() => undefined)
      ;(db as unknown as { $transaction: typeof db.$transaction }).$transaction =
        originalTransaction
    }
  }, 120_000)
})
