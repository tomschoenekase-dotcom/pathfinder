import { UnrecoverableError } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ updateMany: vi.fn(), withTenantIsolationBypass: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  db: { mediaIngestionProject: { updateMany: mocks.updateMany } },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
}))

import {
  executeMediaProviderOperation,
  MAX_MEDIA_PROVIDER_OPERATIONS,
  reserveMediaProviderOperation,
} from './media-provider-budget'

const identity = {
  tenantId: 'tenant_1',
  projectId: 'project_1',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}

describe('durable media provider-operation budget', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
  })

  it('atomically reserves one operation for the exact tenant and upload generation', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 })

    await reserveMediaProviderOperation(identity)

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'project_1',
        tenantId: 'tenant_1',
        uploadAttemptId: identity.uploadAttemptId,
        status: { in: ['ANALYZING', 'SYNTHESIZING'] },
        providerOperationCount: { lt: MAX_MEDIA_PROVIDER_OPERATIONS },
      },
      data: { providerOperationCount: { increment: 1 } },
    })
  })

  it('fails unrecoverably when the generation cannot reserve another operation', async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(reserveMediaProviderOperation(identity)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('charges before dispatch, including a provider failure, and never calls after refusal', async () => {
    const order: string[] = []
    const reserve = vi.fn(async () => {
      order.push('reserve')
    })
    const failedOperation = vi.fn(async () => {
      order.push('provider')
      throw new Error('provider unavailable')
    })

    await expect(executeMediaProviderOperation(reserve, failedOperation)).rejects.toThrow(
      'provider unavailable',
    )
    expect(order).toEqual(['reserve', 'provider'])

    const refused = vi.fn(async () => {
      throw new UnrecoverableError('budget exhausted')
    })
    const notDispatched = vi.fn(async () => 'unexpected')
    await expect(executeMediaProviderOperation(refused, notDispatched)).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(notDispatched).not.toHaveBeenCalled()
  })

  it('charges but does not dispatch if ownership is lost during reservation', async () => {
    const reserve = vi.fn(async () => undefined)
    const operation = vi.fn(async () => 'unexpected')
    const assertActive = vi.fn(() => {
      throw new Error('ownership lost')
    })

    await expect(executeMediaProviderOperation(reserve, operation, assertActive)).rejects.toThrow(
      'ownership lost',
    )
    expect(reserve).toHaveBeenCalledOnce()
    expect(assertActive).toHaveBeenCalledOnce()
    expect(operation).not.toHaveBeenCalled()
  })
})
