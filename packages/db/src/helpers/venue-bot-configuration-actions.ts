import {
  TONE_PRESET_BEHAVIOR_VERSION,
  TONE_PRESET_TO_LEGACY_AI_TONE,
  VenueBotConfigurationSnapshot,
  VenueBotConfigurationValues,
  type UpdateVenueBotConfiguration,
} from '@pathfinder/contracts'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'
import {
  VenueActionError,
  type VenueActionClient,
  type VenueHumanActor,
} from './venue-create-action'

export const venueBotConfigurationSelect = {
  id: true,
  venueId: true,
  presentationMode: true,
  personalityMode: true,
  tonePreset: true,
  tonePresetVersion: true,
  responseDepth: true,
  personalityProfileId: true,
  characterKey: true,
  customCharacterId: true,
  publicDisplayName: true,
  greeting: true,
  voiceProfileId: true,
  revision: true,
  updatedAt: true,
} as const

type VenueBotConfigurationActionClient = Pick<typeof db, 'venueBotConfiguration'>

function requireActor(actor: VenueHumanActor): void {
  if (actor.type !== 'HUMAN' || !actor.id || !['OWNER', 'MANAGER'].includes(actor.role)) {
    throw new VenueActionError('INVALID_INPUT', 'A human venue manager is required')
  }
}

type VenueBotConfigurationRow = {
  id: string
  venueId: string
  presentationMode: 'CLASSIC' | 'CHARACTER'
  personalityMode: 'PRESET' | 'CUSTOM'
  tonePreset: string
  tonePresetVersion: number
  responseDepth: 'BRIEF' | 'BALANCED' | 'DETAILED'
  personalityProfileId: string | null
  characterKey: string | null
  customCharacterId: string | null
  publicDisplayName: string | null
  greeting: string | null
  voiceProfileId: string | null
  revision: number
  updatedAt: Date
}

function serialize(value: VenueBotConfigurationRow): VenueBotConfigurationSnapshot {
  return VenueBotConfigurationSnapshot.parse({
    ...value,
    updatedAt: value.updatedAt.toISOString(),
  })
}

function safeAudit(value: VenueBotConfigurationRow) {
  return {
    presentationMode: value.presentationMode,
    personalityMode: value.personalityMode,
    tonePreset: value.tonePreset,
    tonePresetVersion: value.tonePresetVersion,
    responseDepth: value.responseDepth,
    personalityProfileId: value.personalityProfileId,
    characterKey: value.characterKey,
    customCharacterId: value.customCharacterId,
    hasPublicDisplayName: value.publicDisplayName !== null,
    hasGreeting: value.greeting !== null,
    hasVoiceProfile: value.voiceProfileId !== null,
    revision: value.revision,
  }
}

export async function getVenueBotConfigurationAction(
  input: { tenantId: string; venueId: string },
  client: VenueBotConfigurationActionClient = db,
): Promise<VenueBotConfigurationSnapshot> {
  const value = await client.venueBotConfiguration.findFirst({
    where: { tenantId: input.tenantId, venueId: input.venueId },
    select: venueBotConfigurationSelect,
  })
  if (!value) throw new VenueActionError('NOT_FOUND', 'Venue not found')
  return serialize(value)
}

export async function updateVenueBotConfigurationAction(
  input: {
    tenantId: string
    venueId: string
    expectedRevision: number
    actor: VenueHumanActor
    fields: Omit<UpdateVenueBotConfiguration, 'venueId' | 'expectedRevision'>
  },
  client: VenueActionClient = db,
): Promise<VenueBotConfigurationSnapshot> {
  requireActor(input.actor)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await setContentVersionContext(tx, { actorId: input.actor.id })
    await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId: input.venueId })

    const before = await tx.venueBotConfiguration.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: venueBotConfigurationSelect,
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    if (before.revision !== input.expectedRevision) {
      throw new VenueActionError(
        'CONFLICT',
        'Venue Bot configuration changed; refresh and try again.',
      )
    }

    const next = VenueBotConfigurationValues.parse({
      presentationMode: input.fields.presentationMode ?? before.presentationMode,
      personalityMode: input.fields.personalityMode ?? before.personalityMode,
      tonePreset: input.fields.tonePreset ?? before.tonePreset,
      tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
      responseDepth: input.fields.responseDepth ?? before.responseDepth,
      personalityProfileId:
        input.fields.personalityProfileId !== undefined
          ? input.fields.personalityProfileId
          : before.personalityProfileId,
      characterKey:
        input.fields.characterKey !== undefined ? input.fields.characterKey : before.characterKey,
      customCharacterId:
        input.fields.customCharacterId !== undefined
          ? input.fields.customCharacterId
          : before.customCharacterId,
      publicDisplayName:
        input.fields.publicDisplayName !== undefined
          ? input.fields.publicDisplayName
          : before.publicDisplayName,
      greeting: input.fields.greeting !== undefined ? input.fields.greeting : before.greeting,
      voiceProfileId:
        input.fields.voiceProfileId !== undefined
          ? input.fields.voiceProfileId
          : before.voiceProfileId,
    })

    if (next.personalityProfileId) {
      const profile = await tx.personalityProfile.findFirst({
        where: {
          id: next.personalityProfileId,
          tenantId: input.tenantId,
          status: 'ACTIVE',
        },
        select: { id: true, venueId: true },
      })
      if (!profile || (profile.venueId !== null && profile.venueId !== input.venueId)) {
        throw new VenueActionError('NOT_FOUND', 'Personality profile not found')
      }
    }
    if (next.customCharacterId) {
      const character = await tx.customCharacter.findFirst({
        where: {
          id: next.customCharacterId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
      if (!character) throw new VenueActionError('NOT_FOUND', 'Custom character not found')
    }

    const changed = await tx.venueBotConfiguration.updateMany({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        revision: input.expectedRevision,
      },
      data: {
        ...next,
        revision: { increment: 1 },
        updatedBy: input.actor.id,
      },
    })
    if (changed.count !== 1) {
      throw new VenueActionError(
        'CONFLICT',
        'Venue Bot configuration changed; refresh and try again.',
      )
    }

    if (next.tonePreset !== before.tonePreset) {
      const compatibleVenue = await tx.venue.updateMany({
        where: { id: input.venueId, tenantId: input.tenantId },
        data: {
          tonePreset: next.tonePreset,
          tonePresetVersion: TONE_PRESET_BEHAVIOR_VERSION,
          aiTone: TONE_PRESET_TO_LEGACY_AI_TONE[next.tonePreset],
          updatedAt: new Date(),
        },
      })
      if (compatibleVenue.count !== 1) throw new VenueActionError('NOT_FOUND', 'Venue not found')
    }

    const saved = await tx.venueBotConfiguration.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: venueBotConfigurationSelect,
    })
    if (!saved) throw new VenueActionError('CONFLICT', 'Venue Bot configuration was not saved')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'venue.bot-configuration.updated',
        targetType: 'VenueBotConfiguration',
        targetId: saved.id,
        beforeState: safeAudit(before),
        afterState: safeAudit(saved),
      },
      tx,
    )
    return serialize(saved)
  })
}
