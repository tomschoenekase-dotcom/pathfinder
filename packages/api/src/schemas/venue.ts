import { z } from 'zod'

export const CreateVenueInput = z
  .object({
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    guideNotes: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    defaultCenterLat: z.number().optional(),
    defaultCenterLng: z.number().optional(),
  })
  .strict()

export const UpdateVenueInput = z
  .object({
    id: z.string().cuid(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    guideNotes: z.string().max(2000).optional(),
    category: z.string().max(100).optional(),
    defaultCenterLat: z.number().optional(),
    defaultCenterLng: z.number().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
