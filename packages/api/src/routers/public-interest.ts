import { createHash } from 'node:crypto'
import { z } from 'zod'

import { router, publicTRPCError } from '../core'
import { checkRateLimit } from '../lib/rate-limit'
import { publicProcedure } from '../trpc'

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined)

export const publicInterestInput = z
  .object({
    requestId: z.string().uuid(),
    organizationName: z.string().trim().min(2).max(160),
    contactName: z.string().trim().min(2).max(120),
    workEmail: z.string().trim().email().max(320),
    website: optionalText(1000).pipe(z.string().url().optional()),
    cityRegion: optionalText(200),
    venueType: optionalText(100),
    message: optionalText(2000),
    // Deliberately rendered off-screen. Bots receive the same accepted response,
    // but their payload is not retained as company state.
    companyFax: optionalText(200),
  })
  .strict()

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function normalizedSubmission(input: z.infer<typeof publicInterestInput>) {
  return {
    organizationName: input.organizationName,
    contactName: input.contactName,
    workEmail: input.workEmail,
    normalizedEmail: input.workEmail.toLowerCase(),
    website: input.website ?? null,
    cityRegion: input.cityRegion ?? null,
    venueType: input.venueType ?? null,
    message: input.message ?? null,
  }
}

function requestHash(input: ReturnType<typeof normalizedSubmission>): string {
  return sha256(JSON.stringify(input))
}

function requestSourceFingerprint(headers: Headers): string | null {
  const raw =
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')?.trim()
  return raw ? sha256(`public-interest-source-v1:${raw}`) : null
}

export const publicInterestRouter = router({
  submit: publicProcedure.input(publicInterestInput).mutation(async ({ ctx, input }) => {
    const normalized = normalizedSubmission(input)
    const emailFingerprint = sha256(`public-interest-email-v1:${normalized.normalizedEmail}`)
    const sourceFingerprint = requestSourceFingerprint(ctx.headers)
    const limits = [
      checkRateLimit(`ratelimit:public-interest:email:${emailFingerprint}`, 4, 24 * 60 * 60),
      ...(sourceFingerprint
        ? [checkRateLimit(`ratelimit:public-interest:source:${sourceFingerprint}`, 12, 60 * 60)]
        : []),
    ]

    if (!(await Promise.all(limits)).every(Boolean)) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again later.',
      })
    }

    if (input.companyFax) return { received: true as const }

    const hash = requestHash(normalized)
    const existing = await ctx.db.publicInterestSubmission.findUnique({
      where: { requestId: input.requestId },
      select: { requestHash: true },
    })
    if (existing) {
      if (existing.requestHash !== hash) {
        throw publicTRPCError({
          code: 'CONFLICT',
          message: 'This request could not be safely replayed. Please refresh and try again.',
        })
      }
      return { received: true as const }
    }

    try {
      await ctx.db.publicInterestSubmission.create({
        data: {
          requestId: input.requestId,
          requestHash: hash,
          ...normalized,
          sourcePath: '/request-demo',
        },
        select: { id: true },
      })
    } catch (error) {
      // Close the unique-request race without swallowing unrelated database
      // failures. An exact retry succeeds; a changed payload is rejected.
      const raced = await ctx.db.publicInterestSubmission.findUnique({
        where: { requestId: input.requestId },
        select: { requestHash: true },
      })
      if (!raced) throw error
      if (raced.requestHash !== hash) {
        throw publicTRPCError({
          code: 'CONFLICT',
          message: 'This request could not be safely replayed. Please refresh and try again.',
        })
      }
    }

    return { received: true as const }
  }),
})
