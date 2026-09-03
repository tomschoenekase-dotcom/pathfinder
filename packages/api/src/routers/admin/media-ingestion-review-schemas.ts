import { z } from 'zod'

import { MEDIA_SOURCE_FILENAME_LIMIT } from '@pathfinder/contracts'

export const MEDIA_FINDING_PAGE_LIMIT = 50
export const MEDIA_FINDING_LIMIT = 10_000

export const mediaFindingSchema = z
  .object({
    sourceId: z.string().min(1).max(500),
    filename: z.string().min(1).max(MEDIA_SOURCE_FILENAME_LIMIT),
    mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']),
    videoAnalysisMethod: z
      .enum(['GOOGLE_COMPLETE_VIDEO', 'SAMPLED_VIDEO', 'SAMPLED_VIDEO_FALLBACK'])
      .optional(),
    summary: z.string().max(50_000),
    uncertainties: z.array(z.string().max(10_000)).max(1_000),
    review: z
      .object({
        summary: z.string().max(50_000),
        uncertainties: z.array(z.string().max(10_000)).max(1_000),
        note: z.string().max(10_000),
        reviewedBy: z.string().min(1),
        reviewedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .passthrough()
  .superRefine((finding, context) => {
    if (finding.videoAnalysisMethod && finding.mediaType !== 'VIDEO') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['videoAnalysisMethod'],
        message: 'Video analysis provenance is only valid for video findings.',
      })
    }
  })

export const mediaFindingsSchema = z.array(mediaFindingSchema).max(MEDIA_FINDING_LIMIT)

export const mediaFindingCorrectionSchema = z
  .object({
    sourceId: z.string().min(1).max(500),
    summary: z.string().max(50_000),
    uncertainties: z.array(z.string().max(10_000)).max(1_000),
    note: z.string().max(10_000).default(''),
  })
  .strict()

export const mediaQuestionSchema = z
  .object({
    id: z.string().min(1).max(200),
    question: z.string().min(1).max(10_000),
    answer: z.string().max(30_000).optional(),
  })
  .strict()

export const mediaQuestionAnswerSchema = z
  .object({ id: z.string().min(1).max(200), answer: z.string().max(30_000) })
  .strict()

export function paginateMediaFindings(
  findings: z.infer<typeof mediaFindingsSchema>,
  cursor?: string,
) {
  let start = 0
  if (cursor) {
    const cursorIndex = findings.findIndex((finding) => finding.sourceId === cursor)
    if (cursorIndex < 0) return null
    start = cursorIndex + 1
  }
  const page = findings.slice(start, start + MEDIA_FINDING_PAGE_LIMIT)
  const hasMore = start + page.length < findings.length
  return {
    items: page,
    nextCursor: hasMore ? (page.at(-1)?.sourceId ?? null) : null,
  }
}
