import { z } from 'zod'

export const INTAKE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

/** Deliberately excludes SVG and animated formats. */
export const IntakeUploadMimeType = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/tiff',
])
export type IntakeUploadMimeType = z.infer<typeof IntakeUploadMimeType>

export const IntakeUploadStatus = z.enum(['RESERVED', 'VERIFYING', 'AWAITING_REVIEW', 'REJECTED'])
export type IntakeUploadStatus = z.infer<typeof IntakeUploadStatus>

export const IntakeUploadRejectionCode = z.enum([
  'OBJECT_MISSING',
  'GENERATION_MISMATCH',
  'MIME_MISMATCH',
  'SIZE_MISMATCH',
  'HASH_MISMATCH',
  'UNSAFE_FILE',
])
export type IntakeUploadRejectionCode = z.infer<typeof IntakeUploadRejectionCode>

export const IntakeUploadRetryReason = z.enum(['TRANSPORT_UNAVAILABLE', 'VERIFICATION_UNAVAILABLE'])
export type IntakeUploadRetryReason = z.infer<typeof IntakeUploadRetryReason>

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
