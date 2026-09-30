import { createHash } from 'node:crypto'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'

export type VenueHumanActor = { type: 'HUMAN'; id: string; role: 'OWNER' | 'MANAGER' }
export type VenueIntegrationActor = {
  type: 'INTEGRATION'
  credentialId: string
  capability: 'venues:create' | 'appearance:write'
  scope: 'client' | 'venue'
  idempotencyKey: string
}
export type VenueCreateActor = VenueHumanActor | VenueIntegrationActor
export type VenueActionClient = Pick<typeof db, '$transaction'>

export class VenueActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'VenueActionError'
  }
}

export const venueListSelect = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  description: true,
  guideNotes: true,
  category: true,
  guideMode: true,
  defaultCenterLat: true,
  defaultCenterLng: true,
  aiGuideName: true,
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  chatLogoDerivativeId: true,
  chatBannerDerivativeId: true,
  chatLogoDerivativeReceipt: true,
  chatBannerDerivativeReceipt: true,
  isActive: true,
  secondLayerEnabled: true,
  secondLayerLabel: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { places: true } },
} as const

export const venueCreateSelect = {
  ...venueListSelect,
  places: {
    select: {
      id: true,
      tenantId: true,
      name: true,
      type: true,
      itemType: true,
      shortDescription: true,
      longDescription: true,
      lat: true,
      lng: true,
      tags: true,
      importanceScore: true,
      areaName: true,
      hours: true,
      photoUrl: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
    take: 2,
  },
  knowledgeEntries: {
    select: {
      id: true,
      tenantId: true,
      title: true,
      category: true,
      content: true,
      isEnabled: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
    take: 2,
  },
} as const

type InitialPlace = {
  kind: 'place'
  value: {
    name: string
    type: string
    shortDescription: string
    longDescription?: string | undefined
    tags: string[]
    importanceScore: number
    areaName?: string | undefined
    hours?: string | undefined
    photoUrl?: string | undefined
  }
}
type InitialKnowledge = {
  kind: 'knowledge'
  value: { title: string; category: string; content: string }
}
export type VenueInitialContent = InitialPlace | InitialKnowledge
export type CreateVenueActionInput = {
  tenantId: string
  actor: VenueCreateActor
  name: string
  baseSlug: string
  callerSuppliedSlug: boolean
  description?: string | undefined
  guideNotes?: string | undefined
  category?: string | undefined
  guideMode: 'location_aware' | 'non_location'
  defaultCenterLat?: number | undefined
  defaultCenterLng?: number | undefined
  initialContent?: VenueInitialContent | undefined
}

export function normalizeVenueSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (!normalized) {
    throw new VenueActionError(
      'INVALID_INPUT',
      'Venue name or slug must contain an addressable character',
    )
  }
  if (normalized.length > 200) {
    throw new VenueActionError('INVALID_INPUT', 'Venue slug cannot exceed 200 characters')
  }
  return normalized
}

function requireActor(actor: VenueCreateActor): void {
  if (actor.type === 'INTEGRATION') {
    if (!actor.credentialId || actor.capability !== 'venues:create' || !actor.idempotencyKey) {
      throw new VenueActionError(
        'INVALID_INPUT',
        'A verified venue-creation credential is required',
      )
    }
    return
  }
  if (actor.type !== 'HUMAN' || !actor.id || !['OWNER', 'MANAGER'].includes(actor.role)) {
    throw new VenueActionError('INVALID_INPUT', 'A human venue manager is required')
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function operationHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

async function assertCreateCredential(
  tx: typeof db,
  tenantId: string,
  actor: VenueIntegrationActor,
) {
  const credential = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM external_access_credentials
    WHERE id = ${actor.credentialId}
      AND tenant_id = ${tenantId}
      AND client_id = ${tenantId}
      AND venue_id IS NULL
      AND scope_key = '__CLIENT__'
      AND kind = 'MCP'
      AND enabled = TRUE
      AND revoked_at IS NULL
      AND 'venues:create' = ANY(capabilities)
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    FOR SHARE
  `
  if (credential.length === 0)
    throw new VenueActionError('INVALID_INPUT', 'Active client venue-creation credential required')
}

function createMatches(
  existing: Awaited<ReturnType<typeof findReplay>>,
  input: CreateVenueActionInput,
): boolean {
  if (!existing) return false
  if (
    existing.name !== input.name ||
    existing.description !== (input.description ?? null) ||
    existing.guideNotes !== (input.guideNotes ?? null) ||
    existing.category !== (input.category ?? null) ||
    existing.guideMode !== input.guideMode ||
    existing.defaultCenterLat !== (input.defaultCenterLat ?? null) ||
    existing.defaultCenterLng !== (input.defaultCenterLng ?? null)
  )
    return false
  const storedPlaces = existing.places ?? []
  const storedKnowledgeEntries = existing.knowledgeEntries ?? []
  const storedPlace = storedPlaces[0]
  const storedKnowledge = storedKnowledgeEntries[0]
  if (!input.initialContent) return storedPlaces.length === 0 && storedKnowledgeEntries.length === 0
  if (input.initialContent.kind === 'knowledge') {
    const value = input.initialContent.value
    return (
      storedPlaces.length === 0 &&
      storedKnowledgeEntries.length === 1 &&
      storedKnowledge?.title === value.title &&
      storedKnowledge.category === value.category &&
      storedKnowledge.content === value.content &&
      storedKnowledge.isEnabled === true
    )
  }
  const value = input.initialContent.value
  return (
    storedPlaces.length === 1 &&
    storedKnowledgeEntries.length === 0 &&
    storedPlace?.name === value.name &&
    storedPlace.type === value.type &&
    storedPlace.itemType === null &&
    storedPlace.shortDescription === value.shortDescription &&
    storedPlace.longDescription === (value.longDescription ?? null) &&
    storedPlace.lat === (input.guideMode === 'location_aware' ? input.defaultCenterLat! : null) &&
    storedPlace.lng === (input.guideMode === 'location_aware' ? input.defaultCenterLng! : null) &&
    JSON.stringify(storedPlace.tags) === JSON.stringify(value.tags) &&
    storedPlace.importanceScore === value.importanceScore &&
    storedPlace.areaName === (value.areaName ?? null) &&
    storedPlace.hours === (value.hours ?? null) &&
    storedPlace.photoUrl === (value.photoUrl ?? null)
  )
}

async function findReplay(tx: typeof db, input: CreateVenueActionInput) {
  return tx.venue.findFirst({
    where: { tenantId: input.tenantId, slug: input.baseSlug },
    select: venueCreateSelect,
  })
}

async function uniqueSlug(tx: typeof db, tenantId: string, base: string): Promise<string> {
  let candidate = base
  let suffix = 2
  for (;;) {
    const existing = await tx.venue.findFirst({
      where: { tenantId, slug: candidate },
      select: { id: true },
    })
    if (!existing) return candidate
    const suffixText = `-${suffix++}`
    candidate = `${base.slice(0, 200 - suffixText.length)}${suffixText}`
  }
}

function safeVenueState(record: {
  id: string
  name: string
  slug: string
  category: string | null
  guideMode: string
  isActive: boolean
  updatedAt: Date
}) {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    category: record.category,
    guideMode: record.guideMode,
    isActive: record.isActive,
    updatedAt: record.updatedAt.toISOString(),
  }
}

export async function createVenueAction(
  input: CreateVenueActionInput,
  client: VenueActionClient = db,
) {
  requireActor(input.actor)
  const actorId = input.actor.type === 'INTEGRATION' ? input.actor.credentialId : input.actor.id
  const baseSlug = normalizeVenueSlug(input.baseSlug)
  const normalizedInput = { ...input, baseSlug }
  const integrationActor = input.actor.type === 'INTEGRATION' ? input.actor : null
  if (integrationActor && integrationActor.scope !== 'client') {
    throw new VenueActionError('INVALID_INPUT', 'Venue creation requires client credential scope')
  }
  const requestHash = integrationActor
    ? operationHash({
        tenantId: input.tenantId,
        name: input.name,
        baseSlug,
        callerSuppliedSlug: input.callerSuppliedSlug,
        description: input.description ?? null,
        guideNotes: input.guideNotes ?? null,
        category: input.category ?? null,
        guideMode: input.guideMode,
        defaultCenterLat: input.defaultCenterLat ?? null,
        defaultCenterLng: input.defaultCenterLng ?? null,
        initialContent: input.initialContent ?? null,
      })
    : null
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    if (integrationActor) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:venue-create-operation:${input.tenantId}:${integrationActor.credentialId}:${integrationActor.idempotencyKey}`}, 0))`
      await assertCreateCredential(tx, input.tenantId, integrationActor)
      const prior = await tx.auditLog.findFirst({
        where: {
          tenantId: input.tenantId,
          credentialId: integrationActor.credentialId,
          idempotencyKey: integrationActor.idempotencyKey,
          action: { in: ['venue.created', 'venue.create.noop'] },
        },
        select: { targetId: true, structuredReason: true },
      })
      if (prior) {
        const evidence = prior.structuredReason as { operationHash?: unknown } | null
        if (evidence?.operationHash !== requestHash) {
          throw new VenueActionError(
            'CONFLICT',
            'Operation ID was already used for different venue setup.',
          )
        }
        const replay = await tx.venue.findFirst({
          where: { id: prior.targetId, tenantId: input.tenantId },
          select: venueCreateSelect,
        })
        if (!replay)
          throw new VenueActionError('CONFLICT', 'The original venue operation is unavailable.')
        return { record: replay, replayed: true }
      }
    }
    await setContentVersionContext(tx, { actorId })
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:venue-create:${input.tenantId}:${baseSlug}`}, 0))`
    if (input.callerSuppliedSlug) {
      const existing = await findReplay(tx, normalizedInput)
      if (existing) {
        if (!createMatches(existing, normalizedInput))
          throw new VenueActionError(
            'CONFLICT',
            'This venue slug is already used for different setup content.',
          )
        if (integrationActor) {
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId,
              actorRole: 'INTEGRATION',
              actorType: 'INTEGRATION',
              credentialId: integrationActor.credentialId,
              capability: integrationActor.capability,
              idempotencyKey: integrationActor.idempotencyKey,
              action: 'venue.create.noop',
              targetType: 'Venue',
              targetId: existing.id,
              afterState: safeVenueState(existing),
              structuredReason: { operationHash: requestHash },
            },
            tx,
          )
        }
        return { record: existing, replayed: true }
      }
    }
    const slug = input.callerSuppliedSlug
      ? baseSlug
      : await uniqueSlug(tx, input.tenantId, baseSlug)
    const initial = input.initialContent
    const record = await tx.venue.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        slug,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.guideNotes !== undefined ? { guideNotes: input.guideNotes } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        guideMode: input.guideMode,
        ...(input.defaultCenterLat !== undefined
          ? { defaultCenterLat: input.defaultCenterLat }
          : {}),
        ...(input.defaultCenterLng !== undefined
          ? { defaultCenterLng: input.defaultCenterLng }
          : {}),
        venueBotConfiguration: {
          create: {
            tenant: { connect: { id: input.tenantId } },
            presentationMode: 'CLASSIC',
            personalityMode: 'PRESET',
            tonePreset: 'friendly',
            tonePresetVersion: 1,
            createdBy: actorId,
            updatedBy: actorId,
          },
        },
        ...(initial?.kind === 'place'
          ? {
              places: {
                create: {
                  tenantId: input.tenantId,
                  name: initial.value.name,
                  type: initial.value.type,
                  shortDescription: initial.value.shortDescription,
                  ...(initial.value.longDescription !== undefined
                    ? { longDescription: initial.value.longDescription }
                    : {}),
                  ...(initial.value.areaName !== undefined
                    ? { areaName: initial.value.areaName }
                    : {}),
                  ...(initial.value.hours !== undefined ? { hours: initial.value.hours } : {}),
                  ...(initial.value.photoUrl !== undefined
                    ? { photoUrl: initial.value.photoUrl }
                    : {}),
                  tags: initial.value.tags,
                  importanceScore: initial.value.importanceScore,
                  ...(input.guideMode === 'location_aware'
                    ? { lat: input.defaultCenterLat!, lng: input.defaultCenterLng! }
                    : {}),
                },
              },
            }
          : {}),
        ...(initial?.kind === 'knowledge'
          ? {
              knowledgeEntries: {
                create: {
                  tenantId: input.tenantId,
                  title: initial.value.title,
                  category: initial.value.category,
                  content: initial.value.content,
                  isEnabled: true,
                },
              },
            }
          : {}),
      },
      select: venueCreateSelect,
    })
    const places = record.places ?? []
    const knowledgeEntries = record.knowledgeEntries ?? []
    if (
      (initial?.kind === 'place' && (places.length !== 1 || knowledgeEntries.length !== 0)) ||
      (initial?.kind === 'knowledge' && (knowledgeEntries.length !== 1 || places.length !== 0)) ||
      (!initial && (places.length !== 0 || knowledgeEntries.length !== 0))
    ) {
      throw new Error('Initial content was not returned from the atomic venue create')
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId,
        actorRole: input.actor.type === 'INTEGRATION' ? 'INTEGRATION' : input.actor.role,
        ...(input.actor.type === 'INTEGRATION'
          ? {
              actorType: 'INTEGRATION' as const,
              credentialId: input.actor.credentialId,
              capability: input.actor.capability,
              idempotencyKey: input.actor.idempotencyKey,
              structuredReason: { operationHash: requestHash },
            }
          : {}),
        action: 'venue.created',
        targetType: 'Venue',
        targetId: record.id,
        afterState: safeVenueState(record),
      },
      tx,
    )
    return { record, replayed: false }
  })
}
