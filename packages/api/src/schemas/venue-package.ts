import { z } from 'zod'

import { KnowledgeEntryInput } from './knowledge'
import { PlaceInput } from './place'
import { VENUE_CONTENT_IMPORT_LIMIT, canonicalVenueContentImportPayload } from './venue-content'

export const VENUE_PACKAGE_SCHEMA_VERSION = 1 as const
export const VENUE_PACKAGE_ITEM_LIMIT = VENUE_CONTENT_IMPORT_LIMIT

export const VenuePackagePayload = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION),
    places: z.array(PlaceInput).max(VENUE_CONTENT_IMPORT_LIMIT),
    knowledgeEntries: z.array(KnowledgeEntryInput.strict()).max(VENUE_CONTENT_IMPORT_LIMIT),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.places.length + input.knowledgeEntries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Include at least one guide item or knowledge entry',
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

export const VenuePackageStoredPreview = z
  .object({
    schemaVersion: z.literal(VENUE_PACKAGE_SCHEMA_VERSION),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.literal('ADDITIVE_V1'),
    warningDigest: z.string().regex(/^[a-f0-9]{64}$/),
    report: VenuePackageValidationReport,
    changes: z
      .object({
        places: z
          .object({
            add: z.array(PlaceInput),
            change: EmptyChangeSet,
            remove: EmptyChangeSet,
            unchanged: z.number().int().nonnegative(),
          })
          .strict(),
        knowledgeEntries: z
          .object({
            add: z.array(KnowledgeEntryInput.strict()),
            change: EmptyChangeSet,
            remove: EmptyChangeSet,
            unchanged: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

export const VenuePackageAppliedEntities = z
  .object({
    postApplyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    places: z.array(
      z
        .object({
          id: z.string().cuid(),
          name: z.string().min(1).max(200),
          type: z.string().min(1),
          itemType: z.string().nullable(),
          shortDescription: z.string().nullable(),
          longDescription: z.string().nullable(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
          tags: z.array(z.string()),
          importanceScore: z.number().int().min(0).max(100),
          areaName: z.string().nullable(),
          hours: z.string().nullable(),
          photoUrl: z.string().nullable(),
        })
        .strict(),
    ),
    knowledgeEntries: z.array(KnowledgeEntryInput.extend({ id: z.string().cuid() }).strict()),
  })
  .strict()

export function canonicalVenuePackagePayload(
  venueId: string,
  payload: z.infer<typeof VenuePackagePayload>,
): string {
  return JSON.stringify([
    'pathfinder:venue-package:canonical-v1',
    payload.schemaVersion,
    canonicalVenueContentImportPayload({
      venueId,
      places: payload.places,
      knowledgeEntries: payload.knowledgeEntries,
    }),
  ])
}

export type VenuePackagePayload = z.infer<typeof VenuePackagePayload>
export type VenuePackageDraftInput = z.infer<typeof VenuePackageDraftInput>
export type VenuePackagePreviewInput = z.infer<typeof VenuePackagePreviewInput>
export type VenuePackageLifecycleInput = z.infer<typeof VenuePackageLifecycleInput>
export type VenuePackageAppliedEntities = z.infer<typeof VenuePackageAppliedEntities>
export type VenuePackageIssue = z.infer<typeof VenuePackageIssue>
export type VenuePackageSemanticDuplicateScan = z.infer<typeof VenuePackageSemanticDuplicateScan>
export type VenuePackageValidationReport = z.infer<typeof VenuePackageValidationReport>
export type VenuePackageStoredPreview = z.infer<typeof VenuePackageStoredPreview>
