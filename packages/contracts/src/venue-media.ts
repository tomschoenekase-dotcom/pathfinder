import { z } from 'zod'

const nonEmpty = z.string().trim().min(1)
const safeSourceUrl = z
  .string()
  .trim()
  .max(2_000)
  .url()
  .refine((value) => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(
      (key) =>
        /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu.test(
          key,
        ),
    )
  }, 'Media source URLs must use HTTPS and contain no credentials or secret-like parameters')

export const VenueMediaKind = z.enum(['IMAGE'])
export type VenueMediaKind = z.infer<typeof VenueMediaKind>

export const VenueMediaImportance = z.enum(['PRIMARY', 'SECONDARY'])
export type VenueMediaImportance = z.infer<typeof VenueMediaImportance>

export const VenueMediaRightsBasis = z.enum([
  'VENUE_OWNED',
  'LICENSED',
  'PERMISSION_GRANTED',
  'PUBLIC_DOMAIN',
])
export type VenueMediaRightsBasis = z.infer<typeof VenueMediaRightsBasis>

const uniqueIds = (maximum: number) =>
  z
    .array(nonEmpty.max(191))
    .max(maximum)
    .default([])
    .refine((values) => new Set(values).size === values.length, 'Linked IDs must be unique')

export const RegisterVenueMediaAssetInput = z
  .object({
    tenantId: nonEmpty.max(191),
    venueId: nonEmpty.max(191),
    assetId: z.string().uuid(),
    intakeUploadId: nonEmpty.max(191),
    kind: VenueMediaKind,
    semanticDescription: nonEmpty.max(2_000),
    depictedSubjects: z.array(nonEmpty.max(160)).max(50).default([]),
    altText: nonEmpty.max(240),
    caption: nonEmpty.max(300).nullable().optional(),
    usageGuidance: nonEmpty.max(2_000).nullable().optional(),
    importance: VenueMediaImportance.default('SECONDARY'),
    sourceName: nonEmpty.max(500),
    sourceUrl: safeSourceUrl.nullable().optional(),
    sourceCapturedAt: z.string().datetime({ offset: true }).nullable().optional(),
    linkedPlaceIds: uniqueIds(50),
    linkedKnowledgeEntryIds: uniqueIds(50),
  })
  .strict()

export type RegisterVenueMediaAssetInput = z.infer<typeof RegisterVenueMediaAssetInput>

const venueMediaReviewEnvelope = z.object({
  tenantId: nonEmpty.max(191),
  venueId: nonEmpty.max(191),
  assetId: z.string().uuid(),
  requestId: z.string().uuid(),
  expectedLatestSequence: z.number().int().min(0),
})

export const ApproveVenueMediaAssetInput = venueMediaReviewEnvelope
  .extend({
    action: z.literal('APPROVE_CONTENT_USE'),
    rightsBasis: VenueMediaRightsBasis,
    rightsStatement: nonEmpty.max(2_000),
    rightsEvidenceSourceId: nonEmpty.max(500),
  })
  .strict()

export const WithdrawVenueMediaAssetInput = venueMediaReviewEnvelope
  .extend({
    action: z.literal('WITHDRAW_CONTENT_USE'),
    reason: nonEmpty.max(2_000),
  })
  .strict()

export const ReviewVenueMediaAssetInput = z.discriminatedUnion('action', [
  ApproveVenueMediaAssetInput,
  WithdrawVenueMediaAssetInput,
])

export type ReviewVenueMediaAssetInput = z.infer<typeof ReviewVenueMediaAssetInput>

/**
 * This deliberately contains no URL. Review approval makes an asset eligible for a future
 * controlled-delivery layer; it does not publish bytes, expose object keys, or authorize hotlinks.
 */
export const ApprovedVenueMediaCandidate = z
  .object({
    assetId: z.string().uuid(),
    kind: VenueMediaKind,
    semanticDescription: nonEmpty.max(2_000),
    depictedSubjects: z.array(nonEmpty.max(160)).max(50),
    altText: nonEmpty.max(240),
    caption: nonEmpty.max(300).nullable(),
    usageGuidance: nonEmpty.max(2_000).nullable(),
    importance: VenueMediaImportance,
    linkedPlaceIds: z.array(nonEmpty.max(191)).max(50),
    linkedKnowledgeEntryIds: z.array(nonEmpty.max(191)).max(50),
    delivery: z.literal('CONTROLLED_DERIVATIVE_REQUIRED'),
  })
  .strict()

export type ApprovedVenueMediaCandidate = z.infer<typeof ApprovedVenueMediaCandidate>
