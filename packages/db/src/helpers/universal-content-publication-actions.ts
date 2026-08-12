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

export class UniversalContentResolverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UniversalContentResolverError'
  }
}

export async function resolveEffectivePublishedUniversalContent(params: {
  db: Pick<typeof db, 'contentModulePublication'>
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
    params.db === null ||
    typeof params.db.contentModulePublication?.findMany !== 'function'
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
  const events = await params.db.contentModulePublication.findMany({
    where: { tenantId: params.tenantId, venueId: params.venueId },
    orderBy: { eventOrder: 'desc' },
    take: 501,
    select: {
      moduleId: true,
      revisionId: true,
      action: true,
      revision: {
        select: {
          kind: true,
          version: true,
          audience: true,
          effectiveFrom: true,
          effectiveUntil: true,
          service: true,
          policy: true,
          event: true,
          operationalFact: true,
          relationship: true,
        },
      },
    },
  })
  if (events.length === 501) {
    throw new UniversalContentResolverError('Published content event history exceeds safe bounds.')
  }
  const latest = new Map<string, (typeof events)[number]>()
  for (const event of events) if (!latest.has(event.moduleId)) latest.set(event.moduleId, event)
  if (latest.size > maximumModules) {
    throw new UniversalContentResolverError('Published content module count exceeds safe bounds.')
  }
  const result: EffectivePublishedUniversalContent[] = []
  for (const event of latest.values()) {
    const revision = event.revision
    if (
      event.action !== 'PUBLISH' ||
      revision.audience !== 'PUBLIC' ||
      (revision.effectiveFrom && revision.effectiveFrom > asOf) ||
      (revision.effectiveUntil && revision.effectiveUntil <= asOf)
    ) {
      continue
    }
    const payload = (() => {
      switch (revision.kind) {
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
      moduleId: event.moduleId,
      revisionId: event.revisionId,
      kind: revision.kind,
      version: revision.version,
      payload,
    })
  }
  return result.sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en-US'))
}
