import { TRPCError } from '@trpc/server'

import type { TRPCContext } from '../context'

type ReportConfigurationClient = Pick<TRPCContext['db'], 'venueReportConfiguration'>

export const venueReportConfigurationSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  enabled: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

export async function findVenueReportConfiguration(
  client: ReportConfigurationClient,
  tenantId: string,
  venueId: string,
) {
  return client.venueReportConfiguration.findFirst({
    where: { tenantId, venueId },
    select: venueReportConfigurationSelect,
  })
}

export async function requireVenueReportsEnabled(
  client: ReportConfigurationClient,
  tenantId: string,
  venueId: string,
): Promise<void> {
  const configuration = await findVenueReportConfiguration(client, tenantId, venueId)
  if (configuration?.enabled !== true) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Weekly reports are disabled for this venue.',
    })
  }
}
