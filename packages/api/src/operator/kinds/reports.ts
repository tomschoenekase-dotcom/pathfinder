import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { publishWeeklyReportAction, WeeklyReportActionError } from '@pathfinder/db'
import { enqueueGenerationDispatchKick } from '@pathfinder/jobs'

import { logger } from '@pathfinder/config/logger'

import {
  requestWeeklyReportDraftAction,
  WeeklyReportGenerationError,
} from '../../lib/weekly-report-generation'
import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'
import { classifyGeneratingReport } from '../report-generation'
import { readReportJobs } from '../tools/reports'

type ReportState = {
  reportId: string
  venueId: string
  status: string
  weekStart: string
  weekEnd: string
  title: string
  updatedAt: string
}

async function readReport(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
  reportId: string,
): Promise<(ReportState & { leaseExpiresAt: Date | null }) | null> {
  const row = await database.weeklyReport.findFirst({
    where: { id: reportId, tenantId, venueId },
    select: {
      id: true,
      venueId: true,
      status: true,
      weekStart: true,
      weekEnd: true,
      title: true,
      updatedAt: true,
      executionLeaseExpiresAt: true,
    },
  })
  return row
    ? {
        reportId: row.id,
        venueId: row.venueId,
        status: row.status,
        weekStart: row.weekStart.toISOString(),
        weekEnd: row.weekEnd.toISOString(),
        title: row.title,
        updatedAt: row.updatedAt.toISOString(),
        leaseExpiresAt: row.executionLeaseExpiresAt,
      }
    : null
}

function snapshotOf(report: (ReportState & { leaseExpiresAt: Date | null }) | null): JsonValue {
  if (!report) return null
  return {
    reportId: report.reportId,
    venueId: report.venueId,
    status: report.status,
    weekStart: report.weekStart,
    weekEnd: report.weekEnd,
    title: report.title,
    updatedAt: report.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// generate / retry
// ---------------------------------------------------------------------------

const generateInput = OPERATOR_MCP_INPUTS['reports.propose_generate']
type GenerateArgs = ReturnType<typeof generateInput.parse>

/**
 * A retry is only for a report that is provably not being worked: FAILED, or GENERATING with no
 * live lease and a failed or missing job. A report whose worker is alive, or whose state is
 * `unknown`, is refused so a second run cannot race the first.
 */
async function assertRetryable(
  args: GenerateArgs,
  context: OperatorKindContext,
): Promise<ReportState> {
  const report = await readReport(
    context.database,
    args.tenantId,
    args.venueId,
    args.retryOfReportId!,
  )
  if (!report) throw new OperatorNotFoundError()
  if (report.status === 'FAILED') return report
  if (report.status !== 'GENERATING') {
    throw new OperatorStaleError(`The report is ${report.status}; only a failed report is retried.`)
  }
  const jobs = await readReportJobs(context.database, args.tenantId, report.reportId, 5)
  const latest = jobs[0] ?? null
  const verdict = classifyGeneratingReport({
    leaseExpiresAt: report.leaseExpiresAt,
    latestJob: latest
      ? { id: latest.id, status: latest.status, failureDisposition: latest.failureDisposition }
      : null,
    jobCount: jobs.length,
    now: context.now,
  })
  if (verdict.classification !== 'no_job_found' && verdict.classification !== 'job_failed') {
    throw new OperatorStaleError(
      `The report is not provably stalled (${verdict.classification}). ${verdict.reason}`,
    )
  }
  return report
}

function mapGenerationError(error: unknown): never {
  if (error instanceof WeeklyReportGenerationError) {
    if (error.code === 'NOT_FOUND') throw new OperatorNotFoundError()
    throw new OperatorStaleError(error.message)
  }
  throw error
}

export const reportsGenerateKind: OperatorProposalKind<GenerateArgs> = {
  kind: 'reports.generate',
  tool: 'reports.propose_generate',
  capability: 'reports:propose',
  parse: (raw) => generateInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    if (args.retryOfReportId) {
      const report = await readReport(
        context.database,
        args.tenantId,
        args.venueId,
        args.retryOfReportId,
      )
      if (!report) throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) =>
    args.retryOfReportId && args.expectedUpdatedAt
      ? new Date(args.expectedUpdatedAt).toISOString()
      : null,
  currentVersion: async (args, context) =>
    args.retryOfReportId
      ? ((await readReport(context.database, args.tenantId, args.venueId, args.retryOfReportId))
          ?.updatedAt ?? null)
      : null,
  describe: (args) => ({
    title: args.retryOfReportId
      ? 'Retry a stalled weekly report (spends model budget, creates a new draft)'
      : 'Generate a weekly report draft (spends model budget, creates a draft only)',
    lines: [
      args.retryOfReportId
        ? `retry of report ${args.retryOfReportId}: same week and title`
        : `week ${args.weekStart} to ${args.weekEnd}`,
      ...(args.title ? [`title: ${args.title}`] : []),
      'The report is not published and nobody is emailed.',
    ],
  }),
  snapshot: async (args, context) =>
    args.retryOfReportId
      ? snapshotOf(
          await readReport(context.database, args.tenantId, args.venueId, args.retryOfReportId),
        )
      : null,
  apply: async (args, context: OperatorApplyContext) => {
    let weekStart = args.weekStart
    let weekEnd = args.weekEnd
    let title = args.title
    if (args.retryOfReportId) {
      const source = await assertRetryable(args, context)
      weekStart = source.weekStart
      weekEnd = source.weekEnd
      title = title ?? source.title
    }
    let request
    try {
      request = await requestWeeklyReportDraftAction({
        tenantId: args.tenantId,
        venueId: args.venueId,
        weekStart: new Date(weekStart!),
        weekEnd: new Date(weekEnd!),
        ...(title === undefined ? {} : { title }),
        // The operation id is the request id, so a replay finds the report it already created.
        requestId: args.operationId,
        actor: { id: context.actor.id, role: 'PLATFORM_ADMIN' },
      })
    } catch (error) {
      mapGenerationError(error)
    }
    if (request.dispatchState === 'PENDING' && request.enqueueAllowed) {
      try {
        await enqueueGenerationDispatchKick(request.dispatchId)
      } catch {
        // The durable dispatch is retried by the dispatcher; the request itself is recorded.
        logger.warn({
          action: 'operator.report-generate.dispatch-kick.failed',
          tenantId: args.tenantId,
          venueId: args.venueId,
          reportId: request.reportId,
        })
      }
    }
    const created = await readReport(
      context.database,
      args.tenantId,
      args.venueId,
      request.reportId,
    )
    return {
      result: {
        reportId: request.reportId,
        dispatchState: request.dispatchState,
        replayed: request.replayed,
        retryOfReportId: args.retryOfReportId ?? null,
        published: false,
      },
      after: snapshotOf(created),
    }
  },
  /** The request id is the operation id, so the dispatch row is the receipt. */
  reconcile: async (args, context) => {
    const dispatch = await context.database.generationRequestDispatch.findFirst({
      where: {
        tenantId: args.tenantId,
        kind: 'WEEKLY_REPORT',
        requestId: args.operationId,
      },
      select: { recordId: true, status: true },
    })
    if (!dispatch) return { state: 'not_applied' }
    const created = await readReport(
      context.database,
      args.tenantId,
      args.venueId,
      dispatch.recordId,
    )
    return {
      state: 'applied',
      outcome: {
        result: {
          reportId: dispatch.recordId,
          dispatchState: dispatch.status,
          replayed: true,
          retryOfReportId: args.retryOfReportId ?? null,
          published: false,
        },
        after: snapshotOf(created),
      },
    }
  },
}

// ---------------------------------------------------------------------------
// publish (not delivery)
// ---------------------------------------------------------------------------

const publishInput = OPERATOR_MCP_INPUTS['reports.propose_publish']
type PublishArgs = ReturnType<typeof publishInput.parse>

export const reportsPublishKind: OperatorProposalKind<PublishArgs> = {
  kind: 'reports.publish',
  tool: 'reports.propose_publish',
  capability: 'reports:propose',
  parse: (raw) => publishInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context: OperatorKindContext) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    const report = await readReport(context.database, args.tenantId, args.venueId, args.reportId)
    if (!report) throw new OperatorNotFoundError()
  },
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await readReport(context.database, args.tenantId, args.venueId, args.reportId))?.updatedAt ??
    null,
  describe: (args) => ({
    title: 'Publish this reviewed report (it appears in the customer portal)',
    lines: [
      `report ${args.reportId} at version ${args.expectedUpdatedAt}`,
      'Publishing is not delivery: no email or message is sent. Delivery is a separate decision.',
    ],
  }),
  snapshot: async (args, context) =>
    snapshotOf(await readReport(context.database, args.tenantId, args.venueId, args.reportId)),
  apply: async (args, context: OperatorApplyContext) => {
    try {
      await publishWeeklyReportAction(
        {
          tenantId: args.tenantId,
          venueId: args.venueId,
          reportId: args.reportId,
          expectedUpdatedAt: new Date(args.expectedUpdatedAt),
          actor: { type: 'HUMAN', id: context.actor.id, role: 'PLATFORM_ADMIN' },
        },
        context.database,
      )
    } catch (error) {
      if (error instanceof WeeklyReportActionError) {
        if (error.code === 'NOT_FOUND') throw new OperatorNotFoundError()
        if (error.code === 'CONFLICT' || error.code === 'INVALID_STATUS') {
          throw new OperatorStaleError(error.message)
        }
      }
      throw error
    }
    const after = (await readReport(context.database, args.tenantId, args.venueId, args.reportId))!
    return {
      result: {
        reportId: args.reportId,
        status: after.status,
        updatedAt: after.updatedAt,
        delivered: false,
      },
      after: snapshotOf(after),
    }
  },
  /**
   * Publishing is one transaction but leaves no receipt tied to this operation, so only "untouched"
   * can be answered. A published report might have been published by this call or by a person.
   */
  reconcile: async (args, context) => {
    const current = await readReport(context.database, args.tenantId, args.venueId, args.reportId)
    if (!current) return { state: 'unknown' }
    return current.status === 'DRAFT' &&
      current.updatedAt === new Date(args.expectedUpdatedAt).toISOString()
      ? { state: 'not_applied' }
      : { state: 'unknown' }
  },
}

export const REPORT_KINDS = [reportsGenerateKind, reportsPublishKind]
