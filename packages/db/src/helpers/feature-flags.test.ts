import { beforeEach, describe, expect, it, vi } from 'vitest'

const findUniqueMock = vi.fn()

vi.mock('../client', () => ({
  db: {
    tenantFeatureFlag: {
      findUnique: findUniqueMock,
    },
  },
}))

describe('featureEnabled', () => {
  beforeEach(() => {
    findUniqueMock.mockReset()
  })

  it('returns false for a non-existent flag', async () => {
    findUniqueMock.mockResolvedValueOnce(null)

    const { featureEnabled } = await import('./feature-flags')

    await expect(featureEnabled('tenant_1', 'nonexistent.flag')).resolves.toBe(false)
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        tenantId_flagKey: {
          tenantId: 'tenant_1',
          flagKey: 'nonexistent.flag',
        },
      },
      select: {
        enabled: true,
      },
    })
  })

  it('returns true for an enabled flag', async () => {
    findUniqueMock.mockResolvedValueOnce({ enabled: true })

    const { featureEnabled } = await import('./feature-flags')

    await expect(featureEnabled('tenant_1', 'integrations.square')).resolves.toBe(true)
  })
})
