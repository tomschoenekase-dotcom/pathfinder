import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminExternalCredentialsRouter } from './external-credentials'

const findMany = vi.fn()
const findFirst = vi.fn()
const app = router({ admin: adminExternalCredentialsRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {
      externalAccessCredential: { findMany, findFirst },
    } as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin external credential metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findMany.mockResolvedValue([])
  })

  it('requires platform-admin authorization', async () => {
    await expect(
      app.createCaller(context(false)).admin.listExternalCredentials({
        tenantId: 'tenant_1',
        clientId: 'tenant_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('rejects a client identifier that differs from tenant authority', async () => {
    await expect(
      app.createCaller(context()).admin.listExternalCredentials({
        tenantId: 'tenant_1',
        clientId: 'tenant_2',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('uses exact tenant/client/venue scope and never selects the secret hash', async () => {
    await app.createCaller(context()).admin.listExternalCredentials({
      tenantId: 'tenant_1',
      clientId: 'tenant_1',
      venueId: 'venue_1',
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant_1',
          clientId: 'tenant_1',
          venueId: 'venue_1',
        }),
      }),
    )
    const select = findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>
    expect(select.secretHash).toBeUndefined()
  })

  it('scopes credential detail and immutable evidence to the exact venue', async () => {
    findFirst.mockResolvedValue({ id: 'credential_1' })
    await app.createCaller(context()).admin.getExternalCredential({
      tenantId: 'tenant_1',
      clientId: 'tenant_1',
      venueId: 'venue_1',
      credentialId: 'credential_1',
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'credential_1',
          tenantId: 'tenant_1',
          clientId: 'tenant_1',
          venueId: 'venue_1',
        },
      }),
    )
    const select = findFirst.mock.calls[0]?.[0]?.select as Record<string, unknown>
    expect(select.secretHash).toBeUndefined()
    expect(select.rotationsFrom).toBeTruthy()
    expect(select.rotationsTo).toBeTruthy()
    expect(select.revocation).toBeTruthy()
  })
})
