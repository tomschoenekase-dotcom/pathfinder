import { z } from 'zod'

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
  },
  ctx: z.RefinementCtx,
): void {
  const hasLat = value.defaultCenterLat !== undefined
  const hasLng = value.defaultCenterLng !== undefined

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
}

export const CreateVenueInput = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    guideNotes: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
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
