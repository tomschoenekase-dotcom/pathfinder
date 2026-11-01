import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ enabled: vi.fn() }))
vi.mock('@pathfinder/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/config')>()),
  isFeatureEnabled: mocks.enabled,
}))
import { TOCHI_TENANT_FLAG_KEYS } from '@pathfinder/config'
import { requireCharacterConfigurationRollout } from './character-configuration-rollout'
const database = (keys: string[]) => ({
  tenantFeatureFlag: { findMany: vi.fn().mockResolvedValue(keys.map((flagKey) => ({ flagKey }))) },
})
const all = [
  TOCHI_TENANT_FLAG_KEYS.venueCharacterMode,
  TOCHI_TENANT_FLAG_KEYS.characterRegistry,
  TOCHI_TENANT_FLAG_KEYS.tochiVenueCharacter,
]
beforeEach(() => {
  mocks.enabled.mockReset()
  mocks.enabled.mockReturnValue(true)
})
describe('shared character configuration rollout', () => {
  it('requires global gates before reading tenant flags', async () => {
    mocks.enabled.mockImplementation((key) => key !== 'characterRegistry')
    const db = database(all)
    await expect(
      requireCharacterConfigurationRollout(db as never, 'tenant-a', 'tochi'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(db.tenantFeatureFlag.findMany).not.toHaveBeenCalled()
  })
  it('requires each enabled tenant flag including Tochi-specific rollout', async () => {
    const db = database(all.slice(0, 2))
    await expect(
      requireCharacterConfigurationRollout(db as never, 'tenant-a', 'tochi'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(db.tenantFeatureFlag.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', flagKey: { in: all }, enabled: true },
      select: { flagKey: true },
    })
  })
  it('allows approved tenant configuration but does not require Tochi rollout for another character', async () => {
    await expect(
      requireCharacterConfigurationRollout(database(all) as never, 'tenant-a', 'tochi'),
    ).resolves.toBeUndefined()
    await expect(
      requireCharacterConfigurationRollout(database(all.slice(0, 2)) as never, 'tenant-a', 'owl'),
    ).resolves.toBeUndefined()
    mocks.enabled.mockImplementation((key) => key !== 'tochiVenueCharacter')
    await expect(
      requireCharacterConfigurationRollout(database(all) as never, 'tenant-a', 'tochi'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
