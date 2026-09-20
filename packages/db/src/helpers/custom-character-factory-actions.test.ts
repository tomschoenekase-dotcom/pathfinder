import { describe, expect, it, vi } from 'vitest'

vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn().mockResolvedValue(undefined) }))

import { prepareCharacterFactoryJobInTransaction } from './custom-character-factory-actions'

const now = new Date('2026-09-20T00:00:00Z')
const approvedAppearanceFingerprint = 'a'.repeat(64)

function transaction() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'job-1',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    requestId: 'request-1',
    requestFingerprint: 'b'.repeat(64),
    action: 'EXPORT',
    status: 'QUEUED',
    requestPayload: data.requestPayload,
    resultPayload: null,
    errorCode: null,
    errorMessage: null,
    customCharacterId: 'character-1',
    baseVersion: 1,
    baseRevision: 1,
    resultVersion: null,
    resultRevision: null,
    attemptNumber: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    claimedAt: null,
    cancelRequestedAt: null,
    completedAt: null,
    createdBy: 'admin-1',
    createdAt: now,
    updatedAt: now,
  }))
  return {
    create,
    value: {
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-1' }) },
      customCharacter: {
        findFirst: vi.fn().mockResolvedValue({ version: 1, revision: 1 }),
      },
      characterFactoryJob: { findFirst: vi.fn().mockResolvedValue(null), create },
    } as never,
  }
}

describe('character factory export preparation', () => {
  it('retains the strict founder-approved animation preparation receipt', async () => {
    const tx = transaction()
    const requestPayload = {
      includeEditableSource: true,
      workflowStage: 'ANIMATION_PREPARATION',
      approvedAppearanceFingerprint,
      motionCapability: 'rigid-source',
      publicationAuthorized: false,
    } as const

    await expect(
      prepareCharacterFactoryJobInTransaction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'request-1',
          action: 'EXPORT',
          requestPayload,
          characterId: 'character-1',
          baseVersion: 1,
          baseRevision: 1,
          actor: { id: 'admin-1', role: 'PLATFORM_ADMIN', type: 'HUMAN' },
        },
        tx.value,
      ),
    ).resolves.toMatchObject({ job: { action: 'EXPORT', status: 'QUEUED' }, replayed: false })
    expect(tx.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestPayload }),
    })
  })

  it('keeps publication authority fail-closed for animation preparation', async () => {
    const tx = transaction()
    await expect(
      prepareCharacterFactoryJobInTransaction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          requestId: 'request-1',
          action: 'EXPORT',
          requestPayload: {
            includeEditableSource: true,
            workflowStage: 'ANIMATION_PREPARATION',
            approvedAppearanceFingerprint,
            motionCapability: 'rigid-source',
            publicationAuthorized: true,
          },
          characterId: 'character-1',
          baseVersion: 1,
          baseRevision: 1,
          actor: { id: 'admin-1', role: 'PLATFORM_ADMIN', type: 'HUMAN' },
        },
        tx.value,
      ),
    ).rejects.toThrow()
    expect(tx.create).not.toHaveBeenCalled()
  })
})
