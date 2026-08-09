import { z } from 'zod'

import { KnowledgeEntryInput, PlaceInput } from '@pathfinder/contracts'

const InitialGuideItemInput = PlaceInput.omit({ itemType: true, lat: true, lng: true }).extend({
  shortDescription: z.string().min(1).max(500),
})

const InitialKnowledgeEntryInput = KnowledgeEntryInput.omit({ isEnabled: true })

export const InitialVenueContentInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place'), value: InitialGuideItemInput }).strict(),
  z.object({ kind: z.literal('knowledge'), value: InitialKnowledgeEntryInput }).strict(),
])

export type InitialVenueContent = z.infer<typeof InitialVenueContentInput>

export function normalizeInitialVenueContent(value: {
  initialContent?: InitialVenueContent | undefined
  initialGuideItem?: z.infer<typeof InitialGuideItemInput> | undefined
}): InitialVenueContent | undefined {
  return (
    value.initialContent ??
    (value.initialGuideItem ? { kind: 'place', value: value.initialGuideItem } : undefined)
  )
}

const venueLocationShape = {
  guideMode: z.enum(['location_aware', 'non_location']).optional(),
  defaultCenterLat: z.number().min(-90).max(90).optional(),
  defaultCenterLng: z.number().min(-180).max(180).optional(),
} as const

function validateVenueLocation(
  value: {
    guideMode?: 'location_aware' | 'non_location' | undefined
    defaultCenterLat?: number | undefined
    defaultCenterLng?: number | undefined
    initialGuideItem?: unknown
    initialContent?: InitialVenueContent | undefined
  },
  ctx: z.RefinementCtx,
): void {
  const hasLat = value.defaultCenterLat !== undefined
  const hasLng = value.defaultCenterLng !== undefined

  if (value.initialContent !== undefined && value.initialGuideItem !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide only one initial content representation.',
      path: ['initialContent'],
    })
  }

  const initialContent = normalizeInitialVenueContent(
    value as Parameters<typeof normalizeInitialVenueContent>[0],
  )

  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Venue center latitude and longitude must be provided together.',
      path: hasLat ? ['defaultCenterLng'] : ['defaultCenterLat'],
    })
  }

  if (value.guideMode === 'non_location' && (hasLat || hasLng)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Non-location venues cannot define a default center.',
      path: ['guideMode'],
    })
  }

  if (initialContent?.kind === 'place' && value.guideMode !== 'non_location' && !hasLat) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A location-aware initial guide item requires a venue center.',
      path: ['defaultCenterLat'],
    })
  }
}

export const CreateVenueInput = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    guideNotes: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    initialGuideItem: InitialGuideItemInput.optional(),
    initialContent: InitialVenueContentInput.optional(),
    ...venueLocationShape,
  })
  .strict()

export const CreateVenueRequestInput = CreateVenueInput.superRefine(validateVenueLocation)

export const UpdateVenueInput = z
  .object({
    id: z.string().cuid(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    guideNotes: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    ...venueLocationShape,
  })
  .strict()

export const UpdateVenueRequestInput = UpdateVenueInput.superRefine(validateVenueLocation)
