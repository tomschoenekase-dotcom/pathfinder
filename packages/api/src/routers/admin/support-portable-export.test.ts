import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportPortableExportInput } from '@pathfinder/contracts'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  read: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@pathfinder/db')>()
  return {
    ...original,
    db: {},
    readSupportPortableExport: mocks.read,
    withTenantIsolationBypass: mocks.bypass,
  }
})

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { SupportPortableExportReadError } from '@pathfinder/db'
import { adminSupportPortableExportRouter } from './support-portable-export'

const input: SupportPortableExportInput = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  recipientUserId: 'recipient-a',
  sections: ['current-venue'],
}

function caller(admin = true) {
  return router({ admin: adminSupportPortableExportRouter }).createCaller({
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'operator', activeTenantId: null, role: 'STAFF', isPlatformAdmin: admin },
  })
}

describe('admin support portable export', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects non-admin callers before the isolation bypass', async () => {
    await expect(caller(false).admin.prepareSupportPortableExport(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(mocks.bypass).not.toHaveBeenCalled()
  })

  it('passes only the strict input to the bounded read helper under the bypass', async () => {
    mocks.read.mockResolvedValue({ contentSha256: 'a'.repeat(64) })
    await expect(caller().admin.prepareSupportPortableExport(input)).resolves.toEqual({
      contentSha256: 'a'.repeat(64),
    })
    expect(mocks.bypass).toHaveBeenCalledOnce()
    expect(mocks.read).toHaveBeenCalledWith(input, {})
  })

  it('maps a bounded source refusal to a payload-too-large response', async () => {
    mocks.read.mockRejectedValue(
      new SupportPortableExportReadError('LIMIT_EXCEEDED', 'Portable export is too large'),
    )
    await expect(caller().admin.prepareSupportPortableExport(input)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    })
  })
})
