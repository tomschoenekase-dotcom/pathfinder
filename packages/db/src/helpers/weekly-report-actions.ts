import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockVenueReportMutation } from './venue-content-lock'

export type WeeklyReportHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}
export type WeeklyReportActionClient = Pick<typeof db, '$transaction'>
export type WeeklyReportActionErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATUS'
  | 'INVALID_INPUT'
  | 'PRECONDITION_FAILED'

export class WeeklyReportActionError extends Error {
  constructor(
    readonly code: WeeklyReportActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WeeklyReportActionError'
  }
}

export const weeklyReportConfigurationSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  enabled: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

type Scope = { tenantId: string; venueId: string; actor: WeeklyReportHumanActor }

function requireActor(actor: WeeklyReportHumanActor): void {
  if (!actor || actor.type !== 'HUMAN' || !actor.id || actor.role !== 'PLATFORM_ADMIN') {
    throw new WeeklyReportActionError('INVALID_INPUT', 'A human platform administrator is required')
  }
}

function requireScope(input: Scope): void {
  requireActor(input.actor)
  if (
    typeof input.tenantId !== 'string' ||
    !input.tenantId ||
    typeof input.venueId !== 'string' ||
    !input.venueId
  ) {
    throw new WeeklyReportActionError('INVALID_INPUT', 'Tenant and venue are required')
  }
}

function requireRevision(value: Date | null): void {
  if (value !== null && (!(value instanceof Date) || Number.isNaN(value.getTime()))) {
    throw new WeeklyReportActionError('INVALID_INPUT', 'A valid expected revision is required')
  }
}

function conflict(message: string): never {
  throw new WeeklyReportActionError('CONFLICT', message)
}

function nextRevision(previous?: Date): Date {
  return new Date(previous ? Math.max(Date.now(), previous.getTime() + 1) : Date.now())
}

async function prepare(tx: typeof db, input: Scope): Promise<void> {
  requireScope(input)
  await lockVenueReportMutation(tx, input)
  const venue = await tx.venue.findFirst({
    where: { id: input.venueId, tenantId: input.tenantId },
    select: { id: true },
  })
  if (!venue) throw new WeeklyReportActionError('NOT_FOUND', 'Venue not found')
}

function disabledDefault(input: Scope) {
  return {
    id: null,
    tenantId: input.tenantId,
    venueId: input.venueId,
    enabled: false,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
  }
}

export async function updateWeeklyReportConfigurationAction(
  input: Scope & { enabled: boolean; expectedUpdatedAt: Date | null },
  client: WeeklyReportActionClient = db,
) {
  requireScope(input)
  requireRevision(input.expectedUpdatedAt)
  if (typeof input.enabled !== 'boolean') {
    throw new WeeklyReportActionError('INVALID_INPUT', 'Enabled must be a boolean')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const before = await tx.venueReportConfiguration.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: weeklyReportConfigurationSelect,
    })
    if (!before && input.expectedUpdatedAt !== null) {
      conflict('Report configuration changed; refresh and try again.')
    }
    if (
      before &&
      (input.expectedUpdatedAt === null ||
        before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
    ) {
      conflict('Report configuration changed; refresh and try again.')
    }
    if (before?.enabled === input.enabled || (!before && !input.enabled)) {
      return { ...(before ?? disabledDefault(input)), replayed: true as const }
    }

    const updatedAt = nextRevision(before?.updatedAt)
    let configuration
    if (before) {
      const changed = await tx.venueReportConfiguration.updateMany({
        where: {
          id: before.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          updatedAt: input.expectedUpdatedAt!,
        },
        data: { enabled: input.enabled, updatedBy: input.actor.id, updatedAt },
      })
      if (changed.count !== 1) conflict('Report configuration changed; refresh and try again.')
      configuration = await tx.venueReportConfiguration.findFirst({
        where: { id: before.id, tenantId: input.tenantId, venueId: input.venueId },
        select: weeklyReportConfigurationSelect,
      })
      if (!configuration) conflict('Report configuration changed; refresh and try again.')
    } else {
      configuration = await tx.venueReportConfiguration.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          enabled: true,
          updatedBy: input.actor.id,
          updatedAt,
        },
        select: weeklyReportConfigurationSelect,
      })
    }

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: configuration.enabled
          ? 'admin.venue-reports.enabled'
          : 'admin.venue-reports.disabled',
        targetType: 'VenueReportConfiguration',
        targetId: configuration.id,
        beforeState: { enabled: before?.enabled === true },
        afterState: { enabled: configuration.enabled },
      },
      tx,
    )
    return { ...configuration, replayed: false as const }
  })
}

export async function updateWeeklyReportDraftAction(
  input: Scope & {
    reportId: string
    expectedUpdatedAt: Date
    title?: string
    content: string
  },
  client: WeeklyReportActionClient = db,
) {
  requireScope(input)
  requireRevision(input.expectedUpdatedAt)
  if (
    typeof input.reportId !== 'string' ||
    !input.reportId ||
    typeof input.content !== 'string' ||
    input.content.length < 1 ||
    input.content.length > 10_000
  ) {
    throw new WeeklyReportActionError('INVALID_INPUT', 'Valid report content is required')
  }
  if (
    input.title !== undefined &&
    (typeof input.title !== 'string' || input.title.length < 1 || input.title.length > 200)
  ) {
    throw new WeeklyReportActionError('INVALID_INPUT', 'Report title must be 1 to 200 characters')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const existing = await tx.weeklyReport.findFirst({
      where: { id: input.reportId, tenantId: input.tenantId, venueId: input.venueId },
      select: { status: true, updatedAt: true },
    })
    if (!existing) throw new WeeklyReportActionError('NOT_FOUND', 'Report not found')
    if (existing.status !== 'DRAFT') {
      throw new WeeklyReportActionError('INVALID_STATUS', 'Only a draft report can be edited.')
    }
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      conflict('This report was edited elsewhere. Reload it before saving again.')
    }
    const updatedAt = nextRevision(existing.updatedAt)
    const changed = await tx.weeklyReport.updateMany({
      where: {
        id: input.reportId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'DRAFT',
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        content: input.content,
        updatedAt,
        ...(input.title !== undefined ? { title: input.title } : {}),
      },
    })
    if (changed.count !== 1) conflict('Report state changed before the draft could be saved.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.report.edited',
        targetType: 'WeeklyReport',
        targetId: input.reportId,
        beforeState: { status: existing.status, updatedAt: existing.updatedAt.toISOString() },
        afterState: { status: 'DRAFT', updatedAt: updatedAt.toISOString() },
      },
      tx,
    )
    return { ok: true as const, updatedAt: updatedAt.toISOString() }
  })
}

export async function publishWeeklyReportAction(
  input: Scope & { reportId: string; expectedUpdatedAt: Date },
  client: WeeklyReportActionClient = db,
) {
  requireScope(input)
  requireRevision(input.expectedUpdatedAt)
  if (typeof input.reportId !== 'string' || !input.reportId) {
    throw new WeeklyReportActionError('INVALID_INPUT', 'Report ID is required')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const configuration = await tx.venueReportConfiguration.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: { enabled: true },
    })
    if (configuration?.enabled !== true) {
      throw new WeeklyReportActionError(
        'PRECONDITION_FAILED',
        'Weekly reports are disabled for this venue.',
      )
    }
    const existing = await tx.weeklyReport.findFirst({
      where: { id: input.reportId, tenantId: input.tenantId, venueId: input.venueId },
      select: { status: true, content: true, updatedAt: true },
    })
    if (!existing) throw new WeeklyReportActionError('NOT_FOUND', 'Report not found')
    if (existing.status !== 'DRAFT') {
      throw new WeeklyReportActionError('INVALID_STATUS', 'Only a draft report can be published.')
    }
    if (!existing.content) {
      throw new WeeklyReportActionError('INVALID_INPUT', 'Report has no content to publish.')
    }
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      conflict('This report changed after review. Reload it before publishing.')
    }
    const publishedAt = new Date()
    const changed = await tx.weeklyReport.updateMany({
      where: {
        id: input.reportId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'DRAFT',
        updatedAt: input.expectedUpdatedAt,
      },
      data: { status: 'PUBLISHED', publishedAt },
    })
    if (changed.count !== 1) conflict('Report state changed before it could be published.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.report.published',
        targetType: 'WeeklyReport',
        targetId: input.reportId,
        beforeState: { status: existing.status, updatedAt: existing.updatedAt.toISOString() },
        afterState: { status: 'PUBLISHED', publishedAt: publishedAt.toISOString() },
      },
      tx,
    )
    return { ok: true as const }
  })
}
