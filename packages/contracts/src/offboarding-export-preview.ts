import { z } from 'zod'

const Id = z.string().min(1).max(500)
const DateTime = z.string().datetime({ offset: true })
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/i)

export const OffboardingExportPreviewInput = z
  .object({
    tenantId: Id,
    venueIds: z.array(Id).min(1).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.venueIds).size !== value.venueIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venueIds'],
        message: 'Venue IDs must be unique',
      })
    }
  })

const VenueIdentity = z
  .object({
    id: Id,
    name: z.string().min(1),
    slug: z.string().min(1),
    isActive: z.boolean(),
    tonePreset: z.string().nullable(),
    tonePresetVersion: z.number().int().nullable(),
    updatedAt: DateTime,
  })
  .strict()

const CurrentContentReference = z
  .object({
    id: Id,
    venueId: Id,
    kind: z.enum(['PLACE', 'KNOWLEDGE_ENTRY']),
    sourcePackageId: Id.nullable(),
    updatedAt: DateTime,
  })
  .strict()

const ContentHistoryReference = z
  .object({
    id: Id,
    venueId: Id,
    sequence: z.string().regex(/^\d+$/),
    entityType: z.string().min(1).max(100),
    entityId: Id,
    operation: z.string().min(1).max(100),
    venuePackageId: Id.nullable(),
    venuePackageAction: z.string().nullable(),
    snapshotSchemaVersion: z.number().int().positive(),
    createdAt: DateTime,
  })
  .strict()

const PackageReference = z
  .object({
    id: Id,
    venueId: Id,
    schemaVersion: z.number().int().positive(),
    payloadHash: Sha256,
    baseDigest: Sha256,
    status: z.enum(['DRAFT', 'APPROVED', 'APPLIED', 'REVERTED']),
    createdAt: DateTime,
    approvedAt: DateTime.nullable(),
    appliedAt: DateTime.nullable(),
    revertedAt: DateTime.nullable(),
  })
  .strict()

const ModuleReference = z
  .object({ id: Id, venueId: Id, kind: z.string().min(1), createdAt: DateTime })
  .strict()
const RevisionReference = z
  .object({
    id: Id,
    venueId: Id,
    moduleId: Id,
    kind: z.string().min(1),
    version: z.number().int().positive(),
    audience: z.string().min(1),
    effectiveFrom: DateTime.nullable(),
    effectiveUntil: DateTime.nullable(),
    createdAt: DateTime,
  })
  .strict()
const EvidenceReference = z
  .object({
    id: Id,
    venueId: Id,
    revisionId: Id,
    moduleKind: z.string().min(1),
    excerptHash: Sha256.nullable(),
    capturedAt: DateTime,
  })
  .strict()

export const OffboardingExportManifestPreview = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: DateTime,
    tenantId: Id,
    selectedVenueIds: z.array(Id).min(1).max(20),
    privacyBoundary: z.literal('METADATA_REFERENCES_ONLY'),
    venues: z.array(VenueIdentity).max(20),
    currentContent: z.array(CurrentContentReference),
    contentHistory: z.array(ContentHistoryReference),
    packages: z.array(PackageReference),
    modules: z.array(ModuleReference),
    revisions: z.array(RevisionReference),
    evidence: z.array(EvidenceReference),
    truncation: z.record(
      z
        .object({
          returned: z.number().int().nonnegative(),
          available: z.number().int().nonnegative(),
          cap: z.number().int().positive(),
          truncated: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()

export type OffboardingExportManifestPreview = z.infer<typeof OffboardingExportManifestPreview>
