import { describe, expect, it, vi } from 'vitest'
import {
  INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES,
  INTAKE_UPLOAD_VENUE_MAX_BYTES,
} from '@pathfinder/contracts/intake-upload'

import {
  claimIntakeUploadVerificationAction,
  recordIntakeUploadPrecheckAction,
  IntakeUploadActionError,
  intakeUploadRequestHash,
  releaseIntakeUploadVerificationAction,
  renewIntakeUploadVerificationLeaseAction,
  reserveIntakeUploadAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  bindIntakeUploadMultipartAction,
  cancelIntakeUploadMultipartAction,
  completeIntakeUploadMultipartAction,
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
  category: 'FLOOR_PLAN' as const,
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
    category: request.category,
    byteSize: request.byteSize,
    sha256: request.sha256,
    objectKey: 'intake-quarantine/opaque/opaque',
    objectGeneration: '9dc1cf0c-5828-41e7-a41e-83d01bdfd837',
    storageVersionId: null,
    multipartUploadId: null,
    multipartStartedAt: null,
    multipartCompletedAt: null,
    multipartAbortedAt: null,
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

  it('rejects oversized documents before opening a transaction', async () => {
    const client = { $transaction: vi.fn() }
    await expect(
      reserveIntakeUploadAction({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        actor,
        request: { ...request, byteSize: INTAKE_UPLOAD_NON_MEDIA_MAX_BYTES + 1 },
        trustedObjectIdentity: objectIdentity,
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
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

  it('serializes venue quota checks and refuses reservations above 50 GB', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn().mockResolvedValue({
          _sum: { byteSize: INTAKE_UPLOAD_VENUE_MAX_BYTES - request.byteSize + 1 },
        }),
        create: vi.fn(),
      },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: scope.venueId }) },
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
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
    expect(tx.intakeUpload.create).not.toHaveBeenCalled()
  })

  it('binds, completes, and cancels only the exact owner-scoped multipart identity', async () => {
    const multipartUploadId = 'storage-multipart-1'
    const startedAt = new Date('2026-08-18T18:00:00.000Z')
    const bound = upload({ multipartUploadId, multipartStartedAt: startedAt })
    const bindTx = {
      $executeRaw: vi.fn(),
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValueOnce(upload()).mockResolvedValueOnce(bound),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    await expect(
      bindIntakeUploadMultipartAction({
        ...scope,
        actor,
        multipartUploadId,
        client: transactionClient(bindTx) as never,
      }),
    ).resolves.toMatchObject({ replayed: false, upload: { multipartUploadId } })
    expect(bindTx.auditLog.create).toHaveBeenCalledOnce()

    const completed = upload({
      multipartUploadId,
      multipartStartedAt: startedAt,
      multipartCompletedAt: new Date('2026-08-18T18:01:00.000Z'),
    })
    const completeTx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValueOnce(bound).mockResolvedValueOnce(completed),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn() },
    }
    await expect(
      completeIntakeUploadMultipartAction({
        ...scope,
        actor,
        multipartUploadId,
        client: transactionClient(completeTx) as never,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      upload: { multipartCompletedAt: expect.any(Date) },
    })

    const cancelTx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(completed),
        updateMany: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    }
    await expect(
      cancelIntakeUploadMultipartAction({
        ...scope,
        actor,
        multipartUploadId,
        client: transactionClient(cancelTx) as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(cancelTx.intakeUpload.updateMany).not.toHaveBeenCalled()
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
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          id: scope.uploadId,
          OR: expect.arrayContaining([
            { status: 'RESERVED', verificationClaimId: null, verificationLeaseUntil: null },
          ]),
        }),
      }),
    )
    expect(tx.intakeUpload.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { tenantId: scope.tenantId, venueId: scope.venueId, id: scope.uploadId },
      }),
    )
    expect(result.uploadTarget).toEqual({
      objectKey: current.objectKey,
      objectGeneration: current.objectGeneration,
      mimeType: current.mimeType,
      byteSize: current.byteSize,
      sha256: current.sha256,
      storageVersionId: null,
      multipartUploadId: null,
      multipartStartedAt: null,
      multipartCompletedAt: null,
      multipartAbortedAt: null,
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

  it('renews only the exact live verification claim with CAS', async () => {
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
    }
    await renewIntakeUploadVerificationLeaseAction({
      ...scope,
      actor,
      claimId,
      client: transactionClient(tx) as never,
    })
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'VERIFYING', verificationClaimId: claimId }),
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
      recordIntakeUploadPrecheckAction({
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
        evidence: {
          engine: 'pathfinder-magic-bytes',
          engineVersion: '1',
          verdictHash: 'd'.repeat(64),
          computedByteSize: 42,
          computedSha256: 'c'.repeat(64),
        },
        client: transactionClient(tx) as never,
      }),
    ).rejects.toBeInstanceOf(IntakeUploadActionError)
    expect(tx.intakeRun.create).not.toHaveBeenCalled()
  })

  it('records only immutable local precheck evidence and remains quarantined without a scanner', async () => {
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
      intakeUploadVerificationReceipt: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const result = await recordIntakeUploadPrecheckAction({
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
      evidence: {
        engine: 'pathfinder-magic-bytes',
        engineVersion: '1',
        verdictHash: 'd'.repeat(64),
        computedByteSize: 42,
        computedSha256: request.sha256,
      },
      client: transactionClient(tx) as never,
    })
    expect(tx.intakeUploadVerificationReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'PRECHECK', verdict: 'PASSED', claimId }),
      }),
    )
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          id: scope.uploadId,
          status: 'VERIFYING',
          verificationClaimId: claimId,
          intakeRunId: null,
        }),
      }),
    )
    expect(result).toMatchObject({ nextAction: 'MALWARE_SCAN_PENDING' })
    expect(tx.intakeUpload.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PRECHECK_PASSED' }) }),
    )
  })

  it('atomically records authoritative receipts and creates a cited file intake run', async () => {
    const current = upload({
      status: 'VERIFYING',
      storageVersionId: 'version-1',
      verificationClaimId: claimId,
      verificationLeaseUntil: new Date(Date.now() + 60_000),
    })
    const tx = {
      $executeRaw: vi.fn(),
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      intakeUploadVerificationReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          claimId,
          objectGeneration: current.objectGeneration,
          storageVersionId: 'version-1',
          computedByteSize: current.byteSize,
          computedSha256: current.sha256,
          verdictHash: 'd'.repeat(64),
        }),
        create: vi.fn(),
      },
      intakeRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }) },
      intakeEvidenceRecord: { create: vi.fn() },
      intakeRunEvent: { createMany: vi.fn() },
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => data),
      },
      auditLog: { create: vi.fn() },
    }
    const result = await settleIntakeUploadAuthoritativeVerificationAction({
      ...scope,
      actor,
      claimId,
      malware: {
        verdict: 'CLEAN',
        engine: 'clamav-clamd',
        engineVersion: 'daemon',
        verdictHash: 'e'.repeat(64),
        computedByteSize: current.byteSize,
        computedSha256: current.sha256,
      },
      client: transactionClient(tx) as never,
    })

    expect(tx.intakeUploadVerificationReceipt.create).toHaveBeenCalledTimes(2)
    expect(tx.intakeRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          submissionRequestId: expect.anything(),
          submissionInputHash: expect.anything(),
        }),
      }),
    )
    expect(tx.intakeUploadVerificationReceipt.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'RESOURCE_SAFETY', verdict: 'PASSED' }),
      }),
    )
    expect(tx.intakeUploadVerificationReceipt.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'MALWARE', verdict: 'CLEAN' }),
      }),
    )
    expect(tx.intakeEvidenceRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: 'run-1',
          locator: 'intake-upload:upload-1',
          normalizedHash: current.sha256,
        }),
      }),
    )
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'AWAITING_REVIEW', intakeRunId: 'run-1' }),
      }),
    )
    expect(result).toMatchObject({ nextAction: 'PATHFINDER_REVIEW', replayed: false })
    expect(tx.onboardingMilestoneEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'FIRST_USEFUL_MATERIAL',
        sourceType: 'INTAKE_UPLOAD',
        sourceId: 'upload-1',
        category: 'FLOOR_PLAN',
      }),
    })
  })

  it('records an infected verdict without creating reviewable intake evidence', async () => {
    const current = upload({
      status: 'VERIFYING',
      storageVersionId: 'version-1',
      verificationClaimId: claimId,
      verificationLeaseUntil: new Date(Date.now() + 60_000),
    })
    const tx = {
      $executeRaw: vi.fn(),
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      intakeUploadVerificationReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          claimId,
          objectGeneration: current.objectGeneration,
          storageVersionId: 'version-1',
          computedByteSize: current.byteSize,
          computedSha256: current.sha256,
          verdictHash: 'd'.repeat(64),
        }),
        create: vi.fn(),
      },
      intakeRun: { create: vi.fn() },
      onboardingMilestoneEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }) => data),
      },
      auditLog: { create: vi.fn() },
    }
    const result = await settleIntakeUploadAuthoritativeVerificationAction({
      ...scope,
      actor,
      claimId,
      malware: {
        verdict: 'INFECTED',
        engine: 'clamav-clamd',
        engineVersion: 'daemon',
        verdictHash: 'f'.repeat(64),
        computedByteSize: current.byteSize,
        computedSha256: current.sha256,
      },
      client: transactionClient(tx) as never,
    })
    expect(tx.intakeUpload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          id: scope.uploadId,
          status: 'VERIFYING',
          verificationClaimId: claimId,
        }),
        data: expect.objectContaining({ status: 'REJECTED' }),
      }),
    )
    expect(tx.intakeRun.create).not.toHaveBeenCalled()
    expect(result.nextAction).toBe('RESELECT_FILE')
    expect(tx.onboardingMilestoneEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'UPLOAD_FAILED', sourceId: 'upload-1' }),
    })
  })

  it('converges a concurrent same-claim precheck receipt from a fresh read', async () => {
    const evidence = {
      engine: 'pathfinder-magic-bytes',
      engineVersion: '1',
      verdictHash: 'd'.repeat(64),
      computedByteSize: 42,
      computedSha256: request.sha256,
    }
    const client = {
      $transaction: vi.fn().mockRejectedValue({ code: 'P2002' }),
      intakeUpload: {
        findFirst: vi
          .fn()
          .mockResolvedValue(upload({ status: 'PRECHECK_PASSED', storageVersionId: 'version-1' })),
      },
      intakeUploadVerificationReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          claimId,
          verdictHash: evidence.verdictHash,
          storageVersionId: 'version-1',
          computedByteSize: 42,
          computedSha256: request.sha256,
        }),
      },
      venue: { findFirst: vi.fn() },
    }
    await expect(
      recordIntakeUploadPrecheckAction({
        ...scope,
        actor,
        claimId,
        verified: {
          objectGeneration: objectIdentity.objectGeneration,
          storageVersionId: 'version-1',
          mimeType: request.mimeType,
          byteSize: 42,
          sha256: request.sha256,
        },
        evidence,
        client: client as never,
      }),
    ).resolves.toMatchObject({ replayed: true, nextAction: 'MALWARE_SCAN_PENDING' })
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

  it('limits system verification authority to prechecked work and records system lineage', async () => {
    const systemJobId = 'intake-upload-verification:job-1'
    const systemActor = {
      type: 'SYSTEM' as const,
      actorId: systemJobId,
      role: 'SYSTEM' as const,
      systemJobId,
      capability: 'intake-upload.authoritative-verify',
    }
    const reservedTx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(upload()),
        updateMany: vi.fn(),
      },
      auditLog: { create: vi.fn() },
    }
    await expect(
      claimIntakeUploadVerificationAction({
        ...scope,
        actor: systemActor,
        claimId,
        client: transactionClient(reservedTx) as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(reservedTx.intakeUpload.updateMany).not.toHaveBeenCalled()

    const prechecked = upload({ status: 'PRECHECK_PASSED', storageVersionId: 'version-1' })
    const precheckedTx = {
      intakeUpload: {
        findFirst: vi.fn().mockResolvedValue(prechecked),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue(undefined) },
    }
    await expect(
      claimIntakeUploadVerificationAction({
        ...scope,
        actor: systemActor,
        claimId,
        client: transactionClient(precheckedTx) as never,
      }),
    ).resolves.toMatchObject({ state: 'PRECHECK_PASSED', replayed: false })
    expect(precheckedTx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'SYSTEM',
        actorId: systemJobId,
        actorRole: 'SYSTEM',
        systemJobId,
        capability: 'intake-upload.authoritative-verify',
        action: 'intake-upload.authoritative-verification-claimed',
      }),
    })
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
