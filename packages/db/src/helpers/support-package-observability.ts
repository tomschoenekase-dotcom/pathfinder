import { createHash } from 'node:crypto'

import { z } from 'zod'
import {
  SupportCompletionGuestObservability,
  nativeCoreVisibleStateHash,
  type SupportCompletionGuestObservability as GuestObservability,
} from '@pathfinder/contracts'

import { db } from '../client'
import {
  applyNativeGuestContentRead,
  resolveNativeGuestReadSnapshotAction,
} from './native-guest-content-read'

type TransactionClient = Parameters<Parameters<typeof db.$transaction>[0]>[0]
export type SupportPackageObservabilityReader = Pick<
  TransactionClient,
  | 'contentVersion'
  | 'nativeVenueDeploymentEvaluationEvidence'
  | 'nativeVenueDeploymentHead'
  | 'place'
  | 'tenantFeatureFlag'
  | 'venue'
  | 'venueKnowledgeEntry'
>

const MAX_OBSERVABLE_EFFECTS = 500
export class SupportPackageObservabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupportPackageObservabilityError'
  }
}
const Hash = z.string().regex(/^[a-f0-9]{64}$/u)
const AppliedEffect = z
  .object({
    itemKey: z.string().uuid(),
    entityType: z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY']),
    entityId: z.string().min(1).max(191),
    operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
    applyVersionId: z.string().uuid(),
    snapshotSchemaVersion: z.number().int().positive(),
    beforeState: z.record(z.unknown()).nullable(),
    afterState: z.record(z.unknown()).nullable(),
  })
  .strict()
const AppliedManifestV3 = z
  .object({
    schemaVersion: z.literal(3),
    rollbackContractVersion: z.literal(2),
    postApplyDigest: Hash,
    effects: z.array(AppliedEffect).min(1).max(MAX_OBSERVABLE_EFFECTS),
  })
  .strict()

const venueGuestKeys = [
  'name',
  'description',
  'category',
  'guideNotes',
  'aiGuideNotes',
  'aiTone',
  'tonePreset',
  'tonePresetVersion',
  'aiGuideName',
  'chatTheme',
  'chatAccentColor',
  'chatFont',
  'chatLogoUrl',
  'chatBannerUrl',
  'guideMode',
  'defaultCenterLat',
  'defaultCenterLng',
  'geoBoundary',
  'isActive',
] as const
const placeGuestKeys = [
  'name',
  'type',
  'itemType',
  'shortDescription',
  'longDescription',
  'lat',
  'lng',
  'tags',
  'importanceScore',
  'areaName',
  'hours',
  'photoUrl',
  'isActive',
  'sourceType',
  'sourceName',
  'sourceUrl',
] as const
const knowledgeGuestKeys = [
  'title',
  'category',
  'content',
  'isEnabled',
  'sourceType',
  'sourceName',
  'sourceUrl',
] as const

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function changedGuestState(effect: z.infer<typeof AppliedEffect>): Record<string, unknown> | null {
  if (effect.operation === 'DELETE') return null
  if (!effect.afterState) return null
  const keys =
    effect.entityType === 'VENUE'
      ? venueGuestKeys
      : effect.entityType === 'PLACE'
        ? placeGuestKeys
        : knowledgeGuestKeys
  const changed = Object.fromEntries(
    keys
      .filter(
        (key) =>
          effect.operation === 'CREATE' ||
          canonicalJson(effect.beforeState?.[key]) !== canonicalJson(effect.afterState?.[key]),
      )
      .map((key) => [key, effect.afterState![key]]),
  )
  return changed
}

function isGuestVisibleAfter(effect: z.infer<typeof AppliedEffect>): boolean {
  if (effect.operation === 'DELETE' || !effect.afterState) return false
  if (effect.entityType === 'PLACE') return effect.afterState.isActive !== false
  if (effect.entityType === 'KNOWLEDGE_ENTRY') return effect.afterState.isEnabled !== false
  return effect.afterState.isActive !== false
}

function projectKeys(source: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, source[key]]))
}

function fail(packageId: string, reason: string): never {
  throw new SupportPackageObservabilityError(
    `Linked venue package ${packageId} is not guest-observable: ${reason}`,
  )
}

export async function readSupportPackageGuestObservability(input: {
  client: SupportPackageObservabilityReader
  tenantId: string
  venueId: string
  packages: Array<{ packageId: string; schemaVersion: number; appliedEntities: unknown }>
  verifiedAt?: Date
  environment?: Readonly<Record<string, string | undefined>>
}): Promise<GuestObservability> {
  if (input.packages.length === 0) {
    const identity = {
      contractVersion: 1 as const,
      configuredPath: 'NOT_APPLICABLE' as const,
      reason: 'NO_LINKED_PACKAGES' as const,
      releaseId: null,
      nativeStateHash: null,
      effects: [],
    }
    return SupportCompletionGuestObservability.parse({
      ...identity,
      verifiedAt: (input.verifiedAt ?? new Date()).toISOString(),
      digest: digest(identity),
    })
  }
  const manifests = input.packages.map((pkg) => {
    if (pkg.schemaVersion !== 3)
      fail(pkg.packageId, `schema version ${pkg.schemaVersion} has no supported observable receipt`)
    const parsed = AppliedManifestV3.safeParse(pkg.appliedEntities)
    if (!parsed.success) fail(pkg.packageId, 'apply evidence is missing or malformed')
    return { packageId: pkg.packageId, manifest: parsed.data }
  })
  const manifestEffects = manifests.flatMap(({ packageId, manifest }) =>
    manifest.effects.map((effect) => ({ packageId, effect })),
  )
  if (manifestEffects.length > MAX_OBSERVABLE_EFFECTS)
    fail(input.packages[0]?.packageId ?? 'unknown', 'observable effect count exceeds 500')

  const versions = await input.client.contentVersion.findMany({
    where: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      venuePackageId: { in: input.packages.map(({ packageId }) => packageId) },
      venuePackageAction: 'APPLY',
    },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    take: MAX_OBSERVABLE_EFFECTS + 1,
    select: {
      id: true,
      venuePackageId: true,
      entityType: true,
      entityId: true,
      operation: true,
      beforeState: true,
      afterState: true,
    },
  })
  if (versions.length > MAX_OBSERVABLE_EFFECTS)
    fail(input.packages[0]?.packageId ?? 'unknown', 'observable apply evidence exceeds 500 rows')
  const versionById = new Map(versions.map((version) => [version.id, version]))
  for (const { packageId, effect } of manifestEffects) {
    const version = versionById.get(effect.applyVersionId)
    if (
      !version ||
      version.venuePackageId !== packageId ||
      version.entityType !== effect.entityType ||
      version.entityId !== effect.entityId ||
      version.operation !== effect.operation ||
      canonicalJson(version.beforeState) !== canonicalJson(effect.beforeState) ||
      canonicalJson(version.afterState) !== canonicalJson(effect.afterState)
    )
      fail(packageId, `apply evidence ${effect.applyVersionId} does not match immutable history`)
  }
  if (versionById.size !== manifestEffects.length)
    fail(input.packages[0]?.packageId ?? 'unknown', 'apply history contains unbound effects')

  const placeIds = manifestEffects
    .filter(({ effect }) => effect.entityType === 'PLACE')
    .map(({ effect }) => effect.entityId)
  const knowledgeIds = manifestEffects
    .filter(({ effect }) => effect.entityType === 'KNOWLEDGE_ENTRY')
    .map(({ effect }) => effect.entityId)
  const [venue, places, knowledgeEntries, nativeSnapshot] = await Promise.all([
    input.client.venue.findFirst({ where: { id: input.venueId, tenantId: input.tenantId } }),
    input.client.place.findMany({
      where: {
        id: { in: placeIds },
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
    }),
    input.client.venueKnowledgeEntry.findMany({
      where: {
        id: { in: knowledgeIds },
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
    }),
    resolveNativeGuestReadSnapshotAction({
      client: input.client,
      tenantId: input.tenantId,
      venueId: input.venueId,
      ...(input.environment ? { environment: input.environment } : {}),
    }),
  ])
  if (!venue) fail(input.packages[0]?.packageId ?? 'unknown', 'venue is unavailable')
  const placeById = new Map(places.map((row) => [row.id, row]))
  const knowledgeById = new Map(knowledgeEntries.map((row) => [row.id, row]))
  const publicPlaces = places.filter((row) => row.isActive && row.visibility === 'PUBLIC')
  const publicKnowledgeEntries = knowledgeEntries.filter(
    (row) => row.isEnabled && row.visibility === 'PUBLIC',
  )
  const guestRead = applyNativeGuestContentRead({
    snapshot: nativeSnapshot,
    legacyPlaces: publicPlaces,
    legacyKnowledgeEntries: publicKnowledgeEntries.map((row) => ({ ...row, distance: 0 })),
  })
  const guestPlaceById = new Map(guestRead.places.map((row) => [row.id, row]))
  const guestKnowledgeById = new Map(guestRead.knowledgeEntries.map((row) => [row.id, row]))

  const receipts = manifestEffects.map(({ packageId, effect }) => {
    const changedState = changedGuestState(effect)
    if (effect.operation !== 'DELETE' && (!changedState || Object.keys(changedState).length === 0))
      fail(packageId, `apply evidence ${effect.applyVersionId} has no changed guest-visible fields`)
    if (effect.operation === 'CREATE' && !isGuestVisibleAfter(effect))
      fail(packageId, `apply evidence ${effect.applyVersionId} creates no guest-visible content`)
    const expected = isGuestVisibleAfter(effect) ? changedState : null
    let observed: Record<string, unknown> | null = null
    let readPath: 'LIVE_VENUE' | 'LEGACY' | 'DARK' | 'NATIVE'
    if (effect.entityType === 'VENUE') {
      readPath = 'LIVE_VENUE'
      observed =
        expected === null
          ? (venue as { isActive?: boolean }).isActive === false
            ? null
            : { present: true }
          : projectKeys(venue as Record<string, unknown>, expected)
    } else if (effect.entityType === 'PLACE') {
      readPath = guestRead.path
      const legacy = placeById.get(effect.entityId)
      const guest = guestPlaceById.get(effect.entityId)
      if (effect.operation !== 'DELETE' && legacy?.sourcePackageId !== packageId)
        fail(packageId, `place ${effect.entityId} no longer has this package as its source`)
      if (
        effect.operation !== 'DELETE' &&
        legacy &&
        changedState &&
        digest(projectKeys(legacy as Record<string, unknown>, changedState)) !==
          digest(changedState)
      )
        fail(packageId, `place ${effect.entityId} differs from its apply evidence in legacy state`)
      if (effect.operation !== 'DELETE' && legacy?.visibility !== 'PUBLIC')
        fail(packageId, `place ${effect.entityId} is not publicly visible`)
      const nativePlace = nativeSnapshot.state?.places.find(({ id }) => id === effect.entityId)
      if (
        effect.operation !== 'DELETE' &&
        guestRead.path === 'NATIVE' &&
        expected !== null &&
        nativePlace?.sourcePackageId !== packageId
      )
        fail(packageId, `native place ${effect.entityId} no longer has this package as its source`)
      if (expected === null && nativePlace)
        fail(packageId, `native place ${effect.entityId} remains guest-visible`)
      observed =
        expected === null
          ? legacy && effect.operation === 'DELETE'
            ? { present: true }
            : guest
              ? { present: true }
              : null
          : expected && legacy && guest
            ? projectKeys({ ...legacy, ...guest, isActive: true, visibility: 'PUBLIC' }, expected)
            : null
    } else {
      readPath = guestRead.path
      const legacy = knowledgeById.get(effect.entityId)
      const guest = guestKnowledgeById.get(effect.entityId)
      if (effect.operation !== 'DELETE' && legacy?.sourcePackageId !== packageId)
        fail(
          packageId,
          `knowledge entry ${effect.entityId} no longer has this package as its source`,
        )
      if (
        effect.operation !== 'DELETE' &&
        legacy &&
        changedState &&
        digest(projectKeys(legacy as Record<string, unknown>, changedState)) !==
          digest(changedState)
      )
        fail(
          packageId,
          `knowledge entry ${effect.entityId} differs from its apply evidence in legacy state`,
        )
      if (effect.operation !== 'DELETE' && legacy?.visibility !== 'PUBLIC')
        fail(packageId, `knowledge entry ${effect.entityId} is not publicly visible`)
      const nativeKnowledge = nativeSnapshot.state?.knowledgeEntries.find(
        ({ id }) => id === effect.entityId,
      )
      if (
        effect.operation !== 'DELETE' &&
        guestRead.path === 'NATIVE' &&
        expected !== null &&
        nativeKnowledge?.sourcePackageId !== packageId
      )
        fail(
          packageId,
          `native knowledge entry ${effect.entityId} no longer has this package as its source`,
        )
      if (expected === null && nativeKnowledge)
        fail(packageId, `native knowledge entry ${effect.entityId} remains guest-visible`)
      observed =
        expected === null
          ? legacy && effect.operation === 'DELETE'
            ? { present: true }
            : guest
              ? { present: true }
              : null
          : expected && legacy && guest
            ? projectKeys({ ...legacy, ...guest, isEnabled: true, visibility: 'PUBLIC' }, expected)
            : null
    }
    const expectedHash = expected === null ? null : digest(expected)
    const observedHash = observed === null ? null : digest(observed)
    if (expectedHash !== observedHash)
      fail(
        packageId,
        `${effect.entityType.toLowerCase()} ${effect.entityId} differs from its apply evidence` +
          (expected && observed
            ? ` in fields ${Object.keys(expected)
                .filter((key) => canonicalJson(expected[key]) !== canonicalJson(observed[key]))
                .join(', ')}`
            : ''),
      )
    return {
      packageId,
      applyVersionId: effect.applyVersionId,
      entityType: effect.entityType,
      entityId: effect.entityId,
      operation: effect.operation,
      readPath,
      expectedGuestStateHash: expectedHash,
      observedGuestStateHash: observedHash,
    }
  })
  const identity = {
    contractVersion: 1 as const,
    configuredPath: nativeSnapshot.path,
    reason: nativeSnapshot.reason,
    releaseId: nativeSnapshot.releaseId,
    nativeStateHash:
      nativeSnapshot.path === 'NATIVE' && nativeSnapshot.state
        ? nativeCoreVisibleStateHash(nativeSnapshot.state)
        : null,
    effects: receipts,
  }
  return SupportCompletionGuestObservability.parse({
    ...identity,
    verifiedAt: (input.verifiedAt ?? new Date()).toISOString(),
    digest: digest(identity),
  })
}
