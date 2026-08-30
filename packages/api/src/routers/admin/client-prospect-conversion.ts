import { z } from 'zod'

import {
  linkProspectConversionAction,
  withTenantIsolationBypass,
  type PlatformAdminActor,
} from '@pathfinder/db'

export const clientCreateProspectConversionInput = z
  .object({
    organizationId: z.string().min(1).max(191),
    prospectVenueId: z.string().min(1).max(191).optional(),
  })
  .strict()
  .optional()

export type ClientCreateProspectConversion = z.infer<typeof clientCreateProspectConversionInput>

export function bindClientCreateProspectConversion(input: {
  conversion: ClientCreateProspectConversion
  tenantId: string
  venueId: string
  requestId: string
  actor: PlatformAdminActor
}) {
  const conversion = input.conversion
  if (!conversion) return null
  return withTenantIsolationBypass(() =>
    linkProspectConversionAction({
      organizationId: conversion.organizationId,
      ...(conversion.prospectVenueId
        ? { prospectVenueId: conversion.prospectVenueId, venueId: input.venueId }
        : {}),
      tenantId: input.tenantId,
      evidence: { clientCreateRequestId: input.requestId },
      actor: input.actor,
    }),
  )
}
