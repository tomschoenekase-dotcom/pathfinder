import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claimMediaUploadAbortAction,
  claimMediaUploadFinalizationAction,
  completeMediaUploadAbortAction,
  createMediaIngestionProjectAction,
  queueVerifiedMediaUploadAction,
  saveMediaIngestionReviewAction,
} from './media-ingestion-actions'

const actor = { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' } as const
const revision = new Date('2026-08-11T14:30:00.000Z')
const scope = { tenantId: 'tenant_1', venueId: 'venue_1', projectId: 'project_1', actor }

function fixture() {
  const tx = {
    venue: { findFirst: vi.fn() },
    mediaIngestionProject: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  return { tx, client }
}

describe('media ingestion domain actions', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects a non-human actor before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      claimMediaUploadFinalizationAction(
        {
          ...scope,
          actor: { type: 'AGENT', id: 'agent_1', role: 'PLATFORM_ADMIN' } as never,
          uploadAttemptId: 'attempt_1',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('creates in exact venue scope and never audits context or settings payloads', async () => {
    const { tx, client } = fixture()
    tx.venue.findFirst.mockResolvedValueOnce({ id: scope.venueId })
    tx.mediaIngestionProject.create.mockResolvedValueOnce({
      id: scope.projectId,
      status: 'DRAFT',
      stage: 'setup',
    })

    await createMediaIngestionProjectAction(
      {
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        actor,
        name: 'Private media archive',
        context: 'raw private context',
        mode: 'BALANCED',
        settings: {
          transcribeAudio: true,
          preserveVerbatimText: true,
          detectDuplicates: true,
          requireEveryImage: true,
          videoSecondsPerSample: 8,
        },
      },
      client as never,
    )

    expect(tx.venue.findFirst).toHaveBeenCalledWith({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { id: true },
    })
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('raw private context')
    expect(audit).not.toContain('Private media archive')
  })

  it('validates create fields before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      createMediaIngestionProjectAction(
        {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          actor,
          name: 'x'.repeat(161),
          context: '',
          mode: 'BALANCED',
          settings: {
            transcribeAudio: true,
            preserveVerbatimText: true,
            detectDuplicates: true,
            requireEveryImage: true,
            videoSecondsPerSample: 8,
          },
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects non-JSON review payloads before opening a transaction', async () => {
    const { client } = fixture()
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    await expect(
      saveMediaIngestionReviewAction(
        {
          ...scope,
          reviewGeneration: null,
          expectedUpdatedAt: revision,
          questions: cyclic,
          findings: [],
          draftJson: {},
          status: 'NEEDS_INPUT',
          stage: 'questions',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects inconsistent review status and stage pairs before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      saveMediaIngestionReviewAction(
        {
          ...scope,
          reviewGeneration: null,
          expectedUpdatedAt: revision,
          questions: [],
          findings: [],
          draftJson: {},
          status: 'READY_FOR_REVIEW',
          stage: 'questions' as never,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('claims finalization through an exact tenant, venue, attempt, and revision CAS', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'UPLOADING',
      stage: 'upload',
      uploadAttemptId: 'attempt_1',
      uploadStartedAt: revision,
      updatedAt: revision,
    })
    tx.mediaIngestionProject.updateMany.mockResolvedValueOnce({ count: 1 })

    await claimMediaUploadFinalizationAction(
      { ...scope, uploadAttemptId: 'attempt_1' },
      client as never,
    )

    expect(tx.mediaIngestionProject.updateMany).toHaveBeenCalledWith({
      where: {
        id: scope.projectId,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: 'UPLOADING',
        stage: 'upload',
        uploadAttemptId: 'attempt_1',
        updatedAt: revision,
      },
      data: { stage: 'finalizing', error: null },
    })
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
  })

  it('fails a finalization CAS collision closed without audit', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'UPLOADING',
      stage: 'upload',
      uploadAttemptId: 'attempt_1',
      uploadStartedAt: revision,
      updatedAt: revision,
    })
    tx.mediaIngestionProject.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(
      claimMediaUploadFinalizationAction(
        { ...scope, uploadAttemptId: 'attempt_1' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('replays only a byte-identical queued upload and does not duplicate audit', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'QUEUED',
      stage: 'inventory',
      sourceBytes: 123n,
      uploadAttemptId: 'attempt_1',
      updatedAt: revision,
    })
    await expect(
      queueVerifiedMediaUploadAction(
        { ...scope, uploadAttemptId: 'attempt_1', verifiedBytes: 123 },
        client as never,
      ),
    ).resolves.toMatchObject({ replayed: true, state: 'QUEUED' })
    expect(tx.mediaIngestionProject.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects a queued replay with different verified bytes', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'QUEUED',
      stage: 'inventory',
      sourceBytes: 122n,
      uploadAttemptId: 'attempt_1',
      updatedAt: revision,
    })
    await expect(
      queueVerifiedMediaUploadAction(
        { ...scope, uploadAttemptId: 'attempt_1', verifiedBytes: 123 },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' })
  })

  it('does not resume an abort when the expected provider identity changed', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'UPLOADING',
      stage: 'aborting',
      uploadAttemptId: 'attempt_1',
      uploadStartedAt: revision,
      sourceObjectKey: 'object/new',
      storageUploadId: 'storage_new',
      updatedAt: revision,
    })
    await expect(
      claimMediaUploadAbortAction(
        {
          ...scope,
          uploadAttemptId: 'attempt_1',
          expectedSourceObjectKey: 'object/old',
          expectedStorageUploadId: 'storage_old',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('records abort completion and strict audit in the same transaction', async () => {
    const { tx, client } = fixture()
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'UPLOADING',
      stage: 'aborting',
      uploadAttemptId: 'attempt_1',
      updatedAt: revision,
    })
    tx.mediaIngestionProject.updateMany.mockResolvedValueOnce({ count: 1 })
    await completeMediaUploadAbortAction(
      {
        ...scope,
        uploadAttemptId: 'attempt_1',
        sourceObjectKey: 'object/key',
        storageUploadId: 'storage_1',
        auditAction: 'admin.media_ingestion.upload_aborted',
      },
      client as never,
    )
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('object/key')
    expect(audit).not.toContain('storage_1')
  })

  it('saves review through generation and revision CAS without auditing review payloads', async () => {
    const { tx, client } = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(revision.getTime())
    tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      status: 'NEEDS_INPUT',
      stage: 'questions',
      uploadAttemptId: 'attempt_1',
      sourceObjectGeneration: 'generation_1',
      updatedAt: revision,
    })
    tx.mediaIngestionProject.updateMany.mockResolvedValueOnce({ count: 1 })
    await saveMediaIngestionReviewAction(
      {
        ...scope,
        reviewGeneration: 'generation_1',
        expectedUpdatedAt: revision,
        questions: [{ answer: 'private answer' }],
        findings: [{ summary: 'private finding' }],
        draftJson: { private: 'draft' },
        status: 'READY_FOR_REVIEW',
        stage: 'review',
      },
      client as never,
    )
    expect(tx.mediaIngestionProject.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          sourceObjectGeneration: 'generation_1',
          updatedAt: revision,
        }),
      }),
    )
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('private answer')
    expect(audit).not.toContain('private finding')
    expect(audit).not.toContain('draft')
  })
})
