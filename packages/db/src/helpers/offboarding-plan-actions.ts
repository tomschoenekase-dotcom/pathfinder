import type { OffboardingExportKind, OffboardingRevocationTarget } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type OffboardingPlanHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}
export type OffboardingPlanActionClient = Pick<typeof db, '$transaction'>
export type OffboardingPlanActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT'

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

/**
 * Records reviewable offboarding intent only. It does not execute or schedule
 * revocation, produce exports, delete data, or apply retention policy.
 *
 * The current schema has no request key, so callers cannot safely retry after
 * an ambiguous transaction outcome. Adding inferred replay semantics based on
 * plan contents would risk collapsing two deliberate requests.
 */
export async function createOffboardingDraftAction(
  input: CreateOffboardingDraftInput,
  client: OffboardingPlanActionClient = db,
) {
  requireInput(input)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const venues = await tx.venue.findMany({
      where: { tenantId: input.tenantId, id: { in: input.venueIds } },
      select: { id: true },
    })
    const returnedVenueIds = new Set(venues.map(({ id }) => id))
    if (
      returnedVenueIds.size !== input.venueIds.length ||
      input.venueIds.some((venueId) => !returnedVenueIds.has(venueId))
    ) {
      throw new OffboardingPlanActionError(
        'NOT_FOUND',
        'One or more venues were not found in the requested tenant',
      )
    }

    const plan = await tx.offboardingPlan.create({
      data: {
        tenantId: input.tenantId,
        status: 'REQUESTED',
        revocationTargets: input.revocationTargets,
        exportKinds: input.exportKinds,
        ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
        requestedBy: input.actor.id,
        venueTargets: {
          create: input.venueIds.map((venueId) => ({ tenantId: input.tenantId, venueId })),
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
          venueCount: input.venueIds.length,
          revocationTargets: input.revocationTargets,
          exportKinds: input.exportKinds,
        },
      },
      tx,
    )
    return plan
  })
}
