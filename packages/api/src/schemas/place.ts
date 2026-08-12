import { z } from 'zod'
import { PlaceInput } from '@pathfinder/contracts'

export { PlaceInput }

const ItemTypeInput = PlaceInput.shape.itemType

export const CreatePlaceInput = PlaceInput.extend({
  venueId: z.string().cuid(),
}).strict()

export const UpdatePlaceInput = z
  .object({
    id: z.string().cuid(),
    venueId: z.string().cuid().optional(),
    expectedUpdatedAt: z.coerce.date().optional(),
    name: z.string().min(1).max(200).optional(),
    type: z.string().min(1).optional(),
    itemType: ItemTypeInput,
    shortDescription: z.string().max(500).optional(),
    longDescription: z.string().max(2000).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    tags: z.array(z.string()).optional(),
    importanceScore: z.number().int().min(0).max(100).optional(),
    areaName: z.string().max(200).optional(),
    hours: z.string().max(200).optional(),
    photoUrl: z
      .union([z.string().url().max(2000), z.literal(''), z.null()])
      .optional()
      .transform((v) => (!v || v === '' ? null : v)),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.venueId)
      ctx.addIssue({ code: 'custom', path: ['venueId'], message: 'Venue is required' })
    if (!value.expectedUpdatedAt)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedUpdatedAt'],
        message: 'Refresh before editing',
      })
  })
  .transform((value) => ({
    ...value,
    venueId: value.venueId!,
    expectedUpdatedAt: value.expectedUpdatedAt!,
  }))

export const RetirePlaceInput = z
  .object({
    id: z.string().cuid(),
    venueId: z.string().cuid().optional(),
    expectedUpdatedAt: z.coerce.date().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.venueId)
      ctx.addIssue({ code: 'custom', path: ['venueId'], message: 'Venue is required' })
    if (!value.expectedUpdatedAt)
      ctx.addIssue({
        code: 'custom',
        path: ['expectedUpdatedAt'],
        message: 'Refresh before retiring',
      })
  })
  .transform((value) => ({
    ...value,
    venueId: value.venueId!,
    expectedUpdatedAt: value.expectedUpdatedAt!,
  }))
