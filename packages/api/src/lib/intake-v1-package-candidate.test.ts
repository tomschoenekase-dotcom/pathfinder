import { intakeV1ManifestHash } from '@pathfinder/db'

import { describe, expect, it, vi } from 'vitest'

import { venuePackagePayloadHash } from './venue-package-identity'
import {
  buildIntakeV1PackageCandidate,
  IntakeV1PackageCandidateError,
  type IntakeV1PackageCandidateDependencies,
} from './intake-v1-package-candidate'

const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  submissionId: 'submission-a',
  revision: 2,
}

function member(id: string, ordinal: number, overrides: Record<string, unknown> = {}) {
  const immutableHash = String(ordinal + 1).repeat(64)
  return {
    id,
    ordinal,
    kind: 'INTAKE_RUN',
    immutableHash,
    intakeRunId: `run-${id}`,
    intakeUploadId: null,
    intakeRun: {
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      displayName: `Source ${id}`,
      submissionInputHash: immutableHash,
    },
    intakeUpload: null,
    processingDispatch: { kind: 'REVIEW_READY', status: 'COMPLETED', sourceHash: immutableHash },
    ...overrides,
  }
}

function database(members: unknown[]) {
  const manifest = {
    schemaVersion: 1,
    members: (members as ReturnType<typeof member>[]).map((item) => ({
      kind: item.kind,
      id: item.kind === 'INTAKE_RUN' ? item.intakeRunId : item.intakeUploadId,
      immutableHash: item.immutableHash,
    })),
    criticalMissing: [],
  }
  return {
    intakeV1SubmissionRevision: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'revision-a',
        revision: 2,
        manifest,
        manifestHash: intakeV1ManifestHash(manifest),
        members,
      }),
    },
  }
}

function dependencies(
  payloadForRun: (runId: string) => unknown = (runId) => ({
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: {
      create: [
        {
          itemKey:
            runId === 'run-first'
              ? '11111111-1111-5111-8111-111111111111'
              : '22222222-2222-5222-8222-222222222222',
          provenance: { sourceType: 'PATHFINDER_INTAKE', contentOrigin: 'HUMAN_AUTHORED' },
          value: { title: runId, category: 'INFO', content: 'Reviewed content', isEnabled: true },
        },
      ],
      update: [],
      delete: [],
    },
  }),
): IntakeV1PackageCandidateDependencies {
  return {
    buildRunCandidate: vi.fn(async ({ runId }) => ({
      runId,
      sourceKind: 'STRUCTURED_BOOTSTRAP' as const,
      status: 'AWAITING_REVIEW',
      ready: true,
      payload: payloadForRun(runId) as never,
      candidateHash: `${runId}-fragment`,
      issues: [],
      summary: { candidateCount: 1, issueCount: 0 },
      autoApprove: false as const,
      autoApply: false as const,
      published: false as const,
    })),
  }
}

describe('V1 aggregate venue-package candidate', () => {
  it('combines only the explicit selection in revision order and binds lineage separately from payload', async () => {
    const deps = dependencies()
    const db = database([member('first', 0), member('second', 1)])
    const result = await buildIntakeV1PackageCandidate(
      { db: db as never, ...scope, selectedMemberIds: ['second'] },
      deps,
    )

    expect(result).toMatchObject({
      ready: true,
      selectedMemberIds: ['second'],
      remainingMemberIds: ['first'],
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    expect(result.payload?.knowledgeEntries.create).toHaveLength(1)
    expect(result.payloadHash).toBe(venuePackagePayloadHash(scope.venueId, result.payload!))
    expect(result.candidateHash).not.toBe(result.payloadHash)
    expect(deps.buildRunCandidate).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting, held, website, upload, and unselected members explicit without a payload', async () => {
    const db = database([
      member('waiting', 0, {
        processingDispatch: {
          kind: 'WEBSITE_RESEARCH',
          status: 'PENDING',
          sourceHash: '1'.repeat(64),
        },
      }),
      member('website', 1, {
        intakeRun: {
          sourceKind: 'WEBSITE',
          displayName: 'Website',
          submissionInputHash: '2'.repeat(64),
        },
        processingDispatch: {
          kind: 'WEBSITE_RESEARCH',
          status: 'COMPLETED',
          sourceHash: '2'.repeat(64),
        },
      }),
      member('held', 2, {
        processingDispatch: {
          kind: 'EXTRACTION_UNSUPPORTED',
          status: 'HELD',
          sourceHash: '3'.repeat(64),
        },
      }),
      member('remaining', 3),
    ])
    const result = await buildIntakeV1PackageCandidate(
      {
        db: db as never,
        ...scope,
        selectedMemberIds: ['waiting', 'website', 'held'],
      },
      dependencies(),
    )

    expect(result.ready).toBe(false)
    expect(result.payload).toBeNull()
    expect(result.members.map(({ memberId, state }) => [memberId, state])).toEqual([
      ['waiting', 'WAITING'],
      ['website', 'REVIEW_REQUIRED'],
      ['held', 'HELD'],
      ['remaining', 'REMAINING'],
    ])
  })

  it('fails closed on duplicate item keys or conflicting venue patches', async () => {
    const duplicate = {
      schemaVersion: 3,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: {
        create: [
          {
            itemKey: '33333333-3333-5333-8333-333333333333',
            provenance: { sourceType: 'PATHFINDER_INTAKE', contentOrigin: 'HUMAN_AUTHORED' },
            value: { title: 'Info', category: 'INFO', content: 'Text', isEnabled: true },
          },
        ],
        update: [],
        delete: [],
      },
    }
    const result = await buildIntakeV1PackageCandidate(
      {
        db: database([member('one', 0), member('two', 1)]) as never,
        ...scope,
        selectedMemberIds: ['one', 'two'],
      },
      dependencies(() => duplicate),
    )
    expect(result.ready).toBe(false)
    expect(result.payload).toBeNull()
    expect(result.members.at(-1)?.issues[0]?.code).toBe('AGGREGATE_PAYLOAD_INVALID')
  })

  it('rejects missing, duplicate, foreign, and oversized selections or revisions', async () => {
    await expect(
      buildIntakeV1PackageCandidate(
        { db: database([member('one', 0)]) as never, ...scope, selectedMemberIds: ['one', 'one'] },
        dependencies(),
      ),
    ).rejects.toBeInstanceOf(IntakeV1PackageCandidateError)
    await expect(
      buildIntakeV1PackageCandidate(
        { db: database([member('one', 0)]) as never, ...scope, selectedMemberIds: ['foreign'] },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      buildIntakeV1PackageCandidate(
        {
          db: database(
            Array.from({ length: 51 }, (_, index) => member(`m${index}`, index)),
          ) as never,
          ...scope,
          selectedMemberIds: ['m0'],
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

function uploadedMember() {
  const upload = {
    id: 'upload-file',
    displayName: 'Venue guide',
    intakeRunId: 'source-file',
    objectGeneration: 'generation-file',
    storageVersionId: 'version-file',
    sha256: 'a'.repeat(64),
    byteSize: 100,
    mimeType: 'text/plain',
  }
  const verification = {
    uploadId: upload.id,
    verdictHash: 'b'.repeat(64),
    computedSha256: upload.sha256,
    computedByteSize: upload.byteSize,
    objectGeneration: upload.objectGeneration,
    storageVersionId: upload.storageVersionId,
  }
  const immutableHash = intakeV1ManifestHash({ id: upload.id, receipt: verification })
  const review = {
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    sourceRunId: upload.intakeRunId,
    receiptId: 'receipt-file',
    decision: 'ACCEPTED_FOR_PROPOSAL',
    proposalRunId: 'reviewed-file',
    expectedExtractedTextHash: 'c'.repeat(64),
  }
  const receipt = {
    id: review.receiptId,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    runId: upload.intakeRunId,
    uploadId: upload.id,
    sourceObjectGeneration: upload.objectGeneration,
    sourceStorageVersionId: upload.storageVersionId,
    sourceSha256: upload.sha256,
    sourceByteSize: upload.byteSize,
    sourceMimeType: upload.mimeType,
    outcome: 'SUCCEEDED',
    extractor: 'pathfinder-utf8-document',
    extractorVersion: '1',
    extractedTextHash: 'c'.repeat(64),
    review: review as typeof review | null,
  }
  return {
    ...member('file', 0),
    kind: 'INTAKE_UPLOAD',
    intakeRunId: null,
    intakeRun: null,
    intakeUploadId: upload.id,
    immutableHash,
    intakeUpload: { ...upload, verificationReceipts: [verification] },
    processingDispatch: {
      kind: 'FILE_EXTRACTION',
      status: 'COMPLETED',
      sourceHash: immutableHash,
      intakeRunId: upload.intakeRunId,
      fileExtractionReceipt: receipt,
    },
  }
}

describe('V1 exact reviewed file bridge', () => {
  it('uses the accepted proposal adapter while preserving the original upload member', async () => {
    const item = uploadedMember()
    const deps = dependencies()
    const result = await buildIntakeV1PackageCandidate(
      { db: database([item]) as never, ...scope, selectedMemberIds: ['file'] },
      deps,
    )
    expect(result.ready).toBe(true)
    expect(result.selectedMemberIds).toEqual(['file'])
    expect(deps.buildRunCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        runId: 'reviewed-file',
        allowExistingHandoff: true,
      }),
    )
    expect(result).toMatchObject({ autoApprove: false, autoApply: false, published: false })
  })

  it('does not promote extraction without an accepted human review', async () => {
    for (const decision of [null, 'REJECTED']) {
      const item = uploadedMember()
      if (decision === null) item.processingDispatch.fileExtractionReceipt.review = null
      else item.processingDispatch.fileExtractionReceipt.review!.decision = decision
      const deps = dependencies()
      const result = await buildIntakeV1PackageCandidate(
        { db: database([item]) as never, ...scope, selectedMemberIds: ['file'] },
        deps,
      )
      expect(result.ready).toBe(false)
      expect(result.payload).toBeNull()
      expect(deps.buildRunCandidate).not.toHaveBeenCalled()
    }
  })

  it.each(['tenant', 'version', 'profile', 'review-hash', 'verification'] as const)(
    'rejects a mismatched %s before invoking the proposal adapter',
    async (mismatch) => {
      const item = uploadedMember()
      const receipt = item.processingDispatch.fileExtractionReceipt
      if (mismatch === 'tenant') receipt.tenantId = 'other-tenant'
      if (mismatch === 'version') receipt.sourceStorageVersionId = 'other-version'
      if (mismatch === 'profile') receipt.extractorVersion = '2'
      if (mismatch === 'review-hash') receipt.review!.expectedExtractedTextHash = 'd'.repeat(64)
      if (mismatch === 'verification')
        item.intakeUpload.verificationReceipts[0]!.verdictHash = 'e'.repeat(64)
      const deps = dependencies()
      const result = await buildIntakeV1PackageCandidate(
        { db: database([item]) as never, ...scope, selectedMemberIds: ['file'] },
        deps,
      )
      expect(result.ready).toBe(false)
      expect(result.payload).toBeNull()
      expect(deps.buildRunCandidate).not.toHaveBeenCalled()
    },
  )
})
