import { describe, expect, it, vi } from 'vitest'

import { publishCrmOperationalSignal } from './crm-operational-events'

describe('publishCrmOperationalSignal', () => {
  it('publishes platform-owned prospect signals without inventing a tenant', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue({ id: 'event-platform', state: 'OPEN', occurrenceCount: 1 })

    await expect(
      publishCrmOperationalSignal({
        client: { platformOperationalEvent: { upsert } } as never,
        input: {
          signal: 'batch_awaiting_release',
          scope: { kind: 'platform' },
          linkedObjectType: 'ProspectSendBatch',
          linkedObjectId: 'batch-1',
          summary: 'A bounded batch is approved and remains unreleased.',
        },
      }),
    ).resolves.toEqual({
      published: true,
      scope: 'platform',
      event: { id: 'event-platform', state: 'OPEN', occurrenceCount: 1 },
    })

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deduplicationKey: 'crm:batch_awaiting_release:ProspectSendBatch:batch-1',
        },
      }),
    )
  })

  it('publishes a sanitized signal only when an exact tenant scope is supplied', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'event-1', state: 'OPEN', occurrenceCount: 1 })

    await expect(
      publishCrmOperationalSignal({
        client: { operationalEvent: { upsert } } as never,
        input: {
          signal: 'provider_authentication_failed',
          scope: { kind: 'tenant', tenantId: 'tenant-1', venueId: 'venue-1' },
          linkedObjectType: 'CorrespondenceProviderAccount',
          linkedObjectId: 'mailbox-1',
          summary: 'The provider rejected the stored credential reference.',
        },
      }),
    ).resolves.toEqual({
      published: true,
      scope: 'tenant',
      event: { id: 'event-1', state: 'OPEN', occurrenceCount: 1 },
    })

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_deduplicationKey: {
            tenantId: 'tenant-1',
            deduplicationKey:
              'crm:provider_authentication_failed:CorrespondenceProviderAccount:mailbox-1',
          },
        },
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          sourceSubsystem: 'prospect-crm',
          eventType: 'crm.provider.authentication_failed',
          severity: 'CRITICAL',
          actionRequired: true,
        }),
      }),
    )
  })

  it('groups repeated occurrences by a bounded explicit discriminator', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'event-2', state: 'OPEN', occurrenceCount: 2 })

    await publishCrmOperationalSignal({
      client: { operationalEvent: { upsert } } as never,
      input: {
        signal: 'gmail_sync_failed',
        scope: { kind: 'tenant', tenantId: 'tenant-1' },
        linkedObjectType: 'CorrespondenceProviderAccount',
        linkedObjectId: 'mailbox-1',
        deduplicationDiscriminator: 'history-cursor-expired',
        summary: 'Incremental sync requires a full reconciliation.',
      },
    })

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_deduplicationKey: {
            tenantId: 'tenant-1',
            deduplicationKey:
              'crm:gmail_sync_failed:CorrespondenceProviderAccount:mailbox-1:history-cursor-expired',
          },
        },
      }),
    )
  })
})
