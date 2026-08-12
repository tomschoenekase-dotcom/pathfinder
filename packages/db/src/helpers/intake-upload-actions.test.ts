import { describe, expect, it, vi } from 'vitest'

import {
  claimIntakeUploadVerificationAction,
  finalizeVerifiedIntakeUploadAction,
  IntakeUploadActionError,
  intakeUploadRequestHash,
  releaseIntakeUploadVerificationAction,
  reserveIntakeUploadAction,
} from './intake-upload-actions'

const scope = { tenantId: 'tenant-1', venueId: 'venue-1', uploadId: 'upload-1' }
const actor = { type: 'HUMAN' as const, id: 'person-1', role: 'STAFF' as const }
const claimId = 'a0611ca8-c0ac-458d-a7fa-afc98c4eaf9f'
const objectIdentity = {
  objectKey: 'staging/intake-quarantine/1e158e87-55d4-46ad-bc82-9e40e47b2418',
  objectGeneration: '9dc1cf0c-5828-41e7-a41e-83d01bdfd837',
}
const request = {
  requestId: '6ffeb6d2-d68d-45ae-92d9-ed61171812dd',
  displayName: 'Visitor guide',
  fileName: 'guide.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 42,
  sha256: 'a'.repeat(64),
}

function upload(overrides: Record<string, unknown> = {}) {
  return {
    id: scope.uploadId,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    requestId: request.requestId,
    requestHash: 'b'.repeat(64),
    displayName: request.displayName,
    fileName: request.fileName,
    mimeType: request.mimeType,
    byteSize: request.byteSize,
    sha256: request.sha256,
    objectKey: 'intake-quarantine/opaque/opaque',
    objectGeneration: '9dc1cf0c-5828-41e7-a41e-83d01bdfd837',
    storageVersionId: null,
    status: 'RESERVED',
    verificationClaimId: null,
    verificationClaimedAt: null,
    verificationLeaseUntil: null,
    verifiedAt: null,
    rejectedAt: null,
    rejectionCode: null,
    intakeRunId: null,
    requestedBy: actor.id,
    requestedByRole: actor.role,
    createdAt: new Date('2026-08-11T12:00:00Z'),
    updatedAt: new Date('2026-08-11T12:00:00Z'),
    ...overrides,
  }
}

function transactionClient(tx: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (fn) => fn(tx)),
    intakeUpload: tx.intakeUpload,
    venue: tx.venue,
  }
}

describe('quarantined intake upload actions', () => {
  it('rejects malformed actors and path-like browser filenames before the database', async () => {
    await expect(
      reserveIntakeUploadAction({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        actor: { ...actor, role: 'ADMIN' } as never,
        request,
        trustedObjectIdentity: objectIdentity,
        client: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      reserveIntakeUploadAction({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        actor,
        request: { ...request, fileName: '../guide.pdf' },
        trustedObjectIdentity: objectIdentity,
        client: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('does not replay another actor request identity or disclose its upload target', async () => {
    const existing = upload({
      requestHash: intakeUploadRequestHash(request),
      requestedBy: 'different-person',
      requestedByRole: 'MANAGER',
    })
    const tx = {
      $executeRaw: vi.fn(),
      intakeUpload: { findFirst: vi.fn().mockResolvedValue(existing) },
      venue: { findFirst: vi.fn() },
    }
    await expect(
      reserveIntakeUploadAction({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        actor,
        request,
        trustedObjectIdentity: objectIdentity,
        client: transactionClient(tx) as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.venue.findFirst).not.toHaveBeenCalled()
  })

  it('claims RESERVED with exact scope/CAS and returns transport identity', async () => {
    const current = upload()
    const tx = {
      intakeUpload: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(
            upload({
              status: 'VERIFYING',
              verificationClaimId: claimId,
              verificationLeaseUntil: new Date(Date.now() + 60_000),
            }),
          ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    const result = await claimIntakeUploadVerificationAction({
      ...scope,
      actor,
      claimId,
      client: transactionClient(tx) as never,
    })
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...scope,
          OR: expect.arrayContaining([
            { status: 'RESERVED', verificationClaimId: null, verificationLeaseUntil: null },
          ]),
        }),
      }),
    )
    expect(result.uploadTarget).toEqual({
      objectKey: current.objectKey,
      objectGeneration: current.objectGeneration,
      mimeType: current.mimeType,
      byteSize: current.byteSize,
      sha256: current.sha256,
    })
  })

  it('records unavailable as retryable while preserving VERIFYING and the same claim', async () => {
    const current = upload({
      status: 'VERIFYING',
      verificationClaimId: claimId,
      verificationLeaseUntil: new Date(Date.now() + 60_000),
    })
    const tx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    const result = await releaseIntakeUploadVerificationAction({
      ...scope,
      actor,
      claimId,
      reasonCode: 'TRANSPORT_UNAVAILABLE',
      client: transactionClient(tx) as never,
    })
    expect(result.retryable).toBe(true)
    expect(result.upload.status).toBe('VERIFYING')
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'intake-upload.verification-unavailable',
          afterState: expect.objectContaining({ status: 'VERIFYING', retryable: true }),
        }),
      }),
    )
  })

  it('does not create a run when verified transport differs from the reservation', async () => {
    const tx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(
          upload({
            status: 'VERIFYING',
            verificationClaimId: claimId,
            verificationLeaseUntil: new Date(Date.now() + 60_000),
          }),
        ),
      },
      intakeRun: { create: vi.fn() },
    }
    await expect(
      finalizeVerifiedIntakeUploadAction({
        ...scope,
        actor,
        claimId,
        verified: {
          objectGeneration: '9dc1cf0c-5828-41e7-a41e-83d01bdfd837',
          storageVersionId: 'version-1',
          mimeType: 'application/pdf',
          byteSize: 42,
          sha256: 'c'.repeat(64),
        },
        client: transactionClient(tx) as never,
      }),
    ).rejects.toBeInstanceOf(IntakeUploadActionError)
    expect(tx.intakeRun.create).not.toHaveBeenCalled()
  })

  it('creates only a review proposal/evidence/events after exact verification and uses CAS', async () => {
    const current = upload({
      status: 'VERIFYING',
      verificationClaimId: claimId,
      verificationLeaseUntil: new Date(Date.now() + 60_000),
    })
    const tx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      intakeRun: {
        create: vi.fn().mockResolvedValue({
          id: 'run-1',
          status: 'AWAITING_REVIEW',
          sourceKind: 'FILE_UPLOAD',
          createdAt: new Date(),
        }),
      },
      intakeEvidenceRecord: { create: vi.fn() },
      intakeRunEvent: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const result = await finalizeVerifiedIntakeUploadAction({
      ...scope,
      actor,
      claimId,
      verified: {
        objectGeneration: current.objectGeneration,
        storageVersionId: 'version-1',
        mimeType: 'application/pdf',
        byteSize: 42,
        sha256: request.sha256,
      },
      client: transactionClient(tx) as never,
    })
    expect(tx.intakeRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' }),
      }),
    )
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...scope,
          status: 'VERIFYING',
          verificationClaimId: claimId,
          intakeRunId: null,
        }),
      }),
    )
    expect(result).toMatchObject({
      nextAction: 'PATHFINDER_REVIEW',
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    expect(tx.intakeRunEvent.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({ formatVerified: false, malwareScanned: false }),
        }),
      }),
    )
  })

  it('recovers an expired claim with exact CAS and omits claim identity from audit', async () => {
    const expired = upload({
      status: 'VERIFYING',
      verificationClaimId: '2076a9fc-dd96-4725-8602-b63f8f4acb40',
      verificationClaimedAt: new Date(Date.now() - 120_000),
      verificationLeaseUntil: new Date(Date.now() - 60_000),
    })
    const recovered = upload({
      status: 'VERIFYING',
      verificationClaimId: claimId,
      verificationLeaseUntil: new Date(Date.now() + 600_000),
    })
    const tx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValueOnce(expired).mockResolvedValueOnce(recovered),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    const result = await claimIntakeUploadVerificationAction({
      ...scope,
      actor,
      claimId,
      client: transactionClient(tx) as never,
    })
    expect(result).toMatchObject({ state: 'VERIFYING', replayed: false })
    const audit = tx.auditLog.create.mock.calls[0]?.[0]
    expect(JSON.stringify(audit)).not.toContain(claimId)
  })

  it('replays the terminal review state without exposing transport identity or creating work', async () => {
    const terminal = upload({ status: 'AWAITING_REVIEW', intakeRunId: 'run-1' })
    const tx = {
      intakeUpload: { findFirst: vi.fn().mockResolvedValue(terminal), updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const result = await claimIntakeUploadVerificationAction({
      ...scope,
      actor,
      claimId,
      client: transactionClient(tx) as never,
    })
    expect(result).toEqual({ state: 'AWAITING_REVIEW', upload: expect.any(Object), replayed: true })
    expect(result).not.toHaveProperty('uploadTarget')
    expect(tx.intakeUpload.updateMany).not.toHaveBeenCalled()
  })
})
