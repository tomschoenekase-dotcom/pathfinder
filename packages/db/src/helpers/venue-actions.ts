import {
  LEGACY_AI_TONE_TO_PRESET,
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_TO_LEGACY_AI_TONE,
  type TonePresetId,
} from '@pathfinder/contracts/tone-presets'

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
}

function safeChat(value: {
  chatTheme: string | null
  chatAccentColor: string | null
  chatFont: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
  updatedAt: Date
}) {
  return {
    chatTheme: value.chatTheme,
    chatAccentColor: value.chatAccentColor,
    chatFont: value.chatFont,
    hasLogo: value.chatLogoUrl !== null,
    hasBanner: value.chatBannerUrl !== null,
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
    const requestedEntries = Object.entries(input.fields).filter(([, value]) => value !== undefined)
    const exactReplay = requestedEntries.every(
      ([key, value]) => before[key as keyof typeof before] === value,
    )
    if (exactReplay) return { ...before, replayed: true as const }
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      conflict('Venue design changed; refresh and try again.')
    const data = {
      ...Object.fromEntries(requestedEntries),
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
