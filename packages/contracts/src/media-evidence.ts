import { z } from 'zod'

// Retain the historical label for reading old receipts; it is not proof of
// exhaustive frame coverage and must never be emitted by new processing.
export const MediaVideoMethodSchema = z.enum([
  'GOOGLE_COMPLETE_VIDEO',
  'GOOGLE_STATIC_VIDEO_1FPS',
  'SAMPLED_VIDEO',
  'SAMPLED_VIDEO_FALLBACK',
])

export const MediaVideoCoverageSchema = z
  .object({
    inputScope: z.enum(['uploaded-video', 'sampled-frames']),
    visualCoverage: z.enum(['provider-static-1fps', 'bounded-interval-samples']),
    audioCoverage: z.enum(['provider-video-audio', 'optional-transcription']),
    exhaustiveFrames: z.literal(false),
  })
  .strict()

export const MediaObservationSchema = z
  .object({
    kind: z.enum(['entity_candidate', 'visible_text', 'narrated_fact', 'spatial_relation']),
    statement: z.string().min(1).max(10_000),
    evidenceChannel: z.enum(['visual', 'visible_text', 'speech', 'mixed']),
    directness: z.enum(['observed', 'inferred']),
    confidence: z.enum(['confirmed', 'probable', 'unverified']),
    startSeconds: z.number().finite().min(0),
    endSeconds: z.number().finite().min(0),
    region: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        width: z.number().finite().positive().max(1),
        height: z.number().finite().positive().max(1),
      })
      .strict()
      .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
        message: 'Observation region must fit within the image.',
      })
      .optional(),
  })
  .strict()
  .refine((value) => value.endSeconds >= value.startSeconds, {
    message: 'Observation end must not precede its start.',
  })

const normalizedRegionSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1, {
    message: 'Observation region must fit within the image.',
  })

export const MediaSourceObservationSchema = z
  .object({
    kind: z.enum(['entity_candidate', 'visible_text', 'narrated_fact', 'spatial_relation']),
    statement: z.string().min(1).max(10_000),
    evidenceChannel: z.enum(['visual', 'visible_text', 'speech', 'document_text', 'mixed']),
    directness: z.enum(['observed', 'inferred']),
    confidence: z.enum(['confirmed', 'probable', 'unverified']),
    processingMethod: z.enum([
      'provider_image_analysis',
      'provider_video_static_1fps',
      'sampled_video_analysis',
      'audio_transcription',
      'text_extraction',
    ]),
    locator: z.discriminatedUnion('type', [
      z.object({ type: z.literal('whole_source') }).strict(),
      z.object({ type: z.literal('image_region'), region: normalizedRegionSchema }).strict(),
      z
        .object({ type: z.literal('document_page'), page: z.number().int().min(1).max(100_000) })
        .strict(),
      z
        .object({
          type: z.literal('video_interval'),
          startSeconds: z.number().finite().min(0),
          endSeconds: z.number().finite().min(0),
          region: normalizedRegionSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.locator.type === 'video_interval' &&
      value.locator.endSeconds < value.locator.startSeconds
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locator', 'endSeconds'],
        message: 'Observation end must not precede its start.',
      })
    }
  })

export function mediaVideoMethodLabel(method: z.infer<typeof MediaVideoMethodSchema>): string {
  switch (method) {
    case 'GOOGLE_COMPLETE_VIDEO':
      return 'Google video analysis · legacy coverage unspecified'
    case 'GOOGLE_STATIC_VIDEO_1FPS':
      return 'Google video analysis · 1 frame per second'
    case 'SAMPLED_VIDEO_FALLBACK':
      return 'Sampled analysis after Google fallback'
    case 'SAMPLED_VIDEO':
      return 'Sampled video analysis'
  }
}
