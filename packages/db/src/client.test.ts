import { describe, expect, it } from 'vitest'

import { db } from './client'
import { AppendOnlyModelError, TenantIsolationError } from './middleware/tenant-isolation'

describe('exported Prisma client tenant-isolation wiring', () => {
  it('rejects an unscoped tenant query through the real exported client', async () => {
    await expect(db.venue.findMany()).rejects.toEqual(new TenantIsolationError('Venue', 'findMany'))
  })

  it('enforces append-only models through the real exported client', async () => {
    await expect(
      db.aiUsageEvent.updateMany({
        where: { tenantId: 'tenant_test' },
        data: { success: false },
      }),
    ).rejects.toEqual(new AppendOnlyModelError('AiUsageEvent', 'updateMany'))
  })
})
