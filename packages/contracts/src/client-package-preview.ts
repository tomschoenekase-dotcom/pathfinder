import { z } from 'zod'
import { SupportAttachmentReferences } from './support-workflow'
import { TONE_PRESET_BEHAVIOR_VERSION, TonePresetId } from './tone-presets'

export const CreateClientPreviewFeedbackInput = z
  .object({
    operationId: z.string().uuid(),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    body: z.string().trim().min(1).max(20_000),
    attachments: SupportAttachmentReferences.default([]),
  })
  .strict()
export type CreateClientPreviewFeedbackInput = z.infer<typeof CreateClientPreviewFeedbackInput>

const nullableText = z.string().nullable()
const EffectivePlace = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(100),
    shortDescription: z.string().max(500).nullable(),
    longDescription: z.string().max(2_000).nullable(),
    areaName: z.string().max(200).nullable(),
    hours: z.string().max(200).nullable(),
    photoUrl: z.string().max(2_000).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    tags: z.array(z.string().max(100)).max(50),
  })
  .strict()
const EffectiveKnowledge = z
  .object({
    title: z.string().min(1).max(200),
    category: z.string().min(1).max(100),
    content: z.string().min(1).max(5_000),
  })
  .strict()

export const ClientVenuePackagePreview = z
  .object({
    venue: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1).max(200),
        description: z.string().max(1_000).nullable(),
        category: z.string().max(100).nullable(),
        branding: z
          .object({
            theme: nullableText,
            accentColor: nullableText,
            font: nullableText,
            logoUrl: nullableText,
            bannerUrl: nullableText,
          })
          .strict(),
        guide: z
          .object({
            name: z.string().max(80).nullable(),
            tone: z
              .object({
                preset: TonePresetId,
                behaviorVersion: z.literal(TONE_PRESET_BEHAVIOR_VERSION),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    package: z
      .object({
        id: z.string().min(1),
        status: z.literal('APPROVED'),
        approvedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    experience: z
      .object({
        places: z.array(EffectivePlace).max(500),
        knowledgeEntries: z.array(EffectiveKnowledge).max(500),
        summary: z
          .object({
            placeCount: z.number().int().nonnegative(),
            knowledgeEntryCount: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    staleness: z.literal('CURRENT'),
    autoApply: z.literal(false),
    published: z.literal(false),
    guestAccessible: z.literal(false),
  })
  .strict()
export type ClientVenuePackagePreview = z.infer<typeof ClientVenuePackagePreview>
