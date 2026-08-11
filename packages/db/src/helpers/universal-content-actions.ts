import type {
  GeneralizedContentPayload,
  GeneralizedContentRevisionDraft,
} from '@pathfinder/contracts/universal-content-actions'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type UniversalContentHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type UniversalContentActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class UniversalContentActionError extends Error {
  constructor(
    readonly code: UniversalContentActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'UniversalContentActionError'
  }
}

export type UniversalContentActionClient = Pick<typeof db, '$transaction'>

export type UniversalContentPreview = {
  lifecycle: 'SCHEDULED' | 'EFFECTIVE' | 'ENDED'
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  guestVisible: false
  clientVisible: false
  requiresExplicitPublication: true
  effectiveFrom: string | null
  effectiveUntil: string | null
}

export type UniversalContentActionResult = {
  moduleId: string
  revisionId: string
  kind: GeneralizedContentPayload['kind']
  version: number
  preview: UniversalContentPreview
}

function assertActor(actor: UniversalContentHumanActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'A signed-in human platform administrator is required.',
    )
  }
}

function optionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null
}

export function buildUniversalContentPreview(
  draft: Pick<GeneralizedContentRevisionDraft, 'audience' | 'effectiveFrom' | 'effectiveUntil'>,
  now = new Date(),
): UniversalContentPreview {
  const from = optionalDate(draft.effectiveFrom)
  const until = optionalDate(draft.effectiveUntil)
  let lifecycle: UniversalContentPreview['lifecycle'] = 'EFFECTIVE'
  if (from && from.getTime() > now.getTime()) lifecycle = 'SCHEDULED'
  if (until && until.getTime() <= now.getTime()) lifecycle = 'ENDED'
  return {
    lifecycle,
    audience: draft.audience,
    guestVisible: false,
    clientVisible: false,
    requiresExplicitPublication: true,
    effectiveFrom: from?.toISOString() ?? null,
    effectiveUntil: until?.toISOString() ?? null,
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function assertVenueScope(
  tx: Parameters<Parameters<UniversalContentActionClient['$transaction']>[0]>[0],
  tenantId: string,
  venueId: string,
): Promise<void> {
  const venue = await tx.venue.findFirst({
    where: { id: venueId, tenantId },
    select: { id: true },
  })
  if (!venue) throw new UniversalContentActionError('NOT_FOUND', 'Venue not found.')
}

async function assertPayloadReferences(
  tx: Parameters<Parameters<UniversalContentActionClient['$transaction']>[0]>[0],
  scope: { tenantId: string; venueId: string; moduleId?: string },
  payload: GeneralizedContentPayload,
): Promise<void> {
  if ((payload.kind === 'SERVICE' || payload.kind === 'EVENT') && payload.placeId) {
    const place = await tx.place.findFirst({
      where: { id: payload.placeId, tenantId: scope.tenantId, venueId: scope.venueId },
      select: { id: true },
    })
    if (!place) {
      throw new UniversalContentActionError(
        'INVALID_INPUT',
        'The selected compatibility Place is outside this venue.',
      )
    }
  }
  if (payload.kind !== 'RELATIONSHIP') return
  if (
    payload.fromModuleId === payload.toModuleId ||
    (scope.moduleId &&
      (payload.fromModuleId === scope.moduleId || payload.toModuleId === scope.moduleId))
  ) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'A relationship revision must connect two other distinct modules.',
    )
  }
  const endpoints = await tx.contentModuleIdentity.findMany({
    where: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      id: { in: [payload.fromModuleId, payload.toModuleId] },
    },
    select: { id: true },
  })
  if (endpoints.length !== 2) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'Both relationship endpoints must exist in this exact tenant and venue.',
    )
  }
}

async function insertPayload(
  tx: Parameters<Parameters<UniversalContentActionClient['$transaction']>[0]>[0],
  scope: { tenantId: string; venueId: string; revisionId: string },
  payload: GeneralizedContentPayload,
): Promise<void> {
  const common = { revisionId: scope.revisionId, tenantId: scope.tenantId, venueId: scope.venueId }
  switch (payload.kind) {
    case 'SERVICE':
      await tx.serviceContent.create({
        data: {
          ...common,
          name: payload.name,
          description: payload.description ?? null,
          availability: payload.availability ?? null,
          placeId: payload.placeId ?? null,
        },
      })
      return
    case 'POLICY':
      await tx.policyContent.create({
        data: { ...common, title: payload.title, rule: payload.rule, appliesTo: payload.appliesTo },
      })
      return
    case 'EVENT':
      await tx.eventContent.create({
        data: {
          ...common,
          name: payload.name,
          description: payload.description ?? null,
          startsAt: new Date(payload.startsAt),
          endsAt: optionalDate(payload.endsAt),
          placeId: payload.placeId ?? null,
        },
      })
      return
    case 'OPERATIONAL_FACT':
      await tx.operationalFactContent.create({
        data: {
          ...common,
          label: payload.label,
          value: payload.value,
          expiresAt: optionalDate(payload.expiresAt),
        },
      })
      return
    case 'RELATIONSHIP':
      await tx.relationshipContent.create({
        data: {
          ...common,
          fromModuleId: payload.fromModuleId,
          toModuleId: payload.toModuleId,
          relationshipType: payload.relationshipType,
          description: payload.description ?? null,
        },
      })
  }
}

async function insertRevision(
  tx: Parameters<Parameters<UniversalContentActionClient['$transaction']>[0]>[0],
  input: {
    tenantId: string
    venueId: string
    moduleId: string
    version: number
    draft: GeneralizedContentRevisionDraft
    actor: UniversalContentHumanActor
  },
): Promise<UniversalContentActionResult> {
  await assertPayloadReferences(tx, input, input.draft.payload)
  const revision = await tx.contentModuleRevision.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      moduleId: input.moduleId,
      kind: input.draft.payload.kind,
      version: input.version,
      audience: input.draft.audience,
      effectiveFrom: optionalDate(input.draft.effectiveFrom),
      effectiveUntil: optionalDate(input.draft.effectiveUntil),
      createdBy: input.actor.id,
    },
    select: { id: true },
  })
  await insertPayload(tx, { ...input, revisionId: revision.id }, input.draft.payload)
  if (input.draft.evidence.length) {
    await tx.contentModuleEvidence.createMany({
      data: input.draft.evidence.map((evidence) => ({
        tenantId: input.tenantId,
        venueId: input.venueId,
        revisionId: revision.id,
        moduleKind: input.draft.payload.kind,
        sourceId: evidence.sourceId,
        locator: evidence.locator ?? null,
        capturedAt: new Date(evidence.capturedAt),
        excerptHash: evidence.excerptHash ?? null,
      })),
    })
  }
  return {
    moduleId: input.moduleId,
    revisionId: revision.id,
    kind: input.draft.payload.kind,
    version: input.version,
    preview: buildUniversalContentPreview(input.draft),
  }
}

export async function createUniversalContentAction(input: {
  db?: UniversalContentActionClient
  tenantId: string
  venueId: string
  moduleId: string
  draft: GeneralizedContentRevisionDraft
  actor: UniversalContentHumanActor
}): Promise<UniversalContentActionResult> {
  assertActor(input.actor)
  try {
    return await (input.db ?? db).$transaction(async (tx) => {
      await assertVenueScope(tx, input.tenantId, input.venueId)
      const identity = await tx.contentModuleIdentity.create({
        data: {
          id: input.moduleId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          kind: input.draft.payload.kind,
        },
        select: { id: true },
      })
      const result = await insertRevision(tx, { ...input, moduleId: identity.id, version: 1 })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'universal_content.created',
          targetType: 'ContentModuleIdentity',
          targetId: identity.id,
          afterState: {
            venueId: input.venueId,
            revisionId: result.revisionId,
            version: result.version,
            kind: result.kind,
            audience: input.draft.audience,
            source: 'HUMAN_OPERATOR',
            publication: 'NOT_PUBLISHED',
            requestKey: input.moduleId,
          },
        },
        tx,
      )
      return result
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new UniversalContentActionError(
        'CONFLICT',
        `Creation request ${input.moduleId} already exists or completed; refresh before retrying.`,
      )
    }
    throw error
  }
}

export async function addUniversalContentRevisionAction(input: {
  db?: UniversalContentActionClient
  tenantId: string
  venueId: string
  moduleId: string
  expectedLatestVersion: number
  draft: GeneralizedContentRevisionDraft
  actor: UniversalContentHumanActor
}): Promise<UniversalContentActionResult> {
  assertActor(input.actor)
  try {
    return await (input.db ?? db).$transaction(async (tx) => {
      await assertVenueScope(tx, input.tenantId, input.venueId)
      const identity = await tx.contentModuleIdentity.findFirst({
        where: { id: input.moduleId, tenantId: input.tenantId, venueId: input.venueId },
        select: {
          id: true,
          kind: true,
          revisions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
        },
      })
      if (!identity) throw new UniversalContentActionError('NOT_FOUND', 'Content module not found.')
      const latest = identity.revisions[0]?.version
      if (latest !== input.expectedLatestVersion) {
        throw new UniversalContentActionError(
          'CONFLICT',
          `Latest version is ${latest ?? 'missing'}, not ${input.expectedLatestVersion}.`,
        )
      }
      if (identity.kind !== input.draft.payload.kind) {
        throw new UniversalContentActionError('INVALID_INPUT', 'A module kind cannot be changed.')
      }
      const result = await insertRevision(tx, {
        ...input,
        version: input.expectedLatestVersion + 1,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'universal_content.revision_added',
          targetType: 'ContentModuleIdentity',
          targetId: input.moduleId,
          beforeState: { latestVersion: input.expectedLatestVersion },
          afterState: {
            venueId: input.venueId,
            revisionId: result.revisionId,
            latestVersion: result.version,
            kind: result.kind,
            audience: input.draft.audience,
            source: 'HUMAN_OPERATOR',
            publication: 'NOT_PUBLISHED',
          },
        },
        tx,
      )
      return result
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new UniversalContentActionError(
        'CONFLICT',
        'The module changed while you were editing.',
      )
    }
    throw error
  }
}

type LatestRevision = {
  version: number
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  effectiveFrom: Date | null
  service: {
    name: string
    description: string | null
    availability: string | null
    placeId: string | null
  } | null
  policy: { title: string; rule: string; appliesTo: string[] } | null
  event: {
    name: string
    description: string | null
    startsAt: Date
    endsAt: Date | null
    placeId: string | null
  } | null
  operationalFact: { label: string; value: string; expiresAt: Date | null } | null
  relationship: {
    fromModuleId: string
    toModuleId: string
    relationshipType: string
    description: string | null
  } | null
}

function payloadFromLatest(
  kind: GeneralizedContentPayload['kind'],
  latest: LatestRevision,
): GeneralizedContentPayload {
  if (kind === 'SERVICE' && latest.service) return { kind, ...latest.service }
  if (kind === 'POLICY' && latest.policy) return { kind, ...latest.policy }
  if (kind === 'EVENT' && latest.event) {
    return {
      kind,
      ...latest.event,
      startsAt: latest.event.startsAt.toISOString(),
      endsAt: latest.event.endsAt?.toISOString() ?? null,
    }
  }
  if (kind === 'OPERATIONAL_FACT' && latest.operationalFact) {
    return {
      kind,
      ...latest.operationalFact,
      expiresAt: latest.operationalFact.expiresAt?.toISOString() ?? null,
    }
  }
  if (kind === 'RELATIONSHIP' && latest.relationship) return { kind, ...latest.relationship }
  throw new UniversalContentActionError(
    'CONFLICT',
    'Latest revision has no matching typed payload.',
  )
}

export async function retireUniversalContentAction(input: {
  db?: UniversalContentActionClient
  tenantId: string
  venueId: string
  moduleId: string
  expectedLatestVersion: number
  effectiveUntil: string
  evidence: GeneralizedContentRevisionDraft['evidence']
  actor: UniversalContentHumanActor
}): Promise<UniversalContentActionResult> {
  assertActor(input.actor)
  try {
    return await (input.db ?? db).$transaction(async (tx) => {
      await assertVenueScope(tx, input.tenantId, input.venueId)
      const identity = await tx.contentModuleIdentity.findFirst({
        where: { id: input.moduleId, tenantId: input.tenantId, venueId: input.venueId },
        select: {
          id: true,
          kind: true,
          revisions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: {
              version: true,
              audience: true,
              effectiveFrom: true,
              service: true,
              policy: true,
              event: true,
              operationalFact: true,
              relationship: true,
            },
          },
        },
      })
      if (!identity) throw new UniversalContentActionError('NOT_FOUND', 'Content module not found.')
      const latest = identity.revisions[0] as LatestRevision | undefined
      if (!latest || latest.version !== input.expectedLatestVersion) {
        throw new UniversalContentActionError(
          'CONFLICT',
          `Latest version is ${latest?.version ?? 'missing'}, not ${input.expectedLatestVersion}.`,
        )
      }
      if (latest.effectiveFrom && new Date(input.effectiveUntil) <= latest.effectiveFrom) {
        throw new UniversalContentActionError(
          'INVALID_INPUT',
          'Retirement boundary must be after the effective start.',
        )
      }
      const draft: GeneralizedContentRevisionDraft = {
        audience: latest.audience,
        effectiveFrom: latest.effectiveFrom?.toISOString() ?? null,
        effectiveUntil: input.effectiveUntil,
        evidence: input.evidence,
        payload: payloadFromLatest(identity.kind as GeneralizedContentPayload['kind'], latest),
      }
      const result = await insertRevision(tx, {
        ...input,
        draft,
        version: input.expectedLatestVersion + 1,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'universal_content.retired',
          targetType: 'ContentModuleIdentity',
          targetId: input.moduleId,
          beforeState: { latestVersion: input.expectedLatestVersion },
          afterState: {
            venueId: input.venueId,
            revisionId: result.revisionId,
            latestVersion: result.version,
            effectiveUntil: input.effectiveUntil,
            source: 'HUMAN_OPERATOR',
            publication: 'NOT_PUBLISHED',
          },
        },
        tx,
      )
      return result
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new UniversalContentActionError(
        'CONFLICT',
        'The module changed while you were editing.',
      )
    }
    throw error
  }
}
