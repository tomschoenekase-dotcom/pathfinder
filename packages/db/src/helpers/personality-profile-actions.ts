import {
  CustomPersonalityBoundsSchema,
  PersonalityProfileSnapshot,
  type PersonalityProfileDraft,
} from '@pathfinder/contracts'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'
import { VenueActionError, type VenueHumanActor } from './venue-create-action'

type PersonalityClient = Pick<typeof db, 'personalityProfile'>

const select = {
  id: true,
  venueId: true,
  name: true,
  warmth: true,
  brevity: true,
  energy: true,
  formality: true,
  customInstruction: true,
  revision: true,
  updatedAt: true,
} as const

function requireActor(actor: VenueHumanActor): void {
  if (actor.type !== 'HUMAN' || !actor.id || !['OWNER', 'MANAGER'].includes(actor.role)) {
    throw new VenueActionError('INVALID_INPUT', 'A human venue manager is required')
  }
}

function stored(bounds: PersonalityProfileDraft['bounds']) {
  const parsed = CustomPersonalityBoundsSchema.parse(bounds)
  return {
    warmth: Math.round(parsed.warmth * 100),
    brevity: Math.round(parsed.brevity * 100),
    energy: Math.round(parsed.energy * 100),
    formality: Math.round(parsed.formality * 100),
    customInstruction: parsed.customInstruction?.trim() || null,
  }
}

function snapshot(row: {
  id: string
  venueId: string | null
  name: string
  warmth: number
  brevity: number
  energy: number
  formality: number
  customInstruction: string | null
  revision: number
  updatedAt: Date
}) {
  return PersonalityProfileSnapshot.parse({
    id: row.id,
    venueId: row.venueId,
    name: row.name,
    bounds: {
      warmth: row.warmth / 100,
      brevity: row.brevity / 100,
      energy: row.energy / 100,
      formality: row.formality / 100,
      ...(row.customInstruction ? { customInstruction: row.customInstruction } : {}),
    },
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  })
}

export async function listPersonalityProfilesAction(
  input: { tenantId: string; venueId: string },
  client: PersonalityClient = db,
) {
  const rows = await client.personalityProfile.findMany({
    where: {
      tenantId: input.tenantId,
      status: 'ACTIVE',
      OR: [{ venueId: input.venueId }, { venueId: null }],
    },
    orderBy: [{ venueId: 'desc' }, { name: 'asc' }],
    select,
  })
  return rows.map(snapshot)
}

export async function createPersonalityProfileAction(
  input: {
    tenantId: string
    venueId: string
    profile: PersonalityProfileDraft
    actor: VenueHumanActor
  },
  client = db,
) {
  requireActor(input.actor)
  const profile = PersonalityProfileSnapshot.pick({ name: true, bounds: true }).parse(input.profile)
  return client.$transaction(async (tx) => {
    await setContentVersionContext(tx, { actorId: input.actor.id })
    await lockVenueContentMutation(tx, input)
    const created = await tx.personalityProfile.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: profile.name,
        ...stored(profile.bounds),
        createdBy: input.actor.id,
        updatedBy: input.actor.id,
      },
      select,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'personality_profile.created',
        targetType: 'PersonalityProfile',
        targetId: created.id,
        beforeState: { status: 'ABSENT' },
        afterState: {
          venueId: input.venueId,
          revision: created.revision,
          hasCustomInstruction: created.customInstruction !== null,
        },
      },
      tx,
    )
    return snapshot(created)
  })
}

export async function updatePersonalityProfileAction(
  input: {
    tenantId: string
    venueId: string
    profileId: string
    expectedRevision: number
    profile: PersonalityProfileDraft
    actor: VenueHumanActor
  },
  client = db,
) {
  requireActor(input.actor)
  const profile = PersonalityProfileSnapshot.pick({ name: true, bounds: true }).parse(input.profile)
  return client.$transaction(async (tx) => {
    await setContentVersionContext(tx, { actorId: input.actor.id })
    await lockVenueContentMutation(tx, input)
    const before = await tx.personalityProfile.findFirst({
      where: {
        id: input.profileId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'ACTIVE',
      },
      select,
    })
    if (!before) throw new VenueActionError('NOT_FOUND', 'Personality profile not found')
    if (before.revision !== input.expectedRevision) {
      throw new VenueActionError('CONFLICT', 'Personality profile changed; refresh and try again.')
    }
    const changed = await tx.personalityProfile.updateMany({
      where: {
        id: input.profileId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'ACTIVE',
        revision: input.expectedRevision,
      },
      data: {
        name: profile.name,
        ...stored(profile.bounds),
        revision: { increment: 1 },
        updatedBy: input.actor.id,
      },
    })
    if (changed.count !== 1) {
      throw new VenueActionError('CONFLICT', 'Personality profile changed; refresh and try again.')
    }
    const saved = await tx.personalityProfile.findFirst({
      where: { id: input.profileId, tenantId: input.tenantId, venueId: input.venueId },
      select,
    })
    if (!saved) throw new VenueActionError('CONFLICT', 'Personality profile was not saved')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'personality_profile.updated',
        targetType: 'PersonalityProfile',
        targetId: input.profileId,
        beforeState: { revision: before.revision },
        afterState: {
          revision: saved.revision,
          hasCustomInstruction: saved.customInstruction !== null,
        },
      },
      tx,
    )
    return snapshot(saved)
  })
}
