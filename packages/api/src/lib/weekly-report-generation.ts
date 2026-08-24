import { randomUUID } from 'node:crypto'

import { db, lockVenueReportMutation, withTenantIsolationBypass } from '@pathfinder/db'

import {
  effectiveWeeklyReportTitle,
  generationRequestHash,
  LEGACY_DEFAULT_WEEKLY_REPORT_TITLES,
} from './generation-request-identity'
import { findVenueReportConfiguration } from './venue-report-configuration'

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]

export type WeeklyReportRequestActor = Readonly<{
  id: string
  role: 'PLATFORM_ADMIN' | 'AGENT'
  lineage?: Readonly<{
    agentIdentityId: string
    agentRunId: string
    workerId: string
    credentialId: string
    approvalGrantId: string
    capability: 'reports:draft'
    modelProvider?: string
    modelName?: string
  }>
}>

export type WeeklyReportDraftRequest = Readonly<{
  tenantId: string
  venueId: string
  weekStart: Date
  weekEnd: Date
  title?: string
  requestId: string
  actor: WeeklyReportRequestActor
}>

export type WeeklyReportDraftRequestResult = Readonly<{
  dispatchId: string
  reportId: string
  requestId: string
  dispatchState: 'PENDING' | 'CONSUMED'
  replayed: boolean
  enqueueAllowed: boolean
}>

export type WeeklyReportDraftRequestHooks = Readonly<{
  authorize?: (transaction: Transaction) => Promise<void>
  resolved?: (transaction: Transaction, result: WeeklyReportDraftRequestResult) => Promise<void>
}>

export class WeeklyReportGenerationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'WeeklyReportGenerationError'
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * Canonical durable weekly-report draft request shared by the human admin API and governed
 * machine tools. Authorization hooks run inside the same transaction as request creation/replay.
 * This action never publishes a report and never calls an AI provider directly.
 */
export async function requestWeeklyReportDraftAction(
  input: WeeklyReportDraftRequest,
  hooks: WeeklyReportDraftRequestHooks = {},
  database: typeof db = db,
): Promise<WeeklyReportDraftRequestResult> {
  if (input.weekStart.getTime() > input.weekEnd.getTime()) {
    throw new WeeklyReportGenerationError(
      'INVALID_INPUT',
      'Report week start must be on or before week end.',
    )
  }

  const title = effectiveWeeklyReportTitle(input.title)
  const requestHash = generationRequestHash({
    kind: 'WEEKLY_REPORT',
    venueId: input.venueId,
    rangeStart: input.weekStart,
    rangeEnd: input.weekEnd,
    title,
  })
  const legacyRequestHashes = input.title?.trim()
    ? []
    : LEGACY_DEFAULT_WEEKLY_REPORT_TITLES.map((legacyTitle) =>
        generationRequestHash({
          kind: 'WEEKLY_REPORT',
          venueId: input.venueId,
          rangeStart: input.weekStart,
          rangeEnd: input.weekEnd,
          title: legacyTitle,
        }),
      )

  const createOrReplay = () =>
    withTenantIsolationBypass(() =>
      database.$transaction(async (transaction) => {
        await lockVenueReportMutation(transaction, input)
        const venue = await transaction.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true, isActive: true },
        })
        if (!venue) {
          throw new WeeklyReportGenerationError('NOT_FOUND', 'Venue not found')
        }
        if (venue.isActive === false) {
          throw new WeeklyReportGenerationError(
            'PRECONDITION_FAILED',
            'This venue is temporarily unavailable.',
          )
        }

        const existing = await transaction.generationRequestDispatch.findFirst({
          where: {
            tenantId: input.tenantId,
            kind: 'WEEKLY_REPORT',
            requestId: input.requestId,
          },
          select: { id: true, recordId: true, requestHash: true, status: true },
        })
        if (existing) {
          if (
            existing.requestHash !== requestHash &&
            !legacyRequestHashes.some((hash) => hash === existing.requestHash)
          ) {
            throw new WeeklyReportGenerationError(
              'CONFLICT',
              'Request ID was already used for different report input.',
            )
          }
          const configuration = await findVenueReportConfiguration(
            transaction,
            input.tenantId,
            input.venueId,
          )
          await hooks.authorize?.(transaction)
          const result = {
            dispatchId: existing.id,
            reportId: existing.recordId,
            requestId: input.requestId,
            dispatchState: existing.status,
            replayed: true,
            enqueueAllowed: configuration?.enabled === true,
          } satisfies WeeklyReportDraftRequestResult
          await hooks.resolved?.(transaction, result)
          return result
        }

        const configuration = await findVenueReportConfiguration(
          transaction,
          input.tenantId,
          input.venueId,
        )
        if (configuration?.enabled !== true) {
          throw new WeeklyReportGenerationError(
            'PRECONDITION_FAILED',
            'Weekly reports are disabled for this venue.',
          )
        }
        await hooks.authorize?.(transaction)

        const reportId = randomUUID()
        const dispatchId = randomUUID()
        await transaction.weeklyReport.create({
          data: {
            id: reportId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            weekStart: input.weekStart,
            weekEnd: input.weekEnd,
            status: 'GENERATING',
            title,
            createdBy: input.actor.id,
          },
        })
        const dispatch = await transaction.generationRequestDispatch.create({
          data: {
            id: dispatchId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            kind: 'WEEKLY_REPORT',
            requestId: input.requestId,
            requestHash,
            recordId: reportId,
            rangeStart: input.weekStart,
            rangeEnd: input.weekEnd,
            weeklyReportId: reportId,
          },
          select: { id: true, recordId: true, status: true },
        })
        await transaction.auditLog.create({
          data: {
            tenantId: input.tenantId,
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: 'admin.report.requested',
            targetType: 'WeeklyReport',
            targetId: reportId,
            afterState: {
              venueId: input.venueId,
              weekStart: input.weekStart.toISOString(),
              weekEnd: input.weekEnd.toISOString(),
              requestId: input.requestId,
              ...(input.actor.lineage ?? {}),
            },
          },
        })
        const result = {
          dispatchId: dispatch.id,
          reportId: dispatch.recordId,
          requestId: input.requestId,
          dispatchState: dispatch.status,
          replayed: false,
          enqueueAllowed: true,
        } satisfies WeeklyReportDraftRequestResult
        await hooks.resolved?.(transaction, result)
        return result
      }),
    )

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    return createOrReplay()
  }
}
