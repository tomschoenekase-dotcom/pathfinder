import { z } from 'zod'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const dateTime = z.string().datetime({ offset: true })

export const MediaTemporalClaimAuthoritySchema = z.enum([
  'AUTHORIZED_STAFF',
  'PUBLIC_SOURCE',
  'HISTORICAL_SOURCE',
  'UNKNOWN',
])

export const MediaTemporalClaimSchema = z
  .object({
    claimId: z.string().min(1).max(191),
    targetKey: z.string().min(1).max(500),
    targetItemHash: sha256,
    claimType: z.enum(['STABLE_FACT', 'TEMPORARY_SCHEDULE']),
    value: z.string().trim().min(1).max(5_000),
    valueHash: sha256,
    authority: MediaTemporalClaimAuthoritySchema,
    consequential: z.boolean(),
    effectiveFrom: dateTime.optional(),
    effectiveUntil: dateTime.optional(),
    source: z
      .object({
        sourceId: z.string().min(1).max(500),
        sourceSha256: sha256,
        sourceVersion: z.string().trim().min(1).max(191),
        capturedAt: dateTime.nullable(),
        observationIndex: z.number().int().min(0).max(49_999),
        observationSha256: sha256,
      })
      .strict(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (
      claim.claimType === 'TEMPORARY_SCHEDULE' &&
      (!claim.effectiveFrom || !claim.effectiveUntil)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'Temporary schedules require a finite effective interval.',
      })
    }
    if (
      claim.effectiveFrom &&
      claim.effectiveUntil &&
      Date.parse(claim.effectiveUntil) <= Date.parse(claim.effectiveFrom)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveUntil'],
        message: 'Claim effective end must follow its start.',
      })
    }
  })

export type MediaTemporalClaim = z.infer<typeof MediaTemporalClaimSchema>
