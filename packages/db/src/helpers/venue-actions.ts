import {
  LEGACY_AI_TONE_TO_PRESET,
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_TO_LEGACY_AI_TONE,
  type TonePresetId,
} from '@pathfinder/contracts/tone-presets'
import * as prismaClient from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'
import {
  VenueActionError,
  type VenueActionClient,
  type VenueHumanActor,
  venueListSelect,
} from './venue-create-action'

export const venueAiConfigSelect = {
  aiGuideNotes: true,
  aiFeaturedPlaceId: true,
  aiTone: true,
  tonePreset: true,
  tonePresetVersion: true,
  aiGuideName: true,
  updatedAt: true,
} as const

export const venueChatDesignSelect = {
  chatTheme: true,
  chatAccentColor: true,
  chatFont: true,
  chatLogoUrl: true,
  chatBannerUrl: true,
  chatLogoDerivativeId: true,
  chatBannerDerivativeId: true,
  chatLogoDerivativeReceipt: true,
  chatBannerDerivativeReceipt: true,
  updatedAt: true,
} as const

type BaseAction = {
  tenantId: string
  venueId: string
  expectedUpdatedAt: Date
  actor: VenueHumanActor
}

export type VenueChatDesignActor =
  | VenueHumanActor
  | { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }

function requireActor(actor: VenueHumanActor): void {
  if (actor.type !== 'HUMAN' || !actor.id || !['OWNER', 'MANAGER'].includes(actor.role)) {
    throw new VenueActionError('INVALID_INPUT', 'A human venue manager is required')
  }
}

function requireChatDesignActor(actor: VenueChatDesignActor): void {
  if (
    actor.type !== 'HUMAN' ||
    !actor.id ||
    !['OWNER', 'MANAGER', 'PLATFORM_ADMIN'].includes(actor.role)
  ) {
    throw new VenueActionError('INVALID_INPUT', 'A human venue design operator is required')
  }
}

async function prepare(tx: typeof db, input: BaseAction) {
  requireActor(input.actor)
  await setContentVersionContext(tx, { actorId: input.actor.id })
  await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId: input.venueId })
}

function conflict(message = 'Venue changed in another session. Refresh and try again.'): never {
  throw new VenueActionError('CONFLICT', message)
}

function nextUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}

function safeCore(value: {
  id: string
  name: string
  slug: string
  category: string | null
  guideMode: string
  defaultCenterLat: number | null
  defaultCenterLng: number | null
  isActive: boolean
  updatedAt: Date
}) {
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    category: value.category,
    guideMode: value.guideMode,
    defaultCenterLat: value.defaultCenterLat,
    defaultCenterLng: value.defaultCenterLng,
    isActive: value.isActive,
    updatedAt: value.updatedAt.toISOString(),
  }
}

export type UpdateVenueFields = {
  name?: string | undefined
  description?: string | undefined
  guideNotes?: string | undefined
  category?: string | undefined
  guideMode?: 'location_aware' | 'non_location' | undefined
  defaultCenterLat?: number | undefined
  defaultCenterLng?: number | undefined
}

export async function setVenueAvailabilityAction(
  input: BaseAction & { enabled: boolean; reason: string },
  client: VenueActionClient = db,
) {
  requireActor(input.actor)
  const reason = input.reason.trim()
  if (!reason || reason.length > 500) {
    throw new VenueActionError('INVALID_INPUT', 'An availability reason is required')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const before = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true, isActive: true, updatedAt: true },
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      conflict('Venue availability changed; refresh and try again.')
    }
    if (before.isActive === input.enabled) return { ...before, replayed: true as const }
    const updatedAt = nextUpdatedAt(before.updatedAt)
    const changed = await tx.venue.updateMany({
      where: {
        id: input.venueId,
        tenantId: input.tenantId,
        isActive: before.isActive,
        updatedAt: input.expectedUpdatedAt,
      },
      data: { isActive: input.enabled, updatedAt },
    })
    if (changed.count !== 1) conflict('Venue availability changed; refresh and try again.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.enabled ? 'venue.availability.enabled' : 'venue.availability.disabled',
        targetType: 'Venue',
        targetId: input.venueId,
        beforeState: { enabled: before.isActive },
        afterState: { enabled: input.enabled, reason },
      },
      tx,
    )
    return { id: before.id, isActive: input.enabled, updatedAt, replayed: false as const }
  })
}

export async function updateVenueAction(
  input: BaseAction & { fields: UpdateVenueFields },
  client: VenueActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const before = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueListSelect,
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) conflict()
    const effectiveGuideMode = input.fields.guideMode ?? before.guideMode ?? 'location_aware'
    if (
      effectiveGuideMode === 'non_location' &&
      (input.fields.defaultCenterLat !== undefined || input.fields.defaultCenterLng !== undefined)
    ) {
      throw new VenueActionError(
        'INVALID_INPUT',
        'Non-location venues cannot define a default center.',
      )
    }
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(input.fields).filter(([, value]) => value !== undefined),
    )
    if (effectiveGuideMode === 'non_location') {
      data.defaultCenterLat = null
      data.defaultCenterLng = null
    }
    data.updatedAt = nextUpdatedAt(before.updatedAt)
    const changed = await tx.venue.updateMany({
      where: { id: input.venueId, tenantId: input.tenantId, updatedAt: input.expectedUpdatedAt },
      data,
    })
    if (changed.count !== 1) conflict()
    const saved = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueListSelect,
    })
    if (!saved) conflict()
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'venue.updated',
        targetType: 'Venue',
        targetId: input.venueId,
        beforeState: safeCore(before),
        afterState: safeCore(saved),
      },
      tx,
    )
    return saved
  })
}

export type UpdateVenueAiConfigFields = {
  aiGuideNotes?: string | null | undefined
  aiFeaturedPlaceId?: string | null | undefined
  aiTone?: 'FRIENDLY' | 'PROFESSIONAL' | 'PLAYFUL' | undefined
  tonePreset?: TonePresetId | undefined
  aiGuideName?: string | null | undefined
}

function safeAi(value: {
  aiGuideNotes: string | null
  aiFeaturedPlaceId: string | null
  aiTone: string | null
  tonePreset: string | null
  tonePresetVersion: number | null
  aiGuideName: string | null
  updatedAt: Date
}) {
  return {
    hasGuideNotes: value.aiGuideNotes !== null,
    aiFeaturedPlaceId: value.aiFeaturedPlaceId,
    aiTone: value.aiTone,
    tonePreset: value.tonePreset,
    tonePresetVersion: value.tonePresetVersion,
    aiGuideName: value.aiGuideName,
    updatedAt: value.updatedAt.toISOString(),
  }
}

export async function updateVenueAiConfigAction(
  input: BaseAction & { fields: UpdateVenueAiConfigFields },
  client: VenueActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const before = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueAiConfigSelect,
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      conflict('Venue AI configuration changed; refresh and try again.')
    if (input.fields.aiFeaturedPlaceId) {
      const place = await tx.place.findFirst({
        where: {
          id: input.fields.aiFeaturedPlaceId,
          venueId: input.venueId,
          tenantId: input.tenantId,
        },
        select: { id: true },
      })
      if (!place) throw new VenueActionError('NOT_FOUND', 'Place not found')
    }
    const requestedPreset =
      input.fields.tonePreset ??
      (input.fields.aiTone ? LEGACY_AI_TONE_TO_PRESET[input.fields.aiTone] : undefined)
    const data = {
      ...(input.fields.aiGuideNotes !== undefined
        ? { aiGuideNotes: input.fields.aiGuideNotes }
        : {}),
      ...(input.fields.aiFeaturedPlaceId !== undefined
        ? { aiFeaturedPlaceId: input.fields.aiFeaturedPlaceId }
        : {}),
      ...(input.fields.aiGuideName !== undefined ? { aiGuideName: input.fields.aiGuideName } : {}),
      ...(requestedPreset
        ? {
            tonePreset: requestedPreset,
            tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
            aiTone: TONE_PRESET_TO_LEGACY_AI_TONE[requestedPreset],
          }
        : {}),
      updatedAt: nextUpdatedAt(before.updatedAt),
    }
    const changed = await tx.venue.updateMany({
      where: { id: input.venueId, tenantId: input.tenantId, updatedAt: input.expectedUpdatedAt },
      data,
    })
    if (changed.count !== 1) conflict('Venue AI configuration changed; refresh and try again.')
    if (requestedPreset) {
      const compatibleConfiguration = await tx.venueBotConfiguration.updateMany({
        where: { tenantId: input.tenantId, venueId: input.venueId },
        data: {
          tonePreset: requestedPreset,
          tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
          revision: { increment: 1 },
          updatedBy: input.actor.id,
        },
      })
      if (compatibleConfiguration.count !== 1) {
        conflict('Venue Bot configuration is unavailable; refresh and try again.')
      }
    }
    const saved = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueAiConfigSelect,
    })
    if (!saved) conflict('Venue AI configuration changed; refresh and try again.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'venue.ai-config.updated',
        targetType: 'Venue',
        targetId: input.venueId,
        beforeState: safeAi(before),
        afterState: safeAi(saved),
      },
      tx,
    )
    return saved
  })
}

export type UpdateVenueChatDesignFields = {
  chatTheme?: 'default' | 'forest' | 'sunset' | 'midnight' | 'rose' | 'dark' | undefined
  chatAccentColor?: string | null | undefined
  chatFont?: 'jakarta' | 'inter' | 'poppins' | 'spaceGrotesk' | 'dmSans' | 'playfair' | undefined
  chatLogoUrl?: string | null | undefined
  chatBannerUrl?: string | null | undefined
  chatLogoDerivativeId?: string | null | undefined
  chatBannerDerivativeId?: string | null | undefined
  chatLogoDerivativeReceipt?: BrandingDerivativeReceipt | null | undefined
  chatBannerDerivativeReceipt?: BrandingDerivativeReceipt | null | undefined
}

type BrandingDerivativeReceipt = {
  assetId: string
  derivativeId: string
  sourceObjectGeneration: string
  sha256: string
  approvedReviewSequence: number
}

function safeChat(value: {
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  chatLogoDerivativeId: string | null
  chatBannerDerivativeId: string | null
  chatLogoDerivativeReceipt: unknown
  chatBannerDerivativeReceipt: unknown
  updatedAt: Date
}) {
  return {
    chatTheme: value.chatTheme,
    chatAccentColor: value.chatAccentColor,
    chatFont: value.chatFont,
    hasLogo: value.chatLogoUrl !== null || value.chatLogoDerivativeId !== null,
    hasBanner: value.chatBannerUrl !== null || value.chatBannerDerivativeId !== null,
    updatedAt: value.updatedAt.toISOString(),
  }
}

export async function updateVenueChatDesignAction(
  input: Omit<BaseAction, 'actor'> & {
    actor: VenueChatDesignActor
    fields: UpdateVenueChatDesignFields
  },
  client: VenueActionClient = db,
) {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    requireChatDesignActor(input.actor)
    await setContentVersionContext(tx, { actorId: input.actor.id })
    await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId: input.venueId })
    const before = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueChatDesignSelect,
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    for (const key of ['chatLogoUrl', 'chatBannerUrl'] as const) {
      const requested = input.fields[key]
      const current = before[key]
      if (requested !== undefined && requested !== null && requested !== current) {
        throw new VenueActionError(
          'INVALID_INPUT',
          'New branding URLs are not accepted; select a reviewed media derivative.',
        )
      }
    }
    const requestedEntries: Array<[string, unknown]> = Object.entries(input.fields).filter(
      ([key, value]) => value !== undefined && !key.endsWith('DerivativeReceipt'),
    )
    for (const key of ['chatLogo', 'chatBanner'] as const) {
      const id = input.fields[`${key}DerivativeId`]
      const receipt = input.fields[`${key}DerivativeReceipt`]
      const validPair =
        (id === undefined && receipt === undefined) ||
        (id === null && receipt === null) ||
        (typeof id === 'string' && receipt !== undefined && receipt !== null)
      if (!validPair) {
        throw new VenueActionError(
          'INVALID_INPUT',
          'Branding media ID and receipt must change together.',
        )
      }
    }
    const derivativeIds = requestedEntries
      .filter(
        ([key, value]) =>
          (key === 'chatLogoDerivativeId' || key === 'chatBannerDerivativeId') && value !== null,
      )
      .map(([, value]) => value as string)
    if (derivativeIds.length) {
      const approved = await tx.venueMediaDerivative.findMany({
        where: {
          id: { in: derivativeIds },
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'READY',
          mimeType: 'image/webp',
        },
        select: {
          id: true,
          assetId: true,
          approvedReviewSequence: true,
          sourceObjectGeneration: true,
          sha256: true,
          asset: {
            select: {
              kind: true,
              reviews: {
                orderBy: { sequence: 'desc' },
                take: 1,
                select: { sequence: true, action: true, rightsBasis: true },
              },
            },
          },
        },
      })
      const valid = approved.filter((row) => {
        const latest = row.asset.reviews[0]
        return (
          row.asset.kind === 'IMAGE' &&
          latest?.sequence === row.approvedReviewSequence &&
          latest.action === 'APPROVE_CONTENT_USE' &&
          latest.rightsBasis !== null
        )
      })
      if (valid.length !== new Set(derivativeIds).size) {
        throw new VenueActionError(
          'CONFLICT',
          'The selected branding media is unavailable or its approval has changed.',
        )
      }
      for (const key of ['chatLogo', 'chatBanner'] as const) {
        const id = input.fields[`${key}DerivativeId`]
        const receipt = input.fields[`${key}DerivativeReceipt`]
        if (id && (!receipt || receipt.derivativeId !== id)) {
          throw new VenueActionError('CONFLICT', 'The branding media receipt is incomplete.')
        }
        if (id && receipt) {
          const row = approved.find((candidate) => candidate.id === id)
          if (
            !row ||
            row.assetId !== receipt.assetId ||
            row.sourceObjectGeneration !== receipt.sourceObjectGeneration ||
            row.sha256 !== receipt.sha256 ||
            row.approvedReviewSequence !== receipt.approvedReviewSequence
          ) {
            throw new VenueActionError('CONFLICT', 'The branding media receipt is stale.')
          }
        }
      }
    }
    requestedEntries.push(
      ...(['chatLogo', 'chatBanner'] as const)
        .map(
          (key) =>
            [`${key}DerivativeReceipt`, input.fields[`${key}DerivativeReceipt`]] as [
              string,
              unknown,
            ],
        )
        .filter(([, value]) => value !== undefined),
    )
    if (input.fields.chatLogoDerivativeId !== undefined) {
      requestedEntries.push(['chatLogoUrl', null])
    }
    if (input.fields.chatBannerDerivativeId !== undefined) {
      requestedEntries.push(['chatBannerUrl', null])
    }
    const exactReplay = requestedEntries.every(([key, value]) => {
      const current = before[key as keyof typeof before]
      if (current === value) return true
      return (
        current !== null &&
        value !== null &&
        typeof current === 'object' &&
        typeof value === 'object' &&
        JSON.stringify(
          Object.entries(current).sort(([left], [right]) => left.localeCompare(right)),
        ) ===
          JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      )
    })
    if (exactReplay) return { ...before, replayed: true as const }
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      conflict('Venue design changed; refresh and try again.')
    const data = {
      ...Object.fromEntries(
        requestedEntries.map(([key, value]) => [
          key,
          key.endsWith('DerivativeReceipt') && value === null
            ? prismaClient['Prisma']['DbNull']
            : value,
        ]),
      ),
      updatedAt: nextUpdatedAt(before.updatedAt),
    }
    const changed = await tx.venue.updateMany({
      where: { id: input.venueId, tenantId: input.tenantId, updatedAt: input.expectedUpdatedAt },
      data,
    })
    if (changed.count !== 1) conflict('Venue design changed; refresh and try again.')
    const saved = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: venueChatDesignSelect,
    })
    if (!saved) conflict('Venue design changed; refresh and try again.')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'venue.chat-design.updated',
        targetType: 'Venue',
        targetId: input.venueId,
        beforeState: safeChat(before),
        afterState: safeChat(saved),
      },
      tx,
    )
    return { ...saved, replayed: false as const }
  })
}

export async function deleteVenueAction(input: BaseAction, client: VenueActionClient = db) {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'OWNER') {
    throw new VenueActionError('INVALID_INPUT', 'A human venue owner is required to delete a venue')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await prepare(tx, input)
    const before = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true, name: true, updatedAt: true, _count: { select: { places: true } } },
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      conflict('Venue changed during deletion')
    if (before._count.places > 0)
      throw new VenueActionError('INVALID_INPUT', 'Remove all POIs before deleting a venue')
    const deleted = await tx.venue.deleteMany({
      where: { id: input.venueId, tenantId: input.tenantId, updatedAt: input.expectedUpdatedAt },
    })
    if (deleted.count !== 1) conflict('Venue changed during deletion')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'venue.deleted',
        targetType: 'Venue',
        targetId: input.venueId,
        beforeState: {
          id: before.id,
          name: before.name,
          placeCount: before._count.places,
          updatedAt: before.updatedAt.toISOString(),
        },
      },
      tx,
    )
    return { id: input.venueId }
  })
}
