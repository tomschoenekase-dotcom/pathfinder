import { z } from 'zod'

import { KnowledgeEntryInput } from './knowledge'
import { PlaceInput } from './place'
import { VENUE_CONTENT_IMPORT_LIMIT, canonicalVenueContentImportPayload } from './venue-content'

export const VENUE_PACKAGE_SCHEMA_VERSION_V1 = 1 as const
export const VENUE_PACKAGE_SCHEMA_VERSION_V2 = 2 as const
export const VENUE_PACKAGE_SCHEMA_VERSION_V3 = 3 as const
/** Legacy alias retained for callers that still emit the frozen additive V1 format. */
export const VENUE_PACKAGE_SCHEMA_VERSION = VENUE_PACKAGE_SCHEMA_VERSION_V1
export const VENUE_PACKAGE_LATEST_SCHEMA_VERSION = VENUE_PACKAGE_SCHEMA_VERSION_V3
export const VENUE_PACKAGE_ITEM_LIMIT = VENUE_CONTENT_IMPORT_LIMIT

const VenueIdentityPatch = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    category: z.string().max(100).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Include at least one venue identity field')

const VenueBrandingPatch = z
  .object({
    chatTheme: z
      .enum(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark'])
      .nullable()
      .optional(),
    chatAccentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour e.g. #3A7BD5')
      .nullable()
      .optional(),
    chatFont: z
      .enum(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair'])
      .nullable()
      .optional(),
    chatLogoUrl: z.string().url().max(500).nullable().optional(),
    chatBannerUrl: z.string().url().max(500).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Include at least one venue branding field')

const VenueAiBehaviorPatch = z
  .object({
    aiGuideNotes: z.string().max(2000).nullable().optional(),
    aiTone: z.enum(['FRIENDLY', 'PROFESSIONAL', 'PLAYFUL']).nullable().optional(),
    aiGuideName: z.string().max(80).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Include at least one AI behavior field')

export const VenuePackageVenuePatch = z
  .object({
    identity: VenueIdentityPatch.optional(),
    guideNotes: z.string().max(2000).nullable().optional(),
    branding: VenueBrandingPatch.optional(),
    aiBehavior: VenueAiBehaviorPatch.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Include at least one venue field')

const VenuePackagePayloadV1Object = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V1),
    places: z.array(PlaceInput).max(VENUE_CONTENT_IMPORT_LIMIT),
    knowledgeEntries: z.array(KnowledgeEntryInput.strict()).max(VENUE_CONTENT_IMPORT_LIMIT),
  })
  .strict()

const VenuePackagePayloadV2Object = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V2),
    venue: VenuePackageVenuePatch.optional(),
    places: z.array(PlaceInput).max(VENUE_CONTENT_IMPORT_LIMIT).default([]),
    knowledgeEntries: z
      .array(KnowledgeEntryInput.strict())
      .max(VENUE_CONTENT_IMPORT_LIMIT)
      .default([]),
  })
  .strict()

export const VenuePackageSourceProvenance = z
  .object({
    sourceType: z.string().trim().min(1).max(64),
    sourceName: z.string().trim().min(1).max(200).optional(),
    sourceUrl: z
      .string()
      .url()
      .max(2000)
      .refine((value) => {
        const url = new URL(value)
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          !url.username &&
          !url.password &&
          !url.search.includes('%') &&
          !url.hash.includes('%') &&
          ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(
            (key) =>
              /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu.test(
                key,
              ),
          )
        )
      }, 'Source URLs must use HTTP(S) and must not contain credentials')
      .optional(),
    contentOrigin: z.enum(['HUMAN_AUTHORED', 'AI_GENERATED']),
  })
  .strict()

const VenuePackageItemIdentity = {
  itemKey: z.string().uuid(),
  provenance: VenuePackageSourceProvenance,
} as const

export const VenuePackagePlaceDesiredState = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1),
    itemType: z.string().nullable(),
    shortDescription: z.string().max(500).nullable(),
    longDescription: z.string().max(2000).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int().min(0).max(100),
    areaName: z.string().max(200).nullable(),
    hours: z.string().max(200).nullable(),
    photoUrl: z.string().url().max(2000).nullable(),
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.lat === null) !== (value.lng === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lat'],
        message: 'Latitude and longitude must both be null or both be supplied',
      })
    }
  })

export const VenuePackageKnowledgeDesiredState = z
  .object({
    title: z.string().min(1).max(200),
    category: z.string().min(1).max(100),
    content: z.string().min(1).max(5000),
    isEnabled: z.boolean(),
  })
  .strict()

const VenuePackagePlaceOperations = z
  .object({
    create: z
      .array(z.object({ ...VenuePackageItemIdentity, value: PlaceInput }).strict())
      .default([]),
    update: z
      .array(
        z
          .object({
            ...VenuePackageItemIdentity,
            id: z.string().cuid(),
            value: VenuePackagePlaceDesiredState,
          })
          .strict(),
      )
      .default([]),
    delete: z
      .array(z.object({ ...VenuePackageItemIdentity, id: z.string().cuid() }).strict())
      .default([]),
  })
  .strict()

const VenuePackageKnowledgeOperations = z
  .object({
    create: z
      .array(
        z.object({ ...VenuePackageItemIdentity, value: KnowledgeEntryInput.strict() }).strict(),
      )
      .default([]),
    update: z
      .array(
        z
          .object({
            ...VenuePackageItemIdentity,
            id: z.string().cuid(),
            value: VenuePackageKnowledgeDesiredState,
          })
          .strict(),
      )
      .default([]),
    delete: z
      .array(z.object({ ...VenuePackageItemIdentity, id: z.string().cuid() }).strict())
      .default([]),
  })
  .strict()

const VenuePackagePayloadV3Object = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V3),
    venue: VenuePackageVenuePatch.optional(),
    places: VenuePackagePlaceOperations,
    knowledgeEntries: VenuePackageKnowledgeOperations,
  })
  .strict()

type VersionThreeOperationInput = z.infer<typeof VenuePackagePayloadV3Object>

function validateVersionThreeOperations(
  input: VersionThreeOperationInput,
  ctx: z.RefinementCtx,
): void {
  const all = [
    ...input.places.create.map((operation) => ({ ...operation, path: 'places.create' })),
    ...input.places.update.map((operation) => ({ ...operation, path: 'places.update' })),
    ...input.places.delete.map((operation) => ({ ...operation, path: 'places.delete' })),
    ...input.knowledgeEntries.create.map((operation) => ({
      ...operation,
      path: 'knowledgeEntries.create',
    })),
    ...input.knowledgeEntries.update.map((operation) => ({
      ...operation,
      path: 'knowledgeEntries.update',
    })),
    ...input.knowledgeEntries.delete.map((operation) => ({
      ...operation,
      path: 'knowledgeEntries.delete',
    })),
  ]
  if (all.length === 0 && input.venue === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Include at least one package operation' })
  }
  if (all.length > VENUE_PACKAGE_ITEM_LIMIT) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: VENUE_PACKAGE_ITEM_LIMIT,
      type: 'array',
      inclusive: true,
      message: `A venue package can contain at most ${VENUE_PACKAGE_ITEM_LIMIT} total item operations`,
    })
  }
  const itemKeys = new Set<string>()
  all.forEach((operation, index) => {
    if (itemKeys.has(operation.itemKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [operation.path, index, 'itemKey'],
        message: 'Package item keys must be unique',
      })
    }
    itemKeys.add(operation.itemKey)
  })
  for (const [path, operations] of [
    ['places', [...input.places.update, ...input.places.delete]],
    ['knowledgeEntries', [...input.knowledgeEntries.update, ...input.knowledgeEntries.delete]],
  ] as const) {
    const ids = new Set<string>()
    operations.forEach((operation, index) => {
      if (ids.has(operation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path, index, 'id'],
          message: 'An existing entity can be targeted only once per package',
        })
      }
      ids.add(operation.id)
    })
  }
}

function validatePayloadOperations(
  input: {
    schemaVersion: 1 | 2
    places: Array<{ lat?: number | undefined; lng?: number | undefined }>
    knowledgeEntries: unknown[]
    venue?: unknown
  },
  ctx: z.RefinementCtx,
): void {
  if (
    input.places.length + input.knowledgeEntries.length === 0 &&
    (input.schemaVersion === VENUE_PACKAGE_SCHEMA_VERSION_V1 || input.venue === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        input.schemaVersion === VENUE_PACKAGE_SCHEMA_VERSION_V1
          ? 'Include at least one guide item or knowledge entry'
          : 'Include at least one venue field, guide item, or knowledge entry',
    })
  }

  if (input.places.length + input.knowledgeEntries.length > VENUE_PACKAGE_ITEM_LIMIT) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: VENUE_PACKAGE_ITEM_LIMIT,
      type: 'array',
      inclusive: true,
      message: `A venue package can contain at most ${VENUE_PACKAGE_ITEM_LIMIT} total items`,
    })
  }

  input.places.forEach((place, index) => {
    if ((place.lat === undefined) !== (place.lng === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['places', index],
        message: 'Latitude and longitude must be supplied together',
      })
    }
  })
}

export const VenuePackagePayloadV1 =
  VenuePackagePayloadV1Object.superRefine(validatePayloadOperations)
export const VenuePackagePayloadV2 =
  VenuePackagePayloadV2Object.superRefine(validatePayloadOperations)
export const VenuePackagePayloadV3 = VenuePackagePayloadV3Object.superRefine(
  validateVersionThreeOperations,
)

export const VenuePackagePayload = z
  .discriminatedUnion('schemaVersion', [
    VenuePackagePayloadV1Object,
    VenuePackagePayloadV2Object,
    VenuePackagePayloadV3Object,
  ])
  .superRefine((input, ctx) => {
    if (input.schemaVersion === VENUE_PACKAGE_SCHEMA_VERSION_V3) {
      validateVersionThreeOperations(input, ctx)
    } else {
      validatePayloadOperations(input, ctx)
    }
  })

export const VenuePackagePreviewInput = z
  .object({
    venueId: z.string().cuid(),
    payload: VenuePackagePayload,
  })
  .strict()

export const VenuePackageDraftInput = VenuePackagePreviewInput.extend({
  draftKey: z.string().uuid(),
}).strict()

export const VenuePackageByIdInput = z.object({ id: z.string().cuid() }).strict()

export const VenuePackageLifecycleInput = VenuePackageByIdInput.extend({
  expectedUpdatedAt: z.coerce.date(),
  commandKey: z.string().uuid(),
}).strict()

export const VenuePackageApprovalInput = VenuePackageLifecycleInput.extend({
  acknowledgedWarningDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgedPayloadHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const VenuePackageIssue = z
  .object({
    code: z.string().min(1),
    path: z.string(),
    message: z.string().min(1),
  })
  .strict()

const VenuePackageSemanticScope = z
  .object({
    embeddingProfile: z.string().min(1),
    inputCount: z.number().int().nonnegative(),
    scannedInputCount: z.number().int().nonnegative(),
    existingCount: z.number().int().nonnegative(),
    scannedExistingCount: z.number().int().nonnegative(),
  })
  .strict()

export const VenuePackageSemanticDuplicateScan = z
  .object({
    status: z.enum(['NOT_RUN', 'COMPLETE', 'INCOMPLETE']),
    similarityThreshold: z.number().finite().min(-1).max(1),
    scopes: z
      .object({
        places: VenuePackageSemanticScope,
        knowledgeEntries: VenuePackageSemanticScope,
      })
      .strict(),
  })
  .strict()
  .superRefine((scan, ctx) => {
    for (const [name, scope] of Object.entries(scan.scopes)) {
      if (scope.scannedInputCount > scope.inputCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopes', name, 'scannedInputCount'],
          message: 'Scanned input count cannot exceed input count',
        })
      }
      if (scope.scannedExistingCount > scope.existingCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopes', name, 'scannedExistingCount'],
          message: 'Scanned existing count cannot exceed existing count',
        })
      }
      if (
        scan.status === 'COMPLETE' &&
        (scope.scannedInputCount !== scope.inputCount ||
          scope.scannedExistingCount !== scope.existingCount)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopes', name],
          message: 'Complete semantic scans must cover every input and existing item',
        })
      }
      if (
        scan.status === 'NOT_RUN' &&
        (scope.scannedInputCount !== 0 || scope.scannedExistingCount !== 0)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopes', name],
          message: 'A semantic scan that has not run cannot report scanned items',
        })
      }
    }
  })

export const VenuePackageValidationReport = z
  .object({
    errors: z.array(VenuePackageIssue),
    warnings: z.array(VenuePackageIssue),
    semanticDuplicateScan: VenuePackageSemanticDuplicateScan,
  })
  .strict()

const EmptyChangeSet = z.array(z.unknown()).max(0)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)

const PlaceAdditiveChanges = z
  .object({
    add: z.array(PlaceInput),
    change: EmptyChangeSet,
    remove: EmptyChangeSet,
    unchanged: z.number().int().nonnegative(),
  })
  .strict()

const KnowledgeAdditiveChanges = z
  .object({
    add: z.array(KnowledgeEntryInput.strict()),
    change: EmptyChangeSet,
    remove: EmptyChangeSet,
    unchanged: z.number().int().nonnegative(),
  })
  .strict()

export const VenuePackagePlaceSnapshot = z
  .object({
    id: z.string().cuid(),
    name: z.string(),
    type: z.string(),
    itemType: z.string().nullable(),
    shortDescription: z.string().nullable(),
    longDescription: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int(),
    areaName: z.string().nullable(),
    hours: z.string().nullable(),
    photoUrl: z.string().nullable(),
    isActive: z.boolean(),
  })
  .strict()

export const VenuePackageKnowledgeSnapshot = z
  .object({
    id: z.string().cuid(),
    title: z.string(),
    category: z.string(),
    content: z.string(),
    isEnabled: z.boolean(),
  })
  .strict()

const VersionId = z.string().uuid()
const ItemKey = z.string().uuid()
const VenuePackageDeleteDependency = z
  .object({ type: z.string().min(1), count: z.number().int().positive() })
  .strict()

function mutableChanges<
  TCreate extends z.ZodTypeAny,
  TUpdate extends z.ZodTypeAny,
  TSnapshot extends z.ZodTypeAny,
>(createValue: TCreate, updateValue: TUpdate, snapshot: TSnapshot) {
  return z
    .object({
      add: z.array(z.object({ itemKey: ItemKey, value: createValue }).strict()),
      change: z.array(
        z
          .object({
            itemKey: ItemKey,
            id: z.string().cuid(),
            expectedVersionId: VersionId,
            before: snapshot,
            after: updateValue,
          })
          .strict(),
      ),
      remove: z.array(
        z
          .object({
            itemKey: ItemKey,
            id: z.string().cuid(),
            expectedVersionId: VersionId,
            before: snapshot,
            dependencies: z.array(VenuePackageDeleteDependency),
          })
          .strict(),
      ),
      unchanged: z.number().int().nonnegative(),
    })
    .strict()
}

const nullableString = z.string().nullable()

export const VenuePackageVenueSnapshot = z
  .object({
    // Snapshots are factual rollback evidence. They deliberately accept legacy
    // values that predate today's write validation; only new patch values are bounded.
    name: z.string(),
    description: nullableString,
    category: nullableString,
    guideNotes: nullableString,
    chatTheme: nullableString,
    chatAccentColor: nullableString,
    chatFont: nullableString,
    chatLogoUrl: nullableString,
    chatBannerUrl: nullableString,
    aiGuideNotes: nullableString,
    aiTone: nullableString,
    aiGuideName: nullableString,
  })
  .strict()

function venueStringChange<TPath extends string, TValue extends z.ZodTypeAny>(
  path: TPath,
  after: TValue,
) {
  return z.object({ path: z.literal(path), before: nullableString, after }).strict()
}

export const VenuePackageVenueChange = z.discriminatedUnion('path', [
  z
    .object({
      path: z.literal('venue.identity.name'),
      before: z.string(),
      after: z.string().min(1).max(200),
    })
    .strict(),
  venueStringChange('venue.identity.description', z.string().max(1000).nullable()),
  venueStringChange('venue.identity.category', z.string().max(100).nullable()),
  venueStringChange('venue.guideNotes', z.string().max(2000).nullable()),
  venueStringChange(
    'venue.branding.chatTheme',
    z.enum(['default', 'forest', 'sunset', 'midnight', 'rose', 'dark']).nullable(),
  ),
  venueStringChange(
    'venue.branding.chatAccentColor',
    z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable(),
  ),
  venueStringChange(
    'venue.branding.chatFont',
    z.enum(['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair']).nullable(),
  ),
  venueStringChange('venue.branding.chatLogoUrl', z.string().url().max(500).nullable()),
  venueStringChange('venue.branding.chatBannerUrl', z.string().url().max(500).nullable()),
  venueStringChange('venue.aiBehavior.aiGuideNotes', z.string().max(2000).nullable()),
  venueStringChange(
    'venue.aiBehavior.aiTone',
    z.enum(['FRIENDLY', 'PROFESSIONAL', 'PLAYFUL']).nullable(),
  ),
  venueStringChange('venue.aiBehavior.aiGuideName', z.string().max(80).nullable()),
])

const StoredPreviewCommon = {
  payloadHash: Hash,
  baseDigest: Hash,
  warningDigest: Hash,
  report: VenuePackageValidationReport,
}

export const VenuePackageStoredPreviewV1 = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V1),
    ...StoredPreviewCommon,
    mode: z.literal('ADDITIVE_V1'),
    changes: z
      .object({
        places: PlaceAdditiveChanges,
        knowledgeEntries: KnowledgeAdditiveChanges,
      })
      .strict(),
  })
  .strict()

export const VenuePackageStoredPreviewV2 = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V2),
    ...StoredPreviewCommon,
    mode: z.literal('CONFIG_PATCH_AND_ADDITIVE_V2'),
    changes: z
      .object({
        venue: z
          .object({
            change: z.array(VenuePackageVenueChange),
            unchanged: z.number().int().nonnegative(),
          })
          .strict(),
        places: PlaceAdditiveChanges,
        knowledgeEntries: KnowledgeAdditiveChanges,
      })
      .strict(),
  })
  .strict()

export const VenuePackageStoredPreviewV3 = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V3),
    ...StoredPreviewCommon,
    mode: z.literal('MUTATING_V3'),
    changes: z
      .object({
        venue: z
          .object({
            expectedVersionId: VersionId.nullable(),
            change: z.array(VenuePackageVenueChange),
            unchanged: z.number().int().nonnegative(),
          })
          .strict(),
        places: mutableChanges(
          PlaceInput,
          VenuePackagePlaceDesiredState,
          VenuePackagePlaceSnapshot,
        ),
        knowledgeEntries: mutableChanges(
          KnowledgeEntryInput.strict(),
          VenuePackageKnowledgeDesiredState,
          VenuePackageKnowledgeSnapshot,
        ),
      })
      .strict(),
  })
  .strict()

export const VenuePackageStoredPreview = z.discriminatedUnion('schemaVersion', [
  VenuePackageStoredPreviewV1,
  VenuePackageStoredPreviewV2,
  VenuePackageStoredPreviewV3,
])

const AppliedPlace = z
  .object({
    id: z.string().cuid(),
    name: z.string().min(1).max(200),
    type: z.string().min(1),
    itemType: nullableString,
    shortDescription: nullableString,
    longDescription: nullableString,
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int().min(0).max(100),
    areaName: nullableString,
    hours: nullableString,
    photoUrl: nullableString,
  })
  .strict()

const AppliedKnowledgeEntry = KnowledgeEntryInput.extend({ id: z.string().cuid() }).strict()

export const VenuePackageAppliedEntitiesV1 = z
  .object({
    postApplyDigest: Hash,
    places: z.array(AppliedPlace),
    knowledgeEntries: z.array(AppliedKnowledgeEntry),
  })
  .strict()

export const VenuePackageAppliedEntitiesV2 = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V2),
    postApplyDigest: Hash,
    venue: z
      .object({ before: VenuePackageVenueSnapshot, after: VenuePackageVenueSnapshot })
      .strict()
      .nullable(),
    places: z.array(AppliedPlace),
    knowledgeEntries: z.array(AppliedKnowledgeEntry),
  })
  .strict()

export const VenuePackageAppliedEffectV3 = z
  .object({
    itemKey: ItemKey,
    entityType: z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY']),
    entityId: z.string(),
    operation: z.enum(['CREATE', 'UPDATE', 'DELETE']),
    applyVersionId: VersionId,
    snapshotSchemaVersion: z.number().int().positive(),
    beforeState: z.record(z.unknown()).nullable(),
    afterState: z.record(z.unknown()).nullable(),
  })
  .strict()

export const VenuePackageAppliedEntitiesV3 = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION_V3),
    rollbackContractVersion: z.literal(2),
    postApplyDigest: Hash,
    effects: z.array(VenuePackageAppliedEffectV3),
  })
  .strict()

/** V1 has no discriminator in persisted rows, so the compatibility union is intentionally ordered. */
export const VenuePackageAppliedEntities = z.union([
  VenuePackageAppliedEntitiesV1,
  VenuePackageAppliedEntitiesV2,
  VenuePackageAppliedEntitiesV3,
])

function canonicalVenuePatch(patch: z.infer<typeof VenuePackageVenuePatch> | undefined) {
  if (!patch) return null
  return {
    ...(patch.identity
      ? {
          identity: {
            ...(patch.identity.name !== undefined ? { name: patch.identity.name } : {}),
            ...(patch.identity.description !== undefined
              ? { description: patch.identity.description }
              : {}),
            ...(patch.identity.category !== undefined ? { category: patch.identity.category } : {}),
          },
        }
      : {}),
    ...(patch.guideNotes !== undefined ? { guideNotes: patch.guideNotes } : {}),
    ...(patch.branding
      ? {
          branding: {
            ...(patch.branding.chatTheme !== undefined
              ? { chatTheme: patch.branding.chatTheme }
              : {}),
            ...(patch.branding.chatAccentColor !== undefined
              ? { chatAccentColor: patch.branding.chatAccentColor }
              : {}),
            ...(patch.branding.chatFont !== undefined ? { chatFont: patch.branding.chatFont } : {}),
            ...(patch.branding.chatLogoUrl !== undefined
              ? { chatLogoUrl: patch.branding.chatLogoUrl }
              : {}),
            ...(patch.branding.chatBannerUrl !== undefined
              ? { chatBannerUrl: patch.branding.chatBannerUrl }
              : {}),
          },
        }
      : {}),
    ...(patch.aiBehavior
      ? {
          aiBehavior: {
            ...(patch.aiBehavior.aiGuideNotes !== undefined
              ? { aiGuideNotes: patch.aiBehavior.aiGuideNotes }
              : {}),
            ...(patch.aiBehavior.aiTone !== undefined ? { aiTone: patch.aiBehavior.aiTone } : {}),
            ...(patch.aiBehavior.aiGuideName !== undefined
              ? { aiGuideName: patch.aiBehavior.aiGuideName }
              : {}),
          },
        }
      : {}),
  }
}

export function canonicalVenuePackagePayload(
  venueId: string,
  payload: z.infer<typeof VenuePackagePayload>,
): string {
  if (payload.schemaVersion === VENUE_PACKAGE_SCHEMA_VERSION_V3) {
    return JSON.stringify([
      'pathfinder:venue-package:canonical-v3',
      payload.schemaVersion,
      venueId,
      canonicalVenuePatch(payload.venue),
      payload.places,
      payload.knowledgeEntries,
    ])
  }
  const canonicalContent = canonicalVenueContentImportPayload({
    venueId,
    places: payload.places,
    knowledgeEntries: payload.knowledgeEntries,
  })
  if (payload.schemaVersion === VENUE_PACKAGE_SCHEMA_VERSION_V1) {
    return JSON.stringify([
      'pathfinder:venue-package:canonical-v1',
      payload.schemaVersion,
      canonicalContent,
    ])
  }
  return JSON.stringify([
    'pathfinder:venue-package:canonical-v2',
    payload.schemaVersion,
    venueId,
    canonicalVenuePatch(payload.venue),
    canonicalContent,
  ])
}

export type VenuePackageVenuePatch = z.infer<typeof VenuePackageVenuePatch>
export type VenuePackageSourceProvenance = z.infer<typeof VenuePackageSourceProvenance>
export type VenuePackagePlaceDesiredState = z.infer<typeof VenuePackagePlaceDesiredState>
export type VenuePackageKnowledgeDesiredState = z.infer<typeof VenuePackageKnowledgeDesiredState>
export type VenuePackagePlaceSnapshot = z.infer<typeof VenuePackagePlaceSnapshot>
export type VenuePackageKnowledgeSnapshot = z.infer<typeof VenuePackageKnowledgeSnapshot>
export type VenuePackageVenueSnapshot = z.infer<typeof VenuePackageVenueSnapshot>
export type VenuePackageVenueChange = z.infer<typeof VenuePackageVenueChange>
export type VenuePackagePayloadV1 = z.infer<typeof VenuePackagePayloadV1>
export type VenuePackagePayloadV2 = z.infer<typeof VenuePackagePayloadV2>
export type VenuePackagePayloadV3 = z.infer<typeof VenuePackagePayloadV3>
export type VenuePackagePayload = z.infer<typeof VenuePackagePayload>
export type VenuePackageDraftInput = z.infer<typeof VenuePackageDraftInput>
export type VenuePackagePreviewInput = z.infer<typeof VenuePackagePreviewInput>
export type VenuePackageLifecycleInput = z.infer<typeof VenuePackageLifecycleInput>
export type VenuePackageAppliedEntitiesV1 = z.infer<typeof VenuePackageAppliedEntitiesV1>
export type VenuePackageAppliedEntitiesV2 = z.infer<typeof VenuePackageAppliedEntitiesV2>
export type VenuePackageAppliedEntitiesV3 = z.infer<typeof VenuePackageAppliedEntitiesV3>
export type VenuePackageAppliedEntities = z.infer<typeof VenuePackageAppliedEntities>
export type VenuePackageIssue = z.infer<typeof VenuePackageIssue>
export type VenuePackageSemanticDuplicateScan = z.infer<typeof VenuePackageSemanticDuplicateScan>
export type VenuePackageValidationReport = z.infer<typeof VenuePackageValidationReport>
export type VenuePackageStoredPreviewV1 = z.infer<typeof VenuePackageStoredPreviewV1>
export type VenuePackageStoredPreviewV2 = z.infer<typeof VenuePackageStoredPreviewV2>
export type VenuePackageStoredPreview = z.infer<typeof VenuePackageStoredPreview>
