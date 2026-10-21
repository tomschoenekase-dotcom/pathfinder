import { GeneralizedContentPayload } from '@pathfinder/contracts/universal-content-actions'
import { ContentEvidenceReference } from '@pathfinder/contracts/content-model'

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
        select: {
          id: true,
          moduleId: true,
          kind: true,
          version: true,
          audience: true,
          effectiveFrom: true,
          effectiveUntil: true,
        },
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
      if (revision.kind === 'RELATIONSHIP') {
        const relationship = await tx.relationshipContent.findFirst({
          where: { revisionId: revision.id, tenantId: input.tenantId, venueId: input.venueId },
          select: { fromModuleId: true, toModuleId: true, relationshipType: true },
        })
        if (!relationship) {
          throw new UniversalContentActionError('INVALID_INPUT', 'Relationship payload is missing.')
        }
        const recognized =
          relationship.relationshipType === 'OFFERS_PRODUCT_V1' ||
          relationship.relationshipType === 'EXCEPTION_TO_V1'
        const now = new Date()
        if (recognized && revision.effectiveUntil && revision.effectiveUntil <= now) {
          // Ended revisions cannot enter guest context, but must retain scoped endpoint kinds.
          const identities = await tx.contentModuleIdentity.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: [relationship.fromModuleId, relationship.toModuleId] },
            },
            select: { id: true, kind: true },
          })
          const from = identities.find((identity) => identity.id === relationship.fromModuleId)
          const to = identities.find((identity) => identity.id === relationship.toModuleId)
          if (
            relationship.fromModuleId === relationship.toModuleId ||
            (relationship.relationshipType === 'OFFERS_PRODUCT_V1'
              ? from?.kind !== 'SERVICE' || to?.kind !== 'ITEM'
              : from?.kind !== 'POLICY' || to?.kind !== 'POLICY')
          ) {
            throw new UniversalContentActionError(
              'INVALID_INPUT',
              'Ended recognized relationship requires scoped compatible endpoint identities.',
            )
          }
        } else if (recognized) {
          const checkAt =
            revision.effectiveFrom && revision.effectiveFrom > now ? revision.effectiveFrom : now
          const endpoints = []
          for (const moduleId of [relationship.fromModuleId, relationship.toModuleId]) {
            const current = await tx.contentModulePublication.findFirst({
              where: { tenantId: input.tenantId, venueId: input.venueId, moduleId },
              orderBy: { eventOrder: 'desc' },
              select: { action: true, revisionId: true },
            })
            const endpoint =
              current?.action === 'PUBLISH'
                ? await tx.contentModuleRevision.findFirst({
                    where: {
                      id: current.revisionId,
                      tenantId: input.tenantId,
                      venueId: input.venueId,
                      moduleId,
                    },
                    select: {
                      kind: true,
                      audience: true,
                      effectiveFrom: true,
                      effectiveUntil: true,
                      item: { select: { itemType: true } },
                    },
                  })
                : null
            if (
              !endpoint ||
              endpoint.audience !== 'PUBLIC' ||
              (endpoint.effectiveFrom && endpoint.effectiveFrom > checkAt) ||
              (endpoint.effectiveUntil && endpoint.effectiveUntil <= checkAt)
            ) {
              throw new UniversalContentActionError(
                'INVALID_INPUT',
                'Recognized relationships require published endpoints effective at the relationship start in this venue.',
              )
            }
            endpoints.push(endpoint)
          }
          const [from, to] = endpoints
          if (
            relationship.fromModuleId === relationship.toModuleId ||
            (relationship.relationshipType === 'OFFERS_PRODUCT_V1'
              ? from?.kind !== 'SERVICE' || to?.kind !== 'ITEM' || to.item?.itemType !== 'PRODUCT'
              : from?.kind !== 'POLICY' || to?.kind !== 'POLICY')
          ) {
            throw new UniversalContentActionError(
              'INVALID_INPUT',
              'Recognized relationship does not match the current published endpoint kinds and product subtype.',
            )
          }
        }
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

export type EffectivePublishedUniversalContentSnapshot = EffectivePublishedUniversalContent & {
  publicationId: string
  publicationOrder: string
  audience: 'PUBLIC'
  effectiveFrom: string | null
  effectiveUntil: string | null
  evidence: Array<{
    sourceId: string
    locator: string | null
    capturedAt: string
    excerptHash: string | null
  }>
}

// Prisma's extended transaction client does not expose a stable public raw-query type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UniversalContentResolverClient = any
type PublishedHead = {
  moduleId: string
  revisionId: string
  publicationId?: string
  publicationOrder?: string
}
type ResolverRevision = {
  tenantId?: string
  venueId?: string
  id: string
  moduleId: string
  kind: GeneralizedContentPayload['kind']
  version: number
  audience: string
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  evidence?: Array<{
    id: string
    tenantId: string
    venueId: string
    revisionId: string
    moduleKind: string
    sourceId: string
    locator: string | null
    capturedAt: Date
    excerptHash: string | null
  }>
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

const MAXIMUM_PUBLISHED_MODULES = 10_000
const REVISION_BATCH_SIZE = 500

/**
 * Select all bounded current heads in one statement snapshot, then hydrate their
 * immutable revisions in batches. Concurrent later publication events belong to
 * the next read; asOf controls effective dates, not historical publication state.
 */
type UniversalContentResolverInput = {
  db: UniversalContentResolverClient
  tenantId: string
  venueId: string
  asOf?: Date
  maximumModules?: number
}

export function resolveEffectivePublishedUniversalContent(
  params: UniversalContentResolverInput,
): Promise<EffectivePublishedUniversalContent[]> {
  return resolvePublishedContent(params, false)
}

/** Exact current publication/revision evidence, with expired operational facts excluded. */
export function resolveEffectivePublishedUniversalContentSnapshot(
  params: UniversalContentResolverInput,
): Promise<EffectivePublishedUniversalContentSnapshot[]> {
  return resolvePublishedContent(params, true) as Promise<
    EffectivePublishedUniversalContentSnapshot[]
  >
}

async function resolvePublishedContent(
  params: UniversalContentResolverInput,
  detailed: boolean,
): Promise<EffectivePublishedUniversalContent[]> {
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
  const maximumModules = params.maximumModules ?? MAXIMUM_PUBLISHED_MODULES
  if (
    !(asOf instanceof Date) ||
    !Number.isFinite(asOf.getTime()) ||
    !Number.isInteger(maximumModules) ||
    maximumModules < 1 ||
    maximumModules > MAXIMUM_PUBLISHED_MODULES
  ) {
    throw new UniversalContentResolverError(
      'Maximum published modules must be between 1 and 10000.',
    )
  }
  const client = params.db
  const heads = (await client.$queryRaw`
    SELECT latest."module_id" AS "moduleId", latest."revision_id" AS "revisionId",
      latest."id" AS "publicationId", latest."event_order"::text AS "publicationOrder"
    FROM (
      SELECT DISTINCT ON (publication."module_id")
        publication."id",
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
  if (
    detailed &&
    (!Array.isArray(heads) || heads.some((head) => !head || typeof head !== 'object'))
  )
    throw new UniversalContentResolverError('Published content heads are inconsistent.')
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
  const headModulesByRevision = new Map(heads.map((head) => [head.revisionId, head.moduleId]))
  if (
    detailed &&
    (heads.some(
      (head) =>
        typeof head.moduleId !== 'string' ||
        !head.moduleId.trim() ||
        typeof head.revisionId !== 'string' ||
        !head.revisionId.trim() ||
        typeof head.publicationId !== 'string' ||
        !head.publicationId.trim() ||
        typeof head.publicationOrder !== 'string' ||
        !/^[1-9]\d*$/u.test(head.publicationOrder),
    ) ||
      new Set(heads.map((head) => head.publicationId)).size !== heads.length ||
      new Set(heads.map((head) => head.publicationOrder)).size !== heads.length)
  )
    throw new UniversalContentResolverError(
      'Published content publication identities are inconsistent.',
    )
  const revisions: ResolverRevision[] = []
  for (let offset = 0; offset < heads.length; offset += REVISION_BATCH_SIZE) {
    revisions.push(
      ...((await client.contentModuleRevision.findMany({
        where: {
          tenantId: params.tenantId,
          venueId: params.venueId,
          id: {
            in: heads.slice(offset, offset + REVISION_BATCH_SIZE).map((head) => head.revisionId),
          },
        },
        select: {
          ...(detailed
            ? {
                tenantId: true,
                venueId: true,
                evidence: {
                  orderBy: [{ sourceId: 'asc' }, { locator: 'asc' }, { id: 'asc' }],
                  take: 101,
                  select: {
                    id: true,
                    tenantId: true,
                    venueId: true,
                    revisionId: true,
                    moduleKind: true,
                    sourceId: true,
                    locator: true,
                    capturedAt: true,
                    excerptHash: true,
                  },
                },
              }
            : {}),
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
      })) as ResolverRevision[]),
    )
  }
  if (
    detailed &&
    (revisions.length !== heads.length ||
      new Set(revisions.map((revision) => revision?.id)).size !== revisions.length ||
      revisions.some(
        (revision) =>
          !revision ||
          typeof revision !== 'object' ||
          revision.tenantId !== params.tenantId ||
          revision.venueId !== params.venueId ||
          headModulesByRevision.get(revision.id) !== revision.moduleId,
      ))
  )
    throw new UniversalContentResolverError(
      'Published content revisions are inconsistent or out of scope.',
    )
  const revisionsById = new Map(revisions.map((revision) => [revision.id, revision]))
  const result: EffectivePublishedUniversalContent[] = []
  for (const head of heads) {
    const revision = revisionsById.get(head.revisionId)
    if (!revision || revision.moduleId !== head.moduleId)
      throw new UniversalContentResolverError('A published revision is missing or out of scope.')
    const validDate = (value: unknown): value is Date =>
      value instanceof Date && Number.isFinite(value.getTime())
    if (
      detailed &&
      (!Number.isSafeInteger(revision.version) ||
        revision.version < 1 ||
        !['PUBLIC', 'CLIENT', 'OPERATOR'].includes(revision.audience) ||
        (revision.effectiveFrom !== null && !validDate(revision.effectiveFrom)) ||
        (revision.effectiveUntil !== null && !validDate(revision.effectiveUntil)) ||
        (revision.effectiveFrom &&
          revision.effectiveUntil &&
          revision.effectiveFrom >= revision.effectiveUntil))
    )
      throw new UniversalContentResolverError('Published content revision metadata is invalid.')
    if (
      revision.audience !== 'PUBLIC' ||
      (revision.effectiveFrom && revision.effectiveFrom > asOf) ||
      (revision.effectiveUntil && revision.effectiveUntil <= asOf)
    ) {
      continue
    }
    if (
      detailed &&
      ((revision.kind === 'EVENT' &&
        revision.event &&
        (!validDate(revision.event.startsAt) ||
          (revision.event.endsAt !== null && !validDate(revision.event.endsAt)))) ||
        (revision.kind === 'OPERATIONAL_FACT' &&
          revision.operationalFact &&
          revision.operationalFact.expiresAt !== null &&
          !validDate(revision.operationalFact.expiresAt)))
    )
      throw new UniversalContentResolverError('Published content typed dates are invalid.')
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
    let details: Partial<EffectivePublishedUniversalContentSnapshot> = {}
    if (detailed) {
      const parsedPayload = GeneralizedContentPayload.safeParse(payload)
      if (!parsedPayload.success)
        throw new UniversalContentResolverError('Published content typed payload is invalid.')
      if (!Array.isArray(revision.evidence) || revision.evidence.length > 100)
        throw new UniversalContentResolverError('Published content revision evidence is invalid.')
      const identities = new Set<string>()
      const ids = new Set<string>()
      const evidence = revision.evidence.map((entry) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          entry.tenantId !== params.tenantId ||
          entry.venueId !== params.venueId ||
          entry.revisionId !== revision.id ||
          entry.moduleKind !== revision.kind ||
          typeof entry.id !== 'string' ||
          !entry.id.trim() ||
          !validDate(entry.capturedAt) ||
          !(entry.locator === null || typeof entry.locator === 'string') ||
          !(entry.excerptHash === null || typeof entry.excerptHash === 'string')
        )
          throw new UniversalContentResolverError('Published content revision evidence is invalid.')
        const parsed = ContentEvidenceReference.safeParse({
          sourceId: entry.sourceId,
          capturedAt: entry.capturedAt.toISOString(),
          ...(entry.locator === null ? {} : { locator: entry.locator }),
          ...(entry.excerptHash === null ? {} : { excerptHash: entry.excerptHash }),
        })
        const identity = JSON.stringify([entry.sourceId, entry.locator])
        if (!parsed.success || identities.has(identity) || ids.has(entry.id))
          throw new UniversalContentResolverError('Published content revision evidence is invalid.')
        identities.add(identity)
        ids.add(entry.id)
        return {
          sourceId: parsed.data.sourceId,
          locator: parsed.data.locator ?? null,
          capturedAt: parsed.data.capturedAt,
          excerptHash: parsed.data.excerptHash ?? null,
        }
      })
      if (
        payload.kind === 'OPERATIONAL_FACT' &&
        payload.expiresAt &&
        new Date(payload.expiresAt) <= asOf
      )
        continue
      details = {
        publicationId: head.publicationId!,
        publicationOrder: head.publicationOrder!,
        audience: 'PUBLIC',
        effectiveFrom: revision.effectiveFrom?.toISOString() ?? null,
        effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
        evidence,
      }
    }
    result.push({
      moduleId: head.moduleId,
      revisionId: head.revisionId,
      kind: revision.kind,
      version: revision.version,
      payload,
      ...details,
    })
  }
  return result.sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en-US'))
}
