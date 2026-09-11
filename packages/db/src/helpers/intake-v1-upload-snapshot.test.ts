import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { submitIntakeV1Action } from './intake-v1-submission-actions'

const sha256 = 'a'.repeat(64)
const generation = '50ef56b5-b9be-4ee1-a713-78a403d9e963'
const upload = {
  id: 'upload-1',
  status: 'AWAITING_REVIEW' as const,
  sha256,
  byteSize: 29,
  objectGeneration: generation,
  storageVersionId: 'storage-version-1',
  intakeRunId: 'run-from-upload-1',
}
const exactReceipt = {
  uploadId: upload.id,
  verdictHash: 'b'.repeat(64),
  computedSha256: upload.sha256,
  computedByteSize: upload.byteSize,
  objectGeneration: upload.objectGeneration,
  storageVersionId: upload.storageVersionId,
}

function clientFor(receipt: typeof exactReceipt) {
  const createSubmission = vi.fn().mockResolvedValue({
    id: 'submission-1',
    status: 'AWAITING_CANONICAL_REVIEW',
    revision: 1,
  })
  const createRevision = vi.fn().mockResolvedValue({ id: 'revision-1' })
  const createMembers = vi.fn().mockResolvedValue({ count: 1 })
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([{ id: upload.id }]),
    intakeV1Submission: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: createSubmission,
      updateMany: vi.fn(),
    },
    intakeV1SubmissionRevision: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: createRevision,
    },
    intakeV1SubmissionMember: {
      createMany: createMembers,
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'member-1',
          immutableHash: 'd'.repeat(64),
          intakeRunId: null,
          intakeUpload: { intakeRunId: upload.intakeRunId },
          intakeRun: null,
        },
      ]),
    },
    intakeV1ProcessingDispatch: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    intakeSubmissionDraft: { findMany: vi.fn().mockResolvedValue([]) },
    intakeRun: { findMany: vi.fn().mockResolvedValue([]) },
    intakeUpload: { findMany: vi.fn().mockResolvedValue([upload]) },
    intakeUploadVerificationReceipt: { findMany: vi.fn().mockResolvedValue([receipt]) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  } as unknown as NonNullable<Parameters<typeof submitIntakeV1Action>[0]['client']>
  return { client, createSubmission, createRevision, createMembers }
}

const submit = (client: NonNullable<Parameters<typeof submitIntakeV1Action>[0]['client']>) =>
  submitIntakeV1Action({
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    ownerUserId: 'owner-1',
    actorRole: 'OWNER',
    selection: {
      operationId: randomUUID(),
      partialAcknowledged: false,
      drafts: {},
      intakeRunIds: [],
      intakeUploadIds: [upload.id],
    },
    client,
  })

describe('V1 upload receipt snapshots', () => {
  it('retains an exact owned CLEAN upload snapshot as one immutable aggregate member', async () => {
    const fixture = clientFor(exactReceipt)

    await expect(submit(fixture.client)).resolves.toMatchObject({
      submissionId: 'submission-1',
      revision: 1,
      replayed: false,
    })
    expect(fixture.createMembers).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: 'INTAKE_UPLOAD',
          intakeUploadId: upload.id,
          immutableHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    })
  })

  it.each([
    ['object generation', { objectGeneration: 'ca884057-edbb-408c-9cf1-ec06e22422b5' }],
    ['SHA-256', { computedSha256: 'c'.repeat(64) }],
    ['byte size', { computedByteSize: upload.byteSize + 1 }],
    ['storage version', { storageVersionId: 'stale-storage-version' }],
  ])(
    'rejects a CLEAN receipt with stale %s before aggregate persistence',
    async (_label, change) => {
      const fixture = clientFor({ ...exactReceipt, ...change })

      await expect(submit(fixture.client)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(fixture.createSubmission).not.toHaveBeenCalled()
      expect(fixture.createRevision).not.toHaveBeenCalled()
      expect(fixture.createMembers).not.toHaveBeenCalled()
    },
  )
})
