import type { FeatureFlagKey } from '@pathfinder/config/feature-flags'

import { db } from '../client'

type FeatureFlagLookupKey = FeatureFlagKey | (string & {})

export async function featureEnabled(
  tenantId: string,
  flagKey: FeatureFlagLookupKey,
): Promise<boolean> {
  const flag = await db.tenantFeatureFlag.findUnique({
    where: {
      tenantId_flagKey: {
        tenantId,
        flagKey,
      },
    },
    select: {
      enabled: true,
    },
  })

  return flag?.enabled ?? false
}
