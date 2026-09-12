import { z } from 'zod'

import { KnowledgeEntryInput, PlaceInput, VenuePackagePayloadV1Object } from './venue-package'

export const SUPPORT_PORTABLE_EXPORT_SCHEMA_VERSION = 'support-portable-export-v1' as const
export const SUPPORT_PORTABLE_EXPORT_MAX_BYTES = 10 * 1024 * 1024

export const SupportPortableExportSection = z.enum([
  'current-venue',
  'content-history',
  'venue-packages',
  'published-reports',
  'recipient-support',
])
export type SupportPortableExportSection = z.infer<typeof SupportPortableExportSection>
export const SUPPORT_PORTABLE_EXPORT_SECTIONS = SupportPortableExportSection.options

export const SupportPortableExportInput = z
  .object({
    tenantId: z.string().min(1).max(191),
    venueId: z.string().min(1).max(191),
    recipientUserId: z.string().min(1).max(191),
    sections: z
      .array(SupportPortableExportSection)
      .min(1)
      .max(SUPPORT_PORTABLE_EXPORT_SECTIONS.length),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.sections).size !== input.sections.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sections'],
        message: 'Export sections must be unique',
      })
    }
  })
export type SupportPortableExportInput = z.infer<typeof SupportPortableExportInput>

const NullableString = z.string().nullable()
const DateTimeString = z.string().datetime()
const TenantRole = z.enum(['STAFF', 'MANAGER', 'OWNER'])

const VenueContent = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: NullableString,
    guideNotes: NullableString,
    aiGuideNotes: NullableString,
    aiFeaturedPlaceId: NullableString,
    aiTone: NullableString,
    tonePreset: NullableString,
    tonePresetVersion: z.number().int().positive().nullable(),
    aiGuideName: NullableString,
    chatTheme: NullableString,
    chatAccentColor: NullableString,
    chatFont: NullableString,
    chatShowPhotos: z.boolean(),
    chatShowLinks: z.boolean(),
    category: NullableString,
    guideMode: z.string(),
    defaultCenterLat: z.number().nullable(),
    defaultCenterLng: z.number().nullable(),
    isActive: z.boolean(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  })
  .strict()

const VenueBotConfiguration = z
  .object({
    presentationMode: z.enum(['CLASSIC', 'CHARACTER']),
    personalityMode: z.enum(['PRESET', 'CUSTOM']),
    tonePreset: z.string(),
    tonePresetVersion: z.number().int().positive(),
    responseDepth: z.enum(['BRIEF', 'BALANCED', 'DETAILED']),
    characterKey: NullableString,
    customCharacterId: NullableString,
    publicDisplayName: NullableString,
    greeting: NullableString,
    revision: z.number().int().positive(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  })
  .strict()
  .nullable()

const PlaceContent = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    itemType: NullableString,
    shortDescription: NullableString,
    longDescription: NullableString,
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int(),
    areaName: NullableString,
    hours: NullableString,
    isActive: z.boolean(),
    visibility: z.string(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  })
  .strict()

const KnowledgeContent = z
  .object({
    id: z.string(),
    title: z.string(),
    category: z.string(),
    content: z.string(),
    isEnabled: z.boolean(),
    visibility: z.string(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  })
  .strict()

export const SupportPortableCurrentVenueSection = z
  .object({
    venue: VenueContent,
    botConfiguration: VenueBotConfiguration,
    places: z.array(PlaceContent).max(500),
    knowledgeEntries: z.array(KnowledgeContent).max(500),
  })
  .strict()

const Provenance = z
  .object({
    sourceType: z.string(),
    authorship: z.string(),
    sourceName: NullableString,
    importedAt: DateTimeString.nullable(),
    humanConfirmedAt: DateTimeString.nullable(),
    lastReviewedAt: DateTimeString.nullable(),
    sourcePackageId: NullableString,
  })
  .strict()

const VenueHistoryState = VenueContent.omit({ createdAt: true, updatedAt: true })
  .omit({ chatShowPhotos: true, chatShowLinks: true })
  .extend({ tenantId: z.string(), venueId: z.string() })
  .strict()
const PlaceHistoryState = PlaceContent.omit({ visibility: true, createdAt: true, updatedAt: true })
  .extend({ tenantId: z.string(), venueId: z.string(), provenance: Provenance.nullable() })
  .strict()
const KnowledgeHistoryState = KnowledgeContent.omit({
  visibility: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({ tenantId: z.string(), venueId: z.string(), provenance: Provenance.nullable() })
  .strict()
const OperationalUpdateHistoryState = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    venueId: z.string(),
    placeId: NullableString,
    updateType: z.string(),
    severity: z.string(),
    priority: z.string(),
    title: z.string(),
    body: NullableString,
    redirectTo: NullableString,
    startsAt: DateTimeString,
    expiresAt: DateTimeString,
    status: z.string(),
    isActive: z.boolean(),
    publishedAt: DateTimeString.nullable(),
    createdAt: DateTimeString,
  })
  .strict()
const ContentHistoryState = z.union([
  VenueHistoryState,
  PlaceHistoryState,
  KnowledgeHistoryState,
  OperationalUpdateHistoryState,
])

export const SupportPortableContentHistorySection = z
  .array(
    z
      .object({
        id: z.string(),
        sequence: z.string().regex(/^\d+$/),
        entityType: z.enum(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY', 'OPERATIONAL_UPDATE']),
        entityId: z.string(),
        operation: z.string(),
        snapshotSchemaVersion: z.number().int().positive(),
        beforeState: ContentHistoryState.nullable(),
        afterState: ContentHistoryState.nullable(),
        createdAt: DateTimeString,
      })
      .strict(),
  )
  .max(2_000)

const SourcePackageVenuePatch = z
  .object({
    identity: z
      .object({
        name: z.string().optional(),
        description: NullableString.optional(),
        category: NullableString.optional(),
      })
      .strict()
      .optional(),
    guideNotes: NullableString.optional(),
    branding: z
      .object({
        chatTheme: NullableString.optional(),
        chatAccentColor: NullableString.optional(),
        chatFont: NullableString.optional(),
        chatLogoUrl: NullableString.optional(),
        chatBannerUrl: NullableString.optional(),
      })
      .strict()
      .optional(),
    aiBehavior: z
      .object({
        aiGuideNotes: NullableString.optional(),
        aiTone: NullableString.optional(),
        tonePreset: z.string().optional(),
        aiGuideName: NullableString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const SourcePackageProvenance = z
  .object({
    sourceType: z.string(),
    sourceName: z.string().optional(),
    sourceUrl: z.string().optional(),
    contentOrigin: z.enum(['HUMAN_AUTHORED', 'AI_GENERATED']),
  })
  .strict()
const SourcePackageItemIdentity = {
  itemKey: z.string().uuid(),
  provenance: SourcePackageProvenance,
}
const SourcePackagePlaceDesiredState = z
  .object({
    name: z.string(),
    type: z.string(),
    itemType: NullableString,
    shortDescription: NullableString,
    longDescription: NullableString,
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    tags: z.array(z.string()),
    importanceScore: z.number().int(),
    areaName: NullableString,
    hours: NullableString,
    photoUrl: NullableString,
    isActive: z.boolean(),
  })
  .strict()
const PackageKnowledgeDesiredState = z
  .object({
    title: z.string(),
    category: z.string(),
    content: z.string(),
    isEnabled: z.boolean(),
  })
  .strict()
const SourcePackagePayloadV2 = z
  .object({
    schemaVersion: z.literal(2),
    venue: SourcePackageVenuePatch.optional(),
    places: z.array(PlaceInput),
    knowledgeEntries: z.array(KnowledgeEntryInput),
  })
  .strict()
const SourcePackagePayloadV3 = z
  .object({
    schemaVersion: z.literal(3),
    venue: SourcePackageVenuePatch.optional(),
    places: z
      .object({
        create: z.array(z.object({ ...SourcePackageItemIdentity, value: PlaceInput }).strict()),
        update: z.array(
          z
            .object({
              ...SourcePackageItemIdentity,
              id: z.string(),
              value: SourcePackagePlaceDesiredState,
            })
            .strict(),
        ),
        delete: z.array(z.object({ ...SourcePackageItemIdentity, id: z.string() }).strict()),
      })
      .strict(),
    knowledgeEntries: z
      .object({
        create: z.array(
          z.object({ ...SourcePackageItemIdentity, value: KnowledgeEntryInput }).strict(),
        ),
        update: z.array(
          z
            .object({
              ...SourcePackageItemIdentity,
              id: z.string(),
              value: PackageKnowledgeDesiredState,
            })
            .strict(),
        ),
        delete: z.array(z.object({ ...SourcePackageItemIdentity, id: z.string() }).strict()),
      })
      .strict(),
  })
  .strict()
export const SupportedVenuePackageSourcePayload = z.discriminatedUnion('schemaVersion', [
  VenuePackagePayloadV1Object,
  SourcePackagePayloadV2,
  SourcePackagePayloadV3,
])
export type SupportedVenuePackageSourcePayload = z.infer<typeof SupportedVenuePackageSourcePayload>

const PackageVenuePatch = SourcePackageVenuePatch.extend({
  branding: SourcePackageVenuePatch.shape.branding
    .unwrap()
    .omit({ chatLogoUrl: true, chatBannerUrl: true })
    .optional(),
}).strict()
const PackageProvenance = SourcePackageProvenance.omit({ sourceUrl: true }).strict()
const PackageItemIdentity = { itemKey: z.string().uuid(), provenance: PackageProvenance }
const PackagePlaceInput = PlaceInput.omit({ photoUrl: true }).strict()
const PackagePlaceDesiredState = SourcePackagePlaceDesiredState.omit({ photoUrl: true }).strict()
const PackagePayloadV1 = VenuePackagePayloadV1Object.extend({
  places: z.array(PackagePlaceInput),
}).strict()
const PackagePayloadV2 = SourcePackagePayloadV2.extend({
  venue: PackageVenuePatch.optional(),
  places: z.array(PackagePlaceInput),
}).strict()
const PackagePayloadV3 = z
  .object({
    schemaVersion: z.literal(3),
    venue: PackageVenuePatch.optional(),
    places: z
      .object({
        create: z.array(z.object({ ...PackageItemIdentity, value: PackagePlaceInput }).strict()),
        update: z.array(
          z
            .object({ ...PackageItemIdentity, id: z.string(), value: PackagePlaceDesiredState })
            .strict(),
        ),
        delete: z.array(z.object({ ...PackageItemIdentity, id: z.string() }).strict()),
      })
      .strict(),
    knowledgeEntries: z
      .object({
        create: z.array(z.object({ ...PackageItemIdentity, value: KnowledgeEntryInput }).strict()),
        update: z.array(
          z
            .object({ ...PackageItemIdentity, id: z.string(), value: PackageKnowledgeDesiredState })
            .strict(),
        ),
        delete: z.array(z.object({ ...PackageItemIdentity, id: z.string() }).strict()),
      })
      .strict(),
  })
  .strict()
export const SupportPortableVenuePackagePayload = z.discriminatedUnion('schemaVersion', [
  PackagePayloadV1,
  PackagePayloadV2,
  PackagePayloadV3,
])
export type SupportPortableVenuePackagePayload = z.infer<typeof SupportPortableVenuePackagePayload>

export const SupportPortableVenuePackagesSection = z
  .array(
    z
      .object({
        id: z.string(),
        schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        status: z.enum(['DRAFT', 'APPROVED', 'APPLIED', 'REVERTED']),
        payload: SupportPortableVenuePackagePayload,
        sourcePayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
        exportedProjectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
        createdAt: DateTimeString,
        updatedAt: DateTimeString,
        approvedAt: DateTimeString.nullable(),
        appliedAt: DateTimeString.nullable(),
        revertedAt: DateTimeString.nullable(),
      })
      .strict(),
  )
  .max(500)

export const SupportPortablePublishedReportsSection = z
  .array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        weekStart: DateTimeString,
        weekEnd: DateTimeString,
        content: z.string(),
        publishedAt: DateTimeString,
      })
      .strict(),
  )
  .max(250)

const SupportAttachment = z
  .object({
    id: z.string(),
    filename: z.string(),
    mediaType: z.string(),
    byteSize: z.string().regex(/^\d+$/),
  })
  .strict()
const SupportMessage = z
  .object({
    id: z.string(),
    authorKind: z.enum(['CLIENT', 'OPERATOR', 'AGENT', 'SYSTEM']),
    authorIsRecipient: z.boolean(),
    body: z.string(),
    completionOutcome: NullableString,
    createdAt: DateTimeString,
    attachments: z.array(SupportAttachment),
  })
  .strict()
export const SupportPortableRecipientSupportSection = z
  .array(
    z
      .object({
        id: z.string(),
        category: z.string(),
        status: z.string(),
        subject: z.string(),
        missingInformation: z.array(z.string()),
        requesterIsRecipient: z.boolean(),
        participantIsRecipient: z.boolean(),
        clientActivityAt: DateTimeString,
        statusChangedAt: DateTimeString,
        createdAt: DateTimeString,
        messages: z.array(SupportMessage),
      })
      .strict(),
  )
  .max(100)

export const SUPPORT_PORTABLE_EXPORT_OMISSIONS = [
  'guest-conversations-and-location',
  'voice-and-provider-sessions',
  'internal-support-and-audit-evidence',
  'credentials-asset-urls-and-private-storage-locators',
  'intake-originals-quarantine-and-media-bytes',
  'billing-provider-and-raw-analytics-records',
  'native-release-artifacts-and-asset-downloads',
  'account-wide-and-offboarding-material',
] as const

const OmissionTuple = z.tuple([
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[0]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[1]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[2]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[3]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[4]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[5]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[6]),
  z.literal(SUPPORT_PORTABLE_EXPORT_OMISSIONS[7]),
])

const SupportPortableExportPayloadObject = z
  .object({
    schemaVersion: z.literal(SUPPORT_PORTABLE_EXPORT_SCHEMA_VERSION),
    capturedAt: DateTimeString,
    scope: z
      .object({ tenantId: z.string(), venueId: z.string(), recipientUserId: z.string() })
      .strict(),
    recipient: z.object({ role: TenantRole }).strict(),
    sections: z.array(SupportPortableExportSection),
    counts: z
      .object({
        places: z.number().int().nonnegative(),
        knowledgeEntries: z.number().int().nonnegative(),
        contentHistoryVersions: z.number().int().nonnegative(),
        venuePackages: z.number().int().nonnegative(),
        publishedReports: z.number().int().nonnegative(),
        supportRequests: z.number().int().nonnegative(),
        supportMessages: z.number().int().nonnegative(),
        supportAttachments: z.number().int().nonnegative(),
      })
      .strict(),
    omissions: OmissionTuple,
    currentVenue: SupportPortableCurrentVenueSection.optional(),
    contentHistory: SupportPortableContentHistorySection.optional(),
    venuePackages: SupportPortableVenuePackagesSection.optional(),
    publishedReports: SupportPortablePublishedReportsSection.optional(),
    recipientSupport: SupportPortableRecipientSupportSection.optional(),
  })
  .strict()

function validateSectionFields(
  payload: z.infer<typeof SupportPortableExportPayloadObject>,
  context: z.RefinementCtx,
) {
  if (new Set(payload.sections).size !== payload.sections.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sections'],
      message: 'Export sections must be unique',
    })
  }
  const sectionFields = {
    'current-venue': 'currentVenue',
    'content-history': 'contentHistory',
    'venue-packages': 'venuePackages',
    'published-reports': 'publishedReports',
    'recipient-support': 'recipientSupport',
  } as const
  for (const section of SUPPORT_PORTABLE_EXPORT_SECTIONS) {
    const field = sectionFields[section]
    if (payload.sections.includes(section) !== (payload[field] !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: 'Section mismatch',
      })
    }
  }
}

export const SupportPortableExportPayload =
  SupportPortableExportPayloadObject.superRefine(validateSectionFields)
export type SupportPortableExportPayload = z.infer<typeof SupportPortableExportPayload>

export const SupportPortableExportEnvelope = SupportPortableExportPayloadObject.extend({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
})
  .strict()
  .superRefine(validateSectionFields)
export type SupportPortableExportEnvelope = z.infer<typeof SupportPortableExportEnvelope>

export function canonicalSupportPortableExportJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Portable export contains a non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object' || value instanceof Date) {
    throw new TypeError('Portable export contains a non-JSON value')
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSupportPortableExportJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSupportPortableExportJson(record[key])}`)
    .join(',')}}`
}
