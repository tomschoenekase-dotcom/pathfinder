import { describe, expect, it, vi } from 'vitest'

import {
  beginClientCreateIntentAction,
  ClientCreateIntentError,
  completeClientCreateIntentAction,
  confirmClientCreateProviderAction,
  startClientCreateProviderAction,
} from './client-create-intents'

const actor = { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' } as const
const identity = {
  requestId: '77777777-7777-4777-8777-777777777777',
  requestHash: 'a'.repeat(64),
  actor,
}

function fixture(existing: Record<string, unknown> | null = null) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    clientCreateIntent: {
      findUnique: vi.fn(async () => existing),
      create: vi.fn(async () => ({
        id: 'intent-1',
        ...identity,
        actorId: actor.id,
        status: 'RESERVED',
        localSlug: null,
        providerOrganizationId: null,
        completedTenantId: null,
        completedVenueId: null,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    clientCreateIntentEvent: { create: vi.fn(async () => ({})) },
  }
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('durable client-create intents', () => {
  it('persists RESERVED before separately fencing the provider call', async () => {
    const { tx, client } = fixture()
    await expect(beginClientCreateIntentAction(identity, client as never)).resolves.toEqual({
      state: 'READY',
    })
    expect(tx.clientCreateIntentEvent.create).toHaveBeenNthCalledWith(1, {
      data: { intentId: 'intent-1', status: 'RESERVED', actorId: 'admin-1' },
    })
    expect(tx.clientCreateIntentEvent.create).toHaveBeenCalledOnce()
    tx.clientCreateIntent.findUnique.mockResolvedValueOnce({
      id: 'intent-1',
      requestHash: identity.requestHash,
      actorId: actor.id,
      status: 'RESERVED',
    })
    await expect(
      startClientCreateProviderAction(
        { ...identity, localSlug: 'the-grand-hotel' },
        client as never,
      ),
    ).resolves.toEqual({ state: 'CALL_PROVIDER' })
    expect(tx.clientCreateIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'PROVIDER_STARTED', localSlug: 'the-grand-hotel' },
      }),
    )
    expect(tx.clientCreateIntentEvent.create).toHaveBeenLastCalledWith({
      data: { intentId: 'intent-1', status: 'PROVIDER_STARTED', actorId: 'admin-1' },
    })
  })

  it('blocks automatic retry after provider dispatch until reconciliation', async () => {
    const { tx, client } = fixture({
      id: 'intent-1',
      requestHash: identity.requestHash,
      actorId: actor.id,
      status: 'PROVIDER_STARTED',
    })
    await expect(beginClientCreateIntentAction(identity, client as never)).resolves.toEqual({
      state: 'RECONCILIATION_REQUIRED',
    })
    expect(tx.clientCreateIntent.updateMany).not.toHaveBeenCalled()
  })

  it('rejects reuse of a request ID for changed input or actor', async () => {
    const { client } = fixture({
      id: 'intent-1',
      requestHash: 'b'.repeat(64),
      actorId: actor.id,
      status: 'PROVIDER_STARTED',
    })
    await expect(beginClientCreateIntentAction(identity, client as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<ClientCreateIntentError>)
  })

  it('claims one verified provider organization then completes exact tenant/request identity', async () => {
    const started = {
      id: 'intent-1',
      requestHash: identity.requestHash,
      actorId: actor.id,
      status: 'PROVIDER_STARTED',
      providerOrganizationId: null,
    }
    const confirmedFixture = fixture(started)
    await confirmClientCreateProviderAction(
      { ...identity, providerOrganizationId: 'org-1' },
      confirmedFixture.client as never,
    )
    expect(confirmedFixture.tx.clientCreateIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'PROVIDER_CONFIRMED', providerOrganizationId: 'org-1' },
      }),
    )

    const completeFixture = fixture({
      ...started,
      status: 'PROVIDER_CONFIRMED',
      providerOrganizationId: 'org-1',
    })
    await completeClientCreateIntentAction(
      {
        ...identity,
        providerOrganizationId: 'org-1',
        tenantId: 'org-1',
        venueId: 'venue-1',
      },
      completeFixture.client as never,
    )
    expect(completeFixture.tx.clientCreateIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'COMPLETED',
          completedTenantId: 'org-1',
          completedVenueId: 'venue-1',
        }),
      }),
    )
  })

  it('maps a provider organization uniqueness race to a domain conflict', async () => {
    const { tx, client } = fixture({
      id: 'intent-1',
      requestHash: identity.requestHash,
      actorId: actor.id,
      status: 'PROVIDER_STARTED',
      providerOrganizationId: null,
    })
    tx.clientCreateIntent.updateMany.mockRejectedValueOnce({ code: 'P2002' })

    await expect(
      confirmClientCreateProviderAction(
        { ...identity, providerOrganizationId: 'org-claimed' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<ClientCreateIntentError>)
  })
})
