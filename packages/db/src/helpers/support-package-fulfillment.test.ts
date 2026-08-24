import { describe, expect, it, vi } from 'vitest'

import {
  readSupportPackageFulfillment,
  sameSupportPackageFulfillment,
} from './support-package-fulfillment'

const scope = { tenantId: 'tenant_1', venueId: 'venue_1', supportRequestId: 'request_1' }

describe('support package fulfillment evidence', () => {
  it('represents package-free completion with a deterministic exact digest', async () => {
    const reader = { supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([]) } }
    const first = await readSupportPackageFulfillment(reader as never, scope)
    const second = await readSupportPackageFulfillment(reader as never, scope)
    expect(first).toMatchObject({ contractVersion: 1, linkedPackageCount: 0, packages: [] })
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(sameSupportPackageFulfillment(first, second)).toBe(true)
    expect(reader.supportPackageHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ supersessionAsPrior: { is: null } }),
      }),
    )
  })

  it('freezes complete APPLIED identity and rejects any non-applied package', async () => {
    const applied = {
      id: 'handoff_1',
      venuePackageId: 'package_1',
      requestVersion: 6,
      venuePackage: {
        status: 'APPLIED',
        payloadHash: 'a'.repeat(64),
        appliedAt: new Date('2026-08-24T20:00:00.000Z'),
        appliedBy: 'agent_1',
        appliedCommandKey: '11111111-1111-4111-8111-111111111111',
        updatedAt: new Date('2026-08-24T20:00:01.000Z'),
      },
    }
    const reader = {
      supportPackageHandoff: { findMany: vi.fn().mockResolvedValue([applied]) },
    }
    await expect(readSupportPackageFulfillment(reader as never, scope)).resolves.toMatchObject({
      linkedPackageCount: 1,
      packages: [
        {
          handoffId: 'handoff_1',
          packageId: 'package_1',
          status: 'APPLIED',
          appliedBy: 'agent_1',
        },
      ],
    })

    reader.supportPackageHandoff.findMany.mockResolvedValueOnce([
      {
        ...applied,
        venuePackage: {
          ...applied.venuePackage,
          status: 'APPROVED',
          appliedAt: null,
          appliedBy: null,
          appliedCommandKey: null,
        },
      },
    ])
    await expect(readSupportPackageFulfillment(reader as never, scope)).rejects.toThrow(
      'Linked venue package package_1 is not fully applied.',
    )
  })
})
