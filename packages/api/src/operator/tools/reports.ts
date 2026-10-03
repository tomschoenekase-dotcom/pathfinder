import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { WEEKLY_REPORT_QUEUE } from '@pathfinder/jobs'

import { simpleWeeklyReportStatus } from '../../lib/weekly-report-lifecycle'
import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant, assertVenueInGrant, OperatorNotFoundError } from '../grants'
import { classifyGeneratingReport } from '../report-generation'
import type { OperatorCallContext, OperatorReadTool } from '../registry'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  OperatorInvalidCursorError,
  pageResult,
  requireCursorInScope,
} from './page'

const reportsList: OperatorReadTool = {
  name: 'reports.list',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.list'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    const baseWhere = {
      tenantId: input.tenantId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
    }
    if (input.venueId) {
      const venue = await context.database.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new OperatorNotFoundError()
    }
    const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
    const where = {
      ...baseWhere,
      ...(after
        ? { OR: [{ weekStart: { lt: after.at } }, { weekStart: after.at, id: { lt: after.id } }] }
        : {}),
    }
    if (after) {
      const anchor = await context.database.weeklyReport.findFirst({
        where: { ...baseWhere, id: after.id, weekStart: after.at },
        select: { id: true },
      })
      if (!anchor) throw new OperatorInvalidCursorError()
    }
    const rows = await context.database.weeklyReport.findMany({
      where,
      orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        venueId: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        title: true,
        content: true,
        answerCount: true,
        sessionCount: true,
        generatedAt: true,
        publishedAt: true,
        updatedAt: true,
      },
    })
    const items = rows.slice(0, input.limit)
    return pageResult(
      items.map((row) => ({
        reportId: row.id,
        venueId: row.venueId,
        weekStart: row.weekStart.toISOString(),
        weekEnd: row.weekEnd.toISOString(),
        status: row.status,
        title: operatorUntrustedText(row.title, 500),
        content: row.content === null ? null : operatorUntrustedText(row.content),
        answerCount: row.answerCount,
        sessionCount: row.sessionCount,
        generatedAt: row.generatedAt?.toISOString() ?? null,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit
        ? encodeKeysetCursor(items.at(-1)!.weekStart, items.at(-1)!.id)
        : null,
    )
  },
}

const reportsGetStatus: OperatorReadTool = {
  name: 'reports.get_status',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.get_status'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId) {
      const venue = await context.database.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new OperatorNotFoundError()
    }
    const where = {
      tenantId: input.tenantId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
    }
    const [groups, latest, configurations, venueCount] = await Promise.all([
      context.database.weeklyReport.groupBy({ by: ['status'], where, _count: { _all: true } }),
      context.database.weeklyReport.findFirst({
        where,
        orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
        select: { id: true, weekStart: true, status: true, updatedAt: true },
      }),
      context.database.venueReportConfiguration.groupBy({
        by: ['enabled'],
        where: { tenantId: input.tenantId, ...(input.venueId ? { venueId: input.venueId } : {}) },
        _count: { _all: true },
      }),
      input.venueId
        ? Promise.resolve(1)
        : context.database.venue.count({ where: { tenantId: input.tenantId } }),
    ])
    const reportCount = (status: string) =>
      groups.find((group) => group.status === status)?._count._all ?? 0
    const configCount = (enabled: boolean) =>
      configurations.find((group) => group.enabled === enabled)?._count._all ?? 0
    return {
      tenantId: input.tenantId,
      reportCounts: {
        generating: reportCount('GENERATING'),
        draft: reportCount('DRAFT'),
        published: reportCount('PUBLISHED'),
        failed: reportCount('FAILED'),
      },
      latest: latest
        ? {
            reportId: latest.id,
            weekStart: latest.weekStart.toISOString(),
            status: latest.status,
            updatedAt: latest.updatedAt.toISOString(),
          }
        : null,
      configurations: {
        enabled: configCount(true),
        disabled: Math.max(0, venueCount - configCount(true)),
      },
    }
  },
}

const jobSelect = {
  id: true,
  jobName: true,
  status: true,
  error: true,
  attemptNumber: true,
  maxAttempts: true,
  failureDisposition: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const

type JobRow = {
  id: string
  jobName: string
  status: 'RUNNING' | 'COMPLETE' | 'FAILED'
  error: string | null
  attemptNumber: number | null
  maxAttempts: number | null
  failureDisposition: string | null
  startedAt: Date
  completedAt: Date | null
}

function jobView(job: JobRow) {
  return {
    jobRecordId: job.id,
    jobName: job.jobName.slice(0, 120),
    status: job.status,
    attemptNumber: job.attemptNumber,
    maxAttempts: job.maxAttempts,
    failureDisposition: job.failureDisposition,
    error: job.error === null ? null : operatorUntrustedText(job.error),
    startedAt: job.startedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }
}

/** The jobs that name one report, newest first. Tenant is always bound. */
export function readReportJobs(
  database: OperatorCallContext['database'],
  tenantId: string,
  reportId: string,
  take: number,
) {
  return database.jobRecord.findMany({
    where: {
      tenantId,
      queue: WEEKLY_REPORT_QUEUE,
      payload: { path: ['reportId'], equals: reportId },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: jobSelect,
  })
}

const REPORT_DENOMINATOR_DEFINITION =
  'publicSessions counts public (guest) conversations that started in the window; capturedAnswers counts ' +
  'non-invented engagement-question answers captured in the window. Neither is a count of all messages.'

const reportsGet: OperatorReadTool = {
  name: 'reports.get',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.get'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const scope = { tenantId: input.tenantId, venueId: input.venueId }
    const report = await context.database.weeklyReport.findFirst({
      where: { id: input.reportId, ...scope },
      select: {
        id: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        title: true,
        content: true,
        answerCount: true,
        sessionCount: true,
        error: true,
        generatedAt: true,
        publishedAt: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    if (!report) throw new OperatorNotFoundError()
    const [configuration, dispatch, jobs, audits] = await Promise.all([
      context.database.venueReportConfiguration.findFirst({
        where: scope,
        select: { enabled: true, updatedBy: true, updatedAt: true },
      }),
      context.database.generationRequestDispatch.findFirst({
        where: { ...scope, weeklyReportId: report.id, kind: 'WEEKLY_REPORT' },
        select: { id: true, requestId: true, status: true, attempts: true, lastError: true },
      }),
      readReportJobs(context.database, input.tenantId, report.id, 10),
      context.database.auditLog.findMany({
        where: { tenantId: input.tenantId, targetType: 'WeeklyReport', targetId: report.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 25,
        select: { id: true, actorId: true, actorRole: true, action: true, createdAt: true },
      }),
    ])
    return {
      tenantId: input.tenantId,
      venueId: input.venueId,
      reportId: report.id,
      status: report.status,
      lifecycleStatus: simpleWeeklyReportStatus({
        reportStatus: report.status,
        dispatchStatus: dispatch?.status ?? null,
        jobStatus: jobs[0]?.status ?? null,
      }),
      version: report.updatedAt.toISOString(),
      title: operatorUntrustedText(report.title, 500),
      // The whole body: edits cap a report at 10,000 characters, inside the 20,000 contract limit.
      body: report.content === null ? null : operatorUntrustedText(report.content, 20_000),
      bodyChars: report.content?.length ?? 0,
      window: {
        start: report.weekStart.toISOString(),
        end: report.weekEnd.toISOString(),
        timeZone: null,
        note: 'The window is stored as two exact instants. Venues record no time zone, so no local date range is implied.',
      },
      denominators: {
        publicSessions: report.sessionCount,
        capturedAnswers: report.answerCount,
        definition: REPORT_DENOMINATOR_DEFINITION,
        totalMessages: 'unavailable' as const,
      },
      configuration: {
        enabled: configuration?.enabled ?? false,
        updatedBy: configuration?.updatedBy.slice(0, 191) ?? null,
        updatedAt: configuration?.updatedAt.toISOString() ?? null,
      },
      sources: {
        dispatchId: dispatch?.id ?? null,
        requestId: dispatch?.requestId ?? null,
        dispatchStatus: dispatch?.status ?? null,
        dispatchAttempts: dispatch?.attempts ?? null,
        dispatchLastError: dispatch?.lastError ? operatorUntrustedText(dispatch.lastError) : null,
        jobs: jobs.map(jobView),
        releaseId: null,
        releaseNote:
          'Reports do not record the release or model configuration that produced them. Use the job and dispatch ids as the generation reference.',
      },
      people: {
        author: report.createdBy.slice(0, 191),
        reviewers: audits
          .filter(
            (entry) =>
              entry.action === 'admin.report.edited' || entry.action === 'admin.report.published',
          )
          .map((entry) => ({
            actorId: entry.actorId.slice(0, 191),
            actorRole: entry.actorRole.slice(0, 60),
            action: entry.action.slice(0, 80),
            at: entry.createdAt.toISOString(),
          })),
        recipients: {
          state: 'unavailable' as const,
          note: 'Reports have no recipient list. Publishing shows the report in the portal; email delivery is not recorded here.',
        },
      },
      statusHistory: audits.map((entry) => ({
        auditId: entry.id,
        action: entry.action.slice(0, 80),
        actorId: entry.actorId.slice(0, 191),
        actorRole: entry.actorRole.slice(0, 60),
        at: entry.createdAt.toISOString(),
      })),
      error: report.error === null ? null : operatorUntrustedText(report.error),
      generatedAt: report.generatedAt?.toISOString() ?? null,
      publishedAt: report.publishedAt?.toISOString() ?? null,
      createdAt: report.createdAt.toISOString(),
      delivery: {
        state: 'not_modeled' as const,
        note: 'Publishing is not delivery. Nothing records that this report was sent to anyone.',
      },
    }
  },
}

/**
 * Classifies every long-GENERATING report from job, lease and dispatch evidence. The oldest are
 * listed first, so the page order is stable while reports are retried.
 */
export async function reconcileGeneratingReports(
  context: OperatorCallContext,
  input: Readonly<{
    tenantId: string
    venueId?: string | undefined
    minAgeMinutes: number
    cursor?: string | undefined
    limit: number
  }>,
) {
  const cutoff = new Date(context.now.getTime() - input.minAgeMinutes * 60_000)
  const base = {
    tenantId: input.tenantId,
    ...(input.venueId ? { venueId: input.venueId } : {}),
    status: 'GENERATING' as const,
    createdAt: { lte: cutoff },
  }
  const after = input.cursor === undefined ? null : decodeKeysetCursor(input.cursor)
  await requireCursorInScope(after?.id, (id) =>
    context.database.weeklyReport
      .findFirst({
        where: { ...base, id },
        select: { id: true, createdAt: true },
      })
      .then((row) => (row && row.createdAt.getTime() === after!.at.getTime() ? row : null)),
  )
  const rows = await context.database.weeklyReport.findMany({
    where: {
      ...base,
      ...(after
        ? {
            AND: [
              {
                OR: [
                  { createdAt: { gt: after.at } },
                  { createdAt: after.at, id: { gt: after.id } },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit + 1,
    select: {
      id: true,
      venueId: true,
      weekStart: true,
      weekEnd: true,
      createdAt: true,
      updatedAt: true,
      executionLeaseExpiresAt: true,
    },
  })
  const page = rows.slice(0, input.limit)
  const items = await Promise.all(
    page.map(async (row) => {
      const [dispatch, jobs] = await Promise.all([
        context.database.generationRequestDispatch.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: row.venueId,
            weeklyReportId: row.id,
            kind: 'WEEKLY_REPORT',
          },
          select: { status: true, attempts: true, lastError: true },
        }),
        readReportJobs(context.database, input.tenantId, row.id, 5),
      ])
      const latest = jobs[0] ?? null
      const verdict = classifyGeneratingReport({
        leaseExpiresAt: row.executionLeaseExpiresAt,
        latestJob: latest
          ? { id: latest.id, status: latest.status, failureDisposition: latest.failureDisposition }
          : null,
        jobCount: jobs.length,
        now: context.now,
      })
      return {
        reportId: row.id,
        venueId: row.venueId,
        weekStart: row.weekStart.toISOString(),
        weekEnd: row.weekEnd.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ageMinutes: Math.max(
          0,
          Math.floor((context.now.getTime() - row.createdAt.getTime()) / 60_000),
        ),
        classification: verdict.classification,
        reason: verdict.reason,
        evidence: {
          dispatchStatus: dispatch?.status ?? null,
          dispatchAttempts: dispatch?.attempts ?? null,
          dispatchLastError: dispatch?.lastError ? operatorUntrustedText(dispatch.lastError) : null,
          latestJob: latest ? jobView(latest) : null,
          leaseExpiresAt: row.executionLeaseExpiresAt?.toISOString() ?? null,
          leaseLive: verdict.leaseLive,
        },
        nextAction: verdict.nextAction,
        observedAt: context.now.toISOString(),
      }
    }),
  )
  return pageResult(
    items,
    rows.length > input.limit ? encodeKeysetCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : null,
  )
}

const reportsReconcileGenerating: OperatorReadTool = {
  name: 'reports.reconcile_generating',
  capability: 'reports:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['reports.reconcile_generating'].parse(raw)
    await assertTenantInGrant(context.grant, input.tenantId, context.database)
    if (input.venueId) {
      await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    }
    return reconcileGeneratingReports(context, input)
  },
}

export const reportReadTools: readonly OperatorReadTool[] = [
  reportsList,
  reportsGetStatus,
  reportsGet,
  reportsReconcileGenerating,
]
