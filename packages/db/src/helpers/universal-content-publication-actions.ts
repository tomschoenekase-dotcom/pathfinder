import type { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockVenueContentMutation } from './venue-content-lock'
import {
  UniversalContentActionError,
  type UniversalContentActionClient,
  type UniversalContentHumanActor,
} from './universal-content-actions'

export type UniversalContentPublicationResult = {
  publicationId: string
  moduleId: string
  revisionId: string
  action: 'PUBLISH' | 'WITHDRAW'
  replayed: boolean
}

type PublicationActionClient = UniversalContentActionClient

function assertActor(actor: unknown): asserts actor is UniversalContentHumanActor {
  if (
    typeof actor !== 'object' ||
    actor === null ||
    !('type' in actor) ||
    actor.type !== 'HUMAN' ||
    !('role' in actor) ||
    actor.role !== 'PLATFORM_ADMIN' ||
    !('id' in actor) ||
    typeof actor.id !== 'string' ||
    !actor.id.trim()
  ) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'A signed-in human platform administrator is required.',
    )
  }
}

function assertPublicationInput(input: unknown): asserts input is PublicationInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('tenantId' in input) ||
    typeof input.tenantId !== 'string' ||
    !input.tenantId.trim() ||
    !('venueId' in input) ||
    typeof input.venueId !== 'string' ||
    !input.venueId.trim() ||
    !('moduleId' in input) ||
    typeof input.moduleId !== 'string' ||
    !input.moduleId.trim() ||
    !('db' in input) ||
    typeof input.db !== 'object' ||
    input.db === null ||
    !('$transaction' in input.db) ||
    typeof input.db.$transaction !== 'function'
  ) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'Exact tenant, venue, and module scope is required.',
    )
  }
  if (
    !('requestId' in input) ||
    typeof input.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId,
    )
  ) {
    throw new UniversalContentActionError('INVALID_INPUT', 'Publication request ID must be a UUID.')
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

type PublicationInput = {
  db: PublicationActionClient
  tenantId: string
  venueId: string
  moduleId: string
  requestId: string
  actor: UniversalContentHumanActor
}

function replayResult(
  existing: {
    id: string
    venueId: string
    moduleId: string
    revisionId: string
    action: 'PUBLISH' | 'WITHDRAW'
    actorId: string
  },
  expected: {
    venueId: string
    moduleId: string
    revisionId: string
    action: 'PUBLISH' | 'WITHDRAW'
    actorId: string
  },
): UniversalContentPublicationResult {
  if (
    existing.venueId !== expected.venueId ||
    existing.moduleId !== expected.moduleId ||
    existing.revisionId !== expected.revisionId ||
    existing.action !== expected.action ||
    existing.actorId !== expected.actorId
  ) {
    throw new UniversalContentActionError(
      'CONFLICT',
      'This publication request key belongs to a different action.',
    )
  }
  return {
    publicationId: existing.id,
    moduleId: expected.moduleId,
    revisionId: expected.revisionId,
    action: expected.action,
    replayed: true,
  }
}

async function replayAfterUniqueRace(
  client: PublicationActionClient,
  input: PublicationInput,
  expected: { revisionId: string; action: 'PUBLISH' | 'WITHDRAW' },
): Promise<UniversalContentPublicationResult> {
  const existing = await (client as typeof db).contentModulePublication.findFirst({
    where: { tenantId: input.tenantId, requestId: input.requestId },
    select: {
      id: true,
      venueId: true,
      moduleId: true,
      revisionId: true,
      action: true,
      actorId: true,
    },
  })
  if (!existing) {
    throw new UniversalContentActionError('CONFLICT', 'The publication state changed concurrently.')
  }
  return replayResult(existing, {
    venueId: input.venueId,
    moduleId: input.moduleId,
    revisionId: expected.revisionId,
    action: expected.action,
    actorId: input.actor.id,
  })
}

export async function publishUniversalContentAction(
  input: PublicationInput & {
    revisionId: string
    expectedLatestVersion: number
  },
): Promise<UniversalContentPublicationResult> {
  assertPublicationInput(input)
  assertActor(input.actor)
  if (
    typeof input.revisionId !== 'string' ||
    !input.revisionId.trim() ||
    !Number.isInteger(input.expectedLatestVersion) ||
    input.expectedLatestVersion < 1
  ) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'An exact positive revision version is required.',
    )
  }
  try {
    return await input.db.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, input)
      const existingRequest = await tx.contentModulePublication.findFirst({
        where: { tenantId: input.tenantId, requestId: input.requestId },
        select: {
          id: true,
          venueId: true,
          moduleId: true,
          revisionId: true,
          action: true,
          actorId: true,
        },
      })
      if (existingRequest) {
        return replayResult(existingRequest, {
          venueId: input.venueId,
          moduleId: input.moduleId,
          revisionId: input.revisionId,
          action: 'PUBLISH',
          actorId: input.actor.id,
        })
      }
      const revision = await tx.contentModuleRevision.findFirst({
        where: {
          id: input.revisionId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          moduleId: input.moduleId,
          version: input.expectedLatestVersion,
        },
        select: { id: true, moduleId: true, kind: true, version: true, audience: true },
      })
      if (!revision) {
        throw new UniversalContentActionError(
          'CONFLICT',
          'The selected content revision is no longer the expected module version.',
        )
      }
      if (revision.audience !== 'PUBLIC') {
        throw new UniversalContentActionError(
          'INVALID_INPUT',
          'Only a PUBLIC revision may be explicitly published to guests.',
        )
      }
      const latest = await tx.contentModuleRevision.findFirst({
        where: { tenantId: input.tenantId, venueId: input.venueId, moduleId: input.moduleId },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      })
      if (!latest || latest.id !== revision.id || latest.version !== input.expectedLatestVersion) {
        throw new UniversalContentActionError('CONFLICT', 'A newer module revision exists.')
      }
      const publication = await tx.contentModulePublication.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          moduleId: input.moduleId,
          revisionId: revision.id,
          moduleKind: revision.kind,
          action: 'PUBLISH',
          requestId: input.requestId,
          actorId: input.actor.id,
        },
        select: { id: true },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'universal_content.published',
          targetType: 'ContentModuleIdentity',
          targetId: input.moduleId,
          beforeState: { guestPublication: 'NOT_PUBLISHED' },
          afterState: {
            venueId: input.venueId,
            revisionId: revision.id,
            version: revision.version,
            guestPublication: 'PUBLISHED',
          },
        },
        tx,
      )
      return {
        publicationId: publication.id,
        moduleId: input.moduleId,
        revisionId: revision.id,
        action: 'PUBLISH' as const,
        replayed: false,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return replayAfterUniqueRace(input.db, input, {
        revisionId: input.revisionId,
        action: 'PUBLISH',
      })
    }
    throw error
  }
}

export async function withdrawUniversalContentAction(
  input: PublicationInput & { expectedPublishedRevisionId: string },
): Promise<UniversalContentPublicationResult> {
  assertPublicationInput(input)
  assertActor(input.actor)
  if (
    typeof input.expectedPublishedRevisionId !== 'string' ||
    !input.expectedPublishedRevisionId.trim()
  ) {
    throw new UniversalContentActionError(
      'INVALID_INPUT',
      'The expected published revision is required.',
    )
  }
  try {
    return await input.db.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, input)
      const existingRequest = await tx.contentModulePublication.findFirst({
        where: { tenantId: input.tenantId, requestId: input.requestId },
        select: {
          id: true,
          venueId: true,
          moduleId: true,
          revisionId: true,
          action: true,
          actorId: true,
        },
      })
      if (existingRequest) {
        return replayResult(existingRequest, {
          venueId: input.venueId,
          moduleId: input.moduleId,
          revisionId: input.expectedPublishedRevisionId,
          action: 'WITHDRAW',
          actorId: input.actor.id,
        })
      }
      const current = await tx.contentModulePublication.findFirst({
        where: { tenantId: input.tenantId, venueId: input.venueId, moduleId: input.moduleId },
        orderBy: { eventOrder: 'desc' },
        select: { action: true, revisionId: true, moduleKind: true },
      })
      if (
        !current ||
        current.action !== 'PUBLISH' ||
        current.revisionId !== input.expectedPublishedRevisionId
      ) {
        throw new UniversalContentActionError(
          'CONFLICT',
          'The module is not published at the expected revision.',
        )
      }
      const publication = await tx.contentModulePublication.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          moduleId: input.moduleId,
          revisionId: current.revisionId,
          moduleKind: current.moduleKind,
          action: 'WITHDRAW',
          requestId: input.requestId,
          actorId: input.actor.id,
        },
        select: { id: true },
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'universal_content.withdrawn',
          targetType: 'ContentModuleIdentity',
          targetId: input.moduleId,
          beforeState: { venueId: input.venueId, revisionId: current.revisionId },
          afterState: { venueId: input.venueId, guestPublication: 'WITHDRAWN' },
        },
        tx,
      )
      return {
        publicationId: publication.id,
        moduleId: input.moduleId,
        revisionId: current.revisionId,
        action: 'WITHDRAW' as const,
        replayed: false,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return replayAfterUniqueRace(input.db, input, {
        revisionId: input.expectedPublishedRevisionId,
        action: 'WITHDRAW',
      })
    }
    throw error
  }
}

export type EffectivePublishedUniversalContent = {
  moduleId: string
  revisionId: string
  kind: GeneralizedContentPayload['kind']
  version: number
  payload: GeneralizedContentPayload
}

// Prisma's extended transaction client does not expose a stable public raw-query type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UniversalContentResolverClient = any
type PublishedHead = { moduleId: string; revisionId: string }
type ResolverRevision = {
  id: string
  moduleId: string
  kind: GeneralizedContentPayload['kind']
  version: number
  audience: string
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  item: null | {
    name: string
    description: string | null
    placeId: string | null
    itemType: string
  }
  service: null | {
    name: string
    description: string | null
    availability: string | null
    placeId: string | null
  }
  policy: null | { title: string; rule: string; appliesTo: string[] }
  event: null | {
    name: string
    description: string | null
    startsAt: Date
    endsAt: Date | null
    placeId: string | null
  }
  operationalFact: null | { label: string; value: string; expiresAt: Date | null }
  relationship: null | {
    fromModuleId: string
    toModuleId: string
    relationshipType: string
    description: string | null
  }
}

export class UniversalContentResolverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UniversalContentResolverError'
  }
}

export async function resolveEffectivePublishedUniversalContent(params: {
  db: UniversalContentResolverClient
  tenantId: string
  venueId: string
  asOf?: Date
  maximumModules?: number
}): Promise<EffectivePublishedUniversalContent[]> {
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof params.tenantId !== 'string' ||
    !params.tenantId.trim() ||
    typeof params.venueId !== 'string' ||
    !params.venueId.trim() ||
    typeof params.db !== 'object' ||
    params.db === null
  ) {
    throw new UniversalContentResolverError('Exact tenant and venue scope is required.')
  }
  const asOf = params.asOf ?? new Date()
  const maximumModules = params.maximumModules ?? 100
  if (
    !(asOf instanceof Date) ||
    !Number.isFinite(asOf.getTime()) ||
    !Number.isInteger(maximumModules) ||
    maximumModules < 1 ||
    maximumModules > 100
  ) {
    throw new UniversalContentResolverError('Maximum published modules must be between 1 and 100.')
  }
  const client = params.db
  const heads = (await client.$queryRaw`
    SELECT latest."module_id" AS "moduleId", latest."revision_id" AS "revisionId"
    FROM (
      SELECT DISTINCT ON (publication."module_id")
        publication."module_id",
        publication."revision_id",
        publication."action",
        publication."event_order"
      FROM "content_module_publications" AS publication
      WHERE publication."tenant_id" = ${params.tenantId}
        AND publication."venue_id" = ${params.venueId}
      ORDER BY publication."module_id" ASC, publication."event_order" DESC
    ) AS latest
    WHERE latest."action" = 'PUBLISH'::"ContentModulePublicationAction"
    ORDER BY latest."module_id" ASC
    LIMIT ${maximumModules + 1}
  `) as PublishedHead[]
  if (heads.length > maximumModules) {
    throw new UniversalContentResolverError('Published content module count exceeds safe bounds.')
  }
  if (heads.length === 0) return []
  if (
    new Set(heads.map((head) => head.moduleId)).size !== heads.length ||
    new Set(heads.map((head) => head.revisionId)).size !== heads.length ||
    heads.some((head) => !head.moduleId || !head.revisionId)
  ) {
    throw new UniversalContentResolverError('Published content heads are inconsistent.')
  }
  const revisions = (await client.contentModuleRevision.findMany({
    where: {
      tenantId: params.tenantId,
      venueId: params.venueId,
      id: { in: heads.map((head) => head.revisionId) },
    },
    select: {
      moduleId: true,
      id: true,
      kind: true,
      version: true,
      audience: true,
      effectiveFrom: true,
      effectiveUntil: true,
      item: true,
      service: true,
      policy: true,
      event: true,
      operationalFact: true,
      relationship: true,
    },
  })) as ResolverRevision[]
  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]))
  const result: EffectivePublishedUniversalContent[] = []
  for (const head of heads) {
    const revision = revisionsById.get(head.revisionId)
    if (!revision || revision.moduleId !== head.moduleId)
      throw new UniversalContentResolverError('A published revision is missing or out of scope.')
    if (
      revision.audience !== 'PUBLIC' ||
      (revision.effectiveFrom && revision.effectiveFrom > asOf) ||
      (revision.effectiveUntil && revision.effectiveUntil <= asOf)
    ) {
      continue
    }
    const payload = (() => {
      switch (revision.kind) {
        case 'ITEM':
          return revision.item
            ? {
                kind: 'ITEM' as const,
                name: revision.item.name,
                description: revision.item.description,
                placeId: revision.item.placeId,
                itemType: revision.item.itemType,
              }
            : null
        case 'SERVICE':
          return revision.service
            ? {
                kind: 'SERVICE' as const,
                name: revision.service.name,
                description: revision.service.description,
                availability: revision.service.availability,
                placeId: revision.service.placeId,
              }
            : null
        case 'POLICY':
          return revision.policy
            ? {
                kind: 'POLICY' as const,
                title: revision.policy.title,
                rule: revision.policy.rule,
                appliesTo: revision.policy.appliesTo,
              }
            : null
        case 'EVENT':
          return revision.event
            ? {
                kind: 'EVENT' as const,
                name: revision.event.name,
                description: revision.event.description,
                placeId: revision.event.placeId,
                startsAt: revision.event.startsAt.toISOString(),
                endsAt: revision.event.endsAt?.toISOString() ?? null,
              }
            : null
        case 'OPERATIONAL_FACT':
          return revision.operationalFact
            ? {
                kind: 'OPERATIONAL_FACT' as const,
                label: revision.operationalFact.label,
                value: revision.operationalFact.value,
                expiresAt: revision.operationalFact.expiresAt?.toISOString() ?? null,
              }
            : null
        case 'RELATIONSHIP':
          return revision.relationship
            ? {
                kind: 'RELATIONSHIP' as const,
                fromModuleId: revision.relationship.fromModuleId,
                toModuleId: revision.relationship.toModuleId,
                relationshipType: revision.relationship.relationshipType,
                description: revision.relationship.description,
              }
            : null
      }
    })()
    if (!payload)
      throw new UniversalContentResolverError('A published revision has no typed payload.')
    result.push({
      moduleId: head.moduleId,
      revisionId: head.revisionId,
      kind: revision.kind,
      version: revision.version,
      payload,
    })
  }
  return result.sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en-US'))
}
