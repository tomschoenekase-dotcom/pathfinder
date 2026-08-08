import { describe, expect, it, vi } from 'vitest'

import type { TRPCContext } from '../context'
import {
  findVenueReportConfiguration,
  requireVenueReportsEnabled,
} from './venue-report-configuration'

const findFirst = vi.fn()
const client = {
  venueReportConfiguration: { findFirst },
} as unknown as TRPCContext['db']

describe('venue report configuration', () => {
  it('reads only the exact tenant and venue tuple', async () => {
    findFirst.mockResolvedValueOnce(null)

    await findVenueReportConfiguration(client, 'tenant_1', 'venue_1')

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
      }),
    )
  })

  it('treats a missing row as disabled', async () => {
    findFirst.mockResolvedValueOnce(null)

    await expect(requireVenueReportsEnabled(client, 'tenant_1', 'venue_1')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })

  it('allows an explicitly enabled venue', async () => {
    findFirst.mockResolvedValueOnce({ enabled: true })

    await expect(requireVenueReportsEnabled(client, 'tenant_1', 'venue_1')).resolves.toBeUndefined()
  })
})
