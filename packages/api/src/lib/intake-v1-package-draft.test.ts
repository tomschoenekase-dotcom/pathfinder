import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  candidate: vi.fn(),
  read: vi.fn(),
  finalize: vi.fn(),
  create: vi.fn(),
}))
vi.mock('./intake-v1-package-candidate', () => ({ buildIntakeV1PackageCandidate: mocks.candidate }))
vi.mock('../routers/venue-package', () => ({ createVenuePackageDraftService: mocks.create }))
vi.mock('@pathfinder/db', () => ({
  readIntakeV1PackageHandoff: mocks.read,
  finalizeIntakeV1PackageHandoffInTransaction: mocks.finalize,
}))

import {
  createIntakeV1PackageDraft,
  createIntakeV1PackageDraftForAdmin,
} from './intake-v1-package-draft'
import { venuePackagePayloadHash } from './venue-package-identity'

const payload = {
  schemaVersion: 3 as const,
  places: { create: [], update: [], delete: [] },
  knowledgeEntries: {
    create: [
      {
        itemKey: '20000000-0000-4000-8000-000000000001',
        provenance: {
          sourceType: 'PATHFINDER_INTAKE' as const,
          contentOrigin: 'HUMAN_AUTHORED' as const,
        },
        value: { title: 'Hours', category: 'INFO', content: 'Open daily.', isEnabled: true },
      },
    ],
    update: [],
    delete: [],
  },
}
const command = {
  tenantId: 'tenant',
  venueId: 'venue',
  submissionId: 'submission',
  revision: 2,
  operationId: '10000000-0000-4000-8000-000000000001',
  selectedMemberIds: ['member'],
  expectedManifestHash: 'a'.repeat(64),
  expectedCandidateHash: 'b'.repeat(64),
  expectedPayloadHash: venuePackagePayloadHash('venue', payload),
  partialAcknowledged: false,
}
const revisionRead = vi.fn()
const db = { intakeV1SubmissionRevision: { findFirst: revisionRead } }
const request = () => ({ db: db as never, actorId: 'admin', command })
const candidate = () => ({
  revisionId: 'revision',
  manifestHash: command.expectedManifestHash,
  candidateHash: command.expectedCandidateHash,
  payloadHash: command.expectedPayloadHash,
  ready: true,
  payload,
  selectedMemberIds: ['member'],
  remainingMemberIds: [],
})
const finalized = () => ({
  tx: db,
  packageId: 'package',
  tenantId: 'tenant',
  venueId: 'venue',
  createdBy: 'admin',
  status: 'DRAFT',
  replayed: false,
  preview: { report: { semanticDuplicateScan: { status: 'COMPLETE' } } },
})

describe('V1 canonical package draft orchestration', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    revisionRead.mockResolvedValue({ id: 'revision', manifestHash: command.expectedManifestHash })
    mocks.read.mockResolvedValue(null)
    mocks.candidate.mockResolvedValue(candidate())
    mocks.finalize.mockResolvedValue({ handoff: { id: 'handoff' }, replayed: false })
    mocks.create.mockImplementation(async (input) => ({
      attachment: await input.finalizer(finalized()),
      value: { id: 'package' },
    }))
  })

  it('refuses machine creation without transaction-bound authority', async () => {
    await expect(
      createIntakeV1PackageDraft({
        ...request(),
        actor: {
          type: 'AGENT',
          actorId: 'agent',
          role: 'AGENT',
          agentIdentityId: 'agent',
          agentRunId: 'run',
          workerId: 'worker',
          credentialId: 'credential',
          capability: 'packages:draft',
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('checks exact machine authority in the finalizer before attaching the receipt', async () => {
    const authorizeFinalization = vi.fn().mockRejectedValue(new Error('grant unavailable'))
    mocks.create.mockImplementation(async (input) =>
      input.finalizer({ ...finalized(), createdBy: 'agent' }),
    )
    await expect(
      createIntakeV1PackageDraft({
        db: db as never,
        command,
        actor: {
          type: 'AGENT',
          actorId: 'agent',
          role: 'AGENT',
          agentIdentityId: 'agent',
          agentRunId: 'run',
          workerId: 'worker',
          credentialId: 'credential',
          capability: 'packages:draft',
        },
        authorizeFinalization,
      }),
    ).rejects.toThrow('grant unavailable')
    expect(authorizeFinalization).toHaveBeenCalledWith(
      expect.objectContaining({ tx: db, packageId: 'package' }),
      {
        command,
        revisionId: 'revision',
        selectedMemberIds: ['member'],
      },
    )
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('requires acknowledgement for omissions already recorded in the submitted revision', async () => {
    mocks.candidate.mockResolvedValue({ ...candidate(), submissionOmissionCount: 1 })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('reports serializable contention as a recoverable conflict', async () => {
    mocks.create.mockRejectedValue({ code: 'P2034' })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('revalidates exact sources in the canonical draft transaction and attaches one receipt', async () => {
    await expect(createIntakeV1PackageDraftForAdmin(request())).resolves.toMatchObject({
      value: { id: 'package' },
    })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        isolationLevel: 'Serializable',
        input: { venueId: 'venue', draftKey: command.operationId, payload },
      }),
    )
    expect(mocks.candidate).toHaveBeenCalledTimes(2)
    expect(mocks.finalize).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        revisionId: 'revision',
        packageDraftId: 'package',
        candidateHash: command.expectedCandidateHash,
        payloadHash: command.expectedPayloadHash,
      }),
    )
  })

  it('rejects changed candidate or unacknowledged exclusions before package work', async () => {
    mocks.candidate.mockResolvedValueOnce({ ...candidate(), candidateHash: 'c'.repeat(64) })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    mocks.candidate.mockResolvedValueOnce({ ...candidate(), remainingMemberIds: ['waiting'] })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects a source change during finalization without attaching a receipt', async () => {
    mocks.candidate
      .mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce({ ...candidate(), candidateHash: 'd'.repeat(64) })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(mocks.finalize).not.toHaveBeenCalled()
  })

  it('recovers historical exact replay without reinterpreting changed review sources', async () => {
    mocks.read.mockResolvedValue({
      revisionId: 'revision',
      packageDraftId: 'package',
      manifestHash: command.expectedManifestHash,
      candidateHash: command.expectedCandidateHash,
      payloadHash: command.expectedPayloadHash,
      createdBy: 'admin',
      partialAcknowledged: false,
      selectedMemberIds: ['member'],
      packageDraft: { payload, status: 'APPLIED' },
    })
    mocks.create.mockImplementation(async (input) => ({
      attachment: await input.finalizer({ ...finalized(), replayed: true, status: 'APPLIED' }),
    }))
    await createIntakeV1PackageDraftForAdmin(request())
    expect(mocks.candidate).not.toHaveBeenCalled()
    expect(mocks.finalize).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign replay identity and duplicate selection without package work', async () => {
    mocks.read.mockResolvedValue({ revisionId: 'foreign' })
    await expect(createIntakeV1PackageDraftForAdmin(request())).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      createIntakeV1PackageDraftForAdmin({
        ...request(),
        command: { ...command, selectedMemberIds: ['member', 'member'] },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
