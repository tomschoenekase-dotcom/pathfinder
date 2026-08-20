import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { ProspectActionError } from '@pathfinder/db'

export const prospectStage = z.enum([
  'DISCOVERED',
  'RESEARCHED',
  'NEEDS_REVIEW',
  'READY_FOR_OUTREACH',
  'CONTACTED',
  'FOLLOW_UP_DUE',
  'REPLIED',
  'CONVERSATION',
  'QUALIFIED',
  'PROPOSAL_DECISION',
  'WON',
  'LOST',
  'PARKED',
  'DO_NOT_CONTACT',
])
export const prospectPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export const prospectBoundedText = (max: number) => z.string().trim().min(1).max(max)
export const prospectActor = (userId: string) =>
  ({ type: 'HUMAN', id: userId, role: 'PLATFORM_ADMIN' }) as const

export function mapProspectActionError(error: unknown): never {
  if (error instanceof ProspectActionError) {
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : 'CONFLICT'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

export const normalizedProspectImportRow = z
  .object({
    organizationName: z.string().max(300).optional(),
    venueName: z.string().max(300),
    venueType: z.string().max(200).optional(),
    venueSubtype: z.string().max(200).optional(),
    city: z.string().max(200).optional(),
    region: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    website: z.string().max(2000).optional(),
    generalEmail: z.string().max(320).optional(),
    contactName: z.string().max(300).optional(),
    contactTitle: z.string().max(300).optional(),
    contactEmail: z.string().max(320).optional(),
    phone: z.string().max(200).optional(),
    ownerSize: z.string().max(100).optional(),
    locationCount: z.string().max(100).optional(),
    venueSize: z.string().max(100).optional(),
    shortDescription: z.string().max(5000).optional(),
    fitScore: z.string().max(100).optional(),
    fitReason: z.string().max(5000).optional(),
    primaryUseCase: z.string().max(300).optional(),
    outreachPriority: z.string().max(100).optional(),
    personalizationHook: z.string().max(5000).optional(),
    researchConfidence: z.string().max(100).optional(),
    researchDate: z.string().max(100).optional(),
    sourceUrls: z.array(z.string().max(2000)).max(20).optional(),
    notes: z.string().max(10000).optional(),
    territory: z.string().max(200).optional(),
  })
  .strict()
