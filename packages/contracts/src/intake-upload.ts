import { z } from 'zod'

/** Single-file ceiling; larger files use resumable multipart transport. */
export const INTAKE_UPLOAD_MAX_BYTES = 2_000_000_000
export const INTAKE_UPLOAD_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024
export const INTAKE_UPLOAD_MULTIPART_PART_BYTES = 16 * 1024 * 1024
/** Non-media files are fully parsed during precheck; keep their in-memory boundary explicit. */
export const INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES = 100 * 1024 * 1024
/** Combined active material allowance for one venue. */
export const INTAKE_UPLOAD_VENUE_MAX_BYTES = 50 * 1024 * 1024 * 1024

export const IntakeUploadCategory = z.enum([
  'WEBSITE',
  'DOCUMENT',
  'PHOTO',
  'VIDEO_AUDIO',
  'FLOOR_PLAN',
  'FAQ',
  'STAFF_INTERVIEW',
  'OTHER',
])
export type IntakeUploadCategory = z.infer<typeof IntakeUploadCategory>

/** Deliberately excludes SVG and animated formats. */
export const IntakeUploadMimeType = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
])
export type IntakeUploadMimeType = z.infer<typeof IntakeUploadMimeType>

export const IntakeUploadStatus = z.enum([
  'RESERVED',
  'VERIFYING',
  'PRECHECK_PASSED',
  'AWAITING_REVIEW',
  'REJECTED',
])
export type IntakeUploadStatus = z.infer<typeof IntakeUploadStatus>

export const IntakeUploadRejectionCode = z.enum([
  'OBJECT_MISSING',
  'GENERATION_MISMATCH',
  'MIME_MISMATCH',
  'SIZE_MISMATCH',
  'HASH_MISMATCH',
  'UNSAFE_FILE',
  'CLIENT_CANCELLED',
])
export type IntakeUploadRejectionCode = z.infer<typeof IntakeUploadRejectionCode>

export const IntakeUploadRetryReason = z.enum(['TRANSPORT_UNAVAILABLE', 'VERIFICATION_UNAVAILABLE'])
export type IntakeUploadRetryReason = z.infer<typeof IntakeUploadRetryReason>

export const IntakeUploadVerificationStatus = z.enum(['PENDING', 'CLEAN', 'REJECTED'])
export type IntakeUploadVerificationStatus = z.infer<typeof IntakeUploadVerificationStatus>

export const IntakeUploadVerificationEvidence = z
  .object({
    engine: z.string().trim().min(1).max(64),
    engineVersion: z.string().trim().min(1).max(64),
    verdictHash: z.string().regex(/^[a-f0-9]{64}$/u),
    computedByteSize: z.number().int().min(1).max(2_147_483_647),
    computedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
export type IntakeUploadVerificationEvidence = z.infer<typeof IntakeUploadVerificationEvidence>

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !containsControlCharacter(value), 'Control characters are not allowed')
const baseFileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !containsControlCharacter(value) && !value.includes('/') && !value.includes('\\'),
    'A base filename without paths or control characters is required',
  )

export const IntakeUploadReserveRequest = z
  .object({
    requestId: z.string().uuid(),
    displayName,
    fileName: baseFileName,
    mimeType: IntakeUploadMimeType,
    category: IntakeUploadCategory,
    byteSize: z.number().int().min(1).max(INTAKE_UPLOAD_MAX_BYTES),
    sha256,
  })
  .strict()
export type IntakeUploadReserveRequest = z.infer<typeof IntakeUploadReserveRequest>

export const IntakeUploadVerifiedTransport = z
  .object({
    objectGeneration: z.string().uuid(),
    storageVersionId: z.string().trim().min(1).max(1024),
    mimeType: IntakeUploadMimeType,
    byteSize: z.number().int().min(1).max(INTAKE_UPLOAD_MAX_BYTES),
    sha256,
  })
  .strict()
export type IntakeUploadVerifiedTransport = z.infer<typeof IntakeUploadVerifiedTransport>

export const IntakeUploadCursor = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().trim().min(1).max(191),
  })
  .strict()
export type IntakeUploadCursor = z.infer<typeof IntakeUploadCursor>
