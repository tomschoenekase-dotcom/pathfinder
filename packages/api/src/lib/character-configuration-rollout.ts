import { TRPCError } from '@trpc/server'
import { isFeatureEnabled, TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config'

export async function requireCharacterConfigurationRollout(
  db: typeof import('@pathfinder/db').db,
  tenantId: string,
  characterKey?: string | null,
): Promise<void> {
  const globalKeys = ['venueCharacterMode', 'characterRegistry'] as const
  if (
    globalKeys.some((key) => !isFeatureEnabled(key)) ||
    (characterKey === 'tochi' && !isFeatureEnabled('tochiVenueCharacter'))
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Character presentation is not available for this workspace.',
    })
  }
  const requiredTenantKeys = [
    TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
    TOCHI_TENANT_FLAG_KEYS.characterRegistry,
    ...(characterKey === 'tochi' ? [TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter] : []),
  ]
  const rows = await db.tenantFeatureFlag.findMany({
    where: { tenantId, flagKey: { in: requiredTenantKeys }, enabled: true },
    select: { flagKey: true },
  })
  const enabled = new Set(rows.map(({ flagKey }) => flagKey))
  if (requiredTenantKeys.some((key) => !enabled.has(key))) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Character presentation is not available for this workspace.',
    })
  }
}
