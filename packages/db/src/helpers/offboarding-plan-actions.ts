import { createHash } from 'node:crypto'

import type { OffboardingExportKind, OffboardingRevocationTarget } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type OffboardingPlanHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}
export type OffboardingPlanActionClient = Pick<typeof db, '$transaction'>
export type OffboardingPlanActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class OffboardingPlanActionError extends Error {
  constructor(
    readonly code: OffboardingPlanActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OffboardingPlanActionError'
  }
}

export const offboardingPlanSummarySelect = {
  id: true,
  tenantId: true,
  requestId: true,
  status: true,
  revocationTargets: true,
  exportKinds: true,
  effectiveAt: true,
  requestedBy: true,
  requestedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { venueTargets: true } },
} as const

export type CreateOffboardingDraftInput = {
  tenantId: string
  requestId: string
  venueIds: string[]
  revocationTargets: OffboardingRevocationTarget[]
  exportKinds: OffboardingExportKind[]
  effectiveAt?: Date | undefined
  actor: OffboardingPlanHumanActor
}

const REVOCATION_TARGETS = new Set<string>([
  'GUEST_LINKS',
  'WIDGETS',
  'PARTNER_API_KEYS',
  'MCP_CREDENTIALS',
  'BACKGROUND_JOBS',
  'AGENT_IDENTITIES',
  'CLIENT_ACCESS',
  'OPERATOR_IMPERSONATION',
])
const EXPORT_KINDS = new Set<string>([
  'APPROVED_CONTENT',
  'CONTENT_HISTORY',
  'VENUE_PACKAGES',
  'CONFIGURATION',
  'AUDIT_HISTORY',
])

function invalid(message: string): never {
  throw new OffboardingPlanActionError('INVALID_INPUT', message)
}

function requireDistinctBoundedValues(
  field: string,
  values: readonly string[],
  minimum: number,
  maximum: number,
  allowedValues?: ReadonlySet<string>,
): void {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
    invalid(`${field} must contain between ${minimum} and ${maximum} values`)
  }
  if (
    values.some(
      (value) =>
        typeof value !== 'string' || !value || (allowedValues && !allowedValues.has(value)),
    )
  ) {
    invalid(`${field} contains an invalid value`)
  }
  if (new Set(values).size !== values.length) invalid(`${field} must not contain duplicates`)
}

function requireInput(input: CreateOffboardingDraftInput): void {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN' || !input.actor.id) {
    invalid('A human platform administrator is required')
  }
  if (typeof input.tenantId !== 'string' || !input.tenantId) invalid('Tenant is required')
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.requestId,
    )
  ) {
    invalid('A valid offboarding draft request ID is required')
  }
  requireDistinctBoundedValues('venueIds', input.venueIds, 1, 100)
  requireDistinctBoundedValues(
    'revocationTargets',
    input.revocationTargets,
    1,
    REVOCATION_TARGETS.size,
    REVOCATION_TARGETS,
  )
  requireDistinctBoundedValues('exportKinds', input.exportKinds, 0, EXPORT_KINDS.size, EXPORT_KINDS)
  if (
    input.effectiveAt !== undefined &&
    (!(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime()))
  ) {
    invalid('effectiveAt must be a valid date')
  }
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

/** Hashes only normalized planning intent. It never includes content, secrets, or retention policy. */
export function offboardingDraftRequestHash(
  input: Pick<
    CreateOffboardingDraftInput,
    'tenantId' | 'venueIds' | 'revocationTargets' | 'exportKinds' | 'effectiveAt'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tenantId: input.tenantId,
        venueIds: sorted(input.venueIds),
        revocationTargets: sorted(input.revocationTargets),
        exportKinds: sorted(input.exportKinds),
        effectiveAt: input.effectiveAt?.toISOString() ?? null,
      }),
    )
    .digest('hex')
}

async function lockRequest(tx: typeof db, tenantId: string, requestId: string): Promise<void> {
  const key = `offboarding-draft:${tenantId}:${requestId.toLowerCase()}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/**
 * Records reviewable offboarding intent only. It does not execute or schedule
 * revocation, produce exports, delete data, or apply retention policy.
 *
 * A caller-generated request UUID distinguishes an exact retry from a second
 * deliberate request. The normalized payload hash prevents key reuse for
 * different planning intent.
 */
export async function createOffboardingDraftAction(
  input: CreateOffboardingDraftInput,
  client: OffboardingPlanActionClient = db,
) {
  requireInput(input)
  const requestHash = offboardingDraftRequestHash(input)
  const venueIds = sorted(input.venueIds)
  const revocationTargets = sorted(input.revocationTargets) as OffboardingRevocationTarget[]
  const exportKinds = sorted(input.exportKinds) as OffboardingExportKind[]
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await lockRequest(tx, input.tenantId, input.requestId)
    const existing = await tx.offboardingPlan.findFirst({
      where: { tenantId: input.tenantId, requestId: input.requestId },
      select: { ...offboardingPlanSummarySelect, requestHash: true },
    })
    if (existing) {
      if (existing.requestHash !== requestHash || existing.requestedBy !== input.actor.id) {
        throw new OffboardingPlanActionError(
          'CONFLICT',
          'This offboarding request ID is already bound to different planning input or actor',
        )
      }
      const { requestHash: _requestHash, ...plan } = existing
      void _requestHash
      return { ...plan, replayed: true as const }
    }
    const venues = await tx.venue.findMany({
      where: { tenantId: input.tenantId, id: { in: venueIds } },
      select: { id: true },
    })
    const returnedVenueIds = new Set(venues.map(({ id }) => id))
    if (
      returnedVenueIds.size !== venueIds.length ||
      venueIds.some((venueId) => !returnedVenueIds.has(venueId))
    ) {
      throw new OffboardingPlanActionError(
        'NOT_FOUND',
        'One or more venues were not found in the requested tenant',
      )
    }

    const plan = await tx.offboardingPlan.create({
      data: {
        tenantId: input.tenantId,
        requestId: input.requestId,
        requestHash,
        status: 'REQUESTED',
        revocationTargets,
        exportKinds,
        ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
        requestedBy: input.actor.id,
        venueTargets: {
          create: venueIds.map((venueId) => ({ tenantId: input.tenantId, venueId })),
        },
      },
      select: offboardingPlanSummarySelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-plan.draft-created',
        targetType: 'OffboardingPlan',
        targetId: plan.id,
        afterState: {
          status: 'REQUESTED',
          requestId: input.requestId,
          venueCount: venueIds.length,
          revocationTargets,
          exportKinds,
        },
      },
      tx,
    )
    return { ...plan, replayed: false as const }
  })
}
