import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeAuditLogStrict = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@pathfinder/db', () => ({ db: {}, writeAuditLogStrict }))

import { mediaIntakeHash } from './media-intake-snapshot'
import { createMediaIntakeHandoff } from './media-intake-handoff-service'
import { validateResolutionEvidence } from './media-resolution-evidence'

const updatedAt = new Date('2026-09-07T12:00:00.000Z')
const entityObservation = {
  kind: 'entity_candidate' as const,
  statement: 'North entrance',
  evidenceChannel: 'visual' as const,
  directness: 'observed' as const,
  confidence: 'probable' as const,
  processingMethod: 'provider_video_static_1fps' as const,
  locator: { type: 'video_interval' as const, startSeconds: 1, endSeconds: 2 },
}
const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  projectId: 'project-1',
  requestId: '11111111-1111-4111-8111-111111111111',
  sourceGeneration: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: updatedAt.toISOString(),
  bindings: [
    {
      kind: 'knowledge' as const,
      itemIndex: 0,
      itemHash: mediaIntakeHash({
        title: 'Entrance',
        category: 'arrival',
        content: 'Use the north entrance.',
        isEnabled: true,
      }),
      sourceIds: ['source-1'],
    },
  ],
  rationale: 'Reviewed against the uploaded walkthrough.',
}

function fixture() {
  const finding = {
    sourceId: 'source-1',
    filename: 'walkthrough.mp4',
    mediaType: 'VIDEO',
    summary: 'North entrance is shown.',
    uncertainties: [],
    videoAnalysisMethod: 'GOOGLE_STATIC_VIDEO_1FPS',
    sourceObservations: [entityObservation],
    review: {
      summary: 'North entrance is shown.',
      uncertainties: [],
      note: 'Confirmed for draft review.',
      reviewedBy: 'admin-1',
      reviewedAt: updatedAt.toISOString(),
    },
  }
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(
      async (): Promise<Array<Record<string, unknown>>> => [{ id: input.projectId }],
    ),
    intakeRun: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'run-1',
        ...data,
      })),
    },
    mediaIngestionProject: {
      findFirst: vi.fn(async () => ({
        id: input.projectId,
        name: 'Walkthrough',
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        updatedAt,
        sourceObjectGeneration: input.sourceGeneration,
        uploadAttemptId: '55555555-5555-4555-8555-555555555555',
        draftJson: {
          schemaVersion: 1,
          places: [],
          knowledgeEntries: [
            {
              title: 'Entrance',
              category: 'arrival',
              content: 'Use the north entrance.',
              isEnabled: true,
            },
          ],
        },
        findings: [finding],
        questions: [{ id: 'q-1', question: 'Which entrance?', answer: 'North' }],
        assets: [
          {
            id: 'asset-1',
            sourceId: 'source-1',
            filename: 'walkthrough.mp4',
            mediaType: 'VIDEO',
            status: 'COMPLETE',
            sha256: 'a'.repeat(64),
          },
        ],
      })),
    },
    intakeEvidenceRecord: { createMany: vi.fn(async () => ({ count: 2 })) },
    intakeRunEvent: { createMany: vi.fn(async () => ({ count: 2 })) },
    auditLog: { create: vi.fn() },
  }
  return {
    tx,
    client: {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    },
  }
}

describe('reviewed media intake handoff service', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates only an awaiting-review proposal with a full snapshot anchor and source evidence', async () => {
    const { tx, client } = fixture()
    await expect(
      createMediaIntakeHandoff({ db: client as never, input, actorId: 'admin-1' }),
    ).resolves.toEqual({ runId: 'run-1', status: 'AWAITING_REVIEW', replayed: false })
    expect(tx.intakeRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          status: 'AWAITING_REVIEW',
          requestedByType: 'HUMAN',
        }),
      }),
    )
    const evidenceData = (tx.intakeEvidenceRecord.createMany as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].data
    expect(evidenceData).toHaveLength(2)
    expect(evidenceData[0]).toMatchObject({
      locator: 'media-project-review:snapshot:v1',
      confidence: 1,
    })
    expect(writeAuditLogStrict).toHaveBeenCalledOnce()
  })

  it('freezes the latest scoped identity review and representative binding', async () => {
    const { tx, client } = fixture()
    const identityReviewId = '44444444-4444-4444-8444-444444444444'
    const scope = {
      tenantId: input.tenantId,
      projectId: input.projectId,
      uploadAttemptId: '55555555-5555-4555-8555-555555555555',
    }
    const candidates = [
      {
        candidateId: 'north-entrance',
        label: 'North entrance',
        kind: 'entrance',
        identifiers: [],
        contextKeys: [],
        evidence: [
          {
            ...scope,
            sourceId: 'source-1',
            sourceSha256: 'a'.repeat(64),
            observationIndex: 0,
            observationSha256: mediaIntakeHash(entityObservation),
          },
        ],
      },
    ]
    const state = { version: 1 as const, scope, candidates, decisions: [] }
    const project = await tx.mediaIngestionProject.findFirst()
    const { evidenceSnapshot, evidenceSnapshotHash } = validateResolutionEvidence({
      scope,
      sourceGeneration: input.sourceGeneration,
      candidates,
      findings: project!.findings,
      assets: project!.assets,
    })
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: input.projectId }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: identityReviewId,
          revision: 1,
          state,
          evidenceSnapshotHash,
          evidenceSnapshot,
        },
      ])

    await createMediaIntakeHandoff({
      db: client as never,
      actorId: 'admin-1',
      input: {
        ...input,
        identityReviewId,
        bindings: [
          {
            ...input.bindings[0]!,
            entityRepresentativeId: 'north-entrance',
          },
        ],
      },
    })

    expect(tx.intakeRun.create.mock.calls[0]![0].data.structuredBootstrap).toMatchObject({
      identityReview: {
        id: identityReviewId,
        revision: 1,
        evidenceSnapshotHash,
      },
      bindings: [{ entityRepresentativeId: 'north-entrance', sourceIds: ['source-1'] }],
    })
  })

  it('replays before reading a media project, even after the project changes later', async () => {
    const created = fixture()
    await createMediaIntakeHandoff({ db: created.client as never, input, actorId: 'admin-1' })
    const storedSnapshot = created.tx.intakeRun.create.mock.calls[0]![0].data.structuredBootstrap
    const storedEvidence = (
      created.tx.intakeEvidenceRecord.createMany as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0].data.map((evidence: Record<string, unknown>) => ({
      locator: evidence.locator,
      normalizedHash: evidence.normalizedHash,
      confidence: 1,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
    }))
    const { tx, client } = fixture()
    ;(tx.intakeRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'run-existing',
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'COMPLETE',
      submissionRequestId: input.requestId,
      submissionInputHash: mediaIntakeHash({ input, actorId: 'admin-1' }),
      requestedBy: 'admin-1',
      requestedByType: 'HUMAN',
      structuredBootstrap: storedSnapshot,
      evidence: storedEvidence,
    })
    await expect(
      createMediaIntakeHandoff({ db: client as never, input, actorId: 'admin-1' }),
    ).resolves.toEqual({ runId: 'run-existing', status: 'COMPLETE', replayed: true })
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.mediaIngestionProject.findFirst).not.toHaveBeenCalled()
  })

  it('rejects stale review state and incomplete bound evidence', async () => {
    const stale = fixture()
    stale.tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      ...(await stale.tx.mediaIngestionProject.findFirst()),
      updatedAt: new Date('2026-09-07T12:01:00.000Z'),
    })
    await expect(
      createMediaIntakeHandoff({ db: stale.client as never, input, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const incomplete = fixture()
    const project = await incomplete.tx.mediaIngestionProject.findFirst()
    incomplete.tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      ...project,
      assets: project!.assets.map((asset) => ({ ...asset, status: 'FAILED' })),
    })
    await expect(
      createMediaIntakeHandoff({ db: incomplete.client as never, input, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })
  })

  it('rejects duplicate source identities and tampered immutable replay evidence', async () => {
    const duplicate = fixture()
    const project = await duplicate.tx.mediaIngestionProject.findFirst()
    duplicate.tx.mediaIngestionProject.findFirst.mockResolvedValueOnce({
      ...project,
      findings: [...project!.findings, project!.findings[0]!],
    })
    await expect(
      createMediaIntakeHandoff({ db: duplicate.client as never, input, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_REVIEW' })

    const created = fixture()
    await createMediaIntakeHandoff({ db: created.client as never, input, actorId: 'admin-1' })
    const replay = fixture()
    ;(replay.tx.intakeRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'run-existing',
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'COMPLETE',
      submissionRequestId: input.requestId,
      submissionInputHash: mediaIntakeHash({ input, actorId: 'admin-1' }),
      requestedBy: 'admin-1',
      requestedByType: 'HUMAN',
      structuredBootstrap: created.tx.intakeRun.create.mock.calls[0]![0].data.structuredBootstrap,
      evidence: [
        {
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          locator: 'media-project-review:snapshot:v1',
          normalizedHash: 'f'.repeat(64),
          confidence: 1,
        },
      ],
    })
    await expect(
      createMediaIntakeHandoff({ db: replay.client as never, input, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('replays one frozen review across distinct client request IDs', async () => {
    const created = fixture()
    await createMediaIntakeHandoff({ db: created.client as never, input, actorId: 'admin-1' })
    const storedSnapshot = created.tx.intakeRun.create.mock.calls[0]![0].data.structuredBootstrap
    const storedEvidence = (
      created.tx.intakeEvidenceRecord.createMany as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0].data.map((evidence: Record<string, unknown>) => ({
      locator: evidence.locator,
      normalizedHash: evidence.normalizedHash,
      confidence: 1,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
    }))
    const retry = fixture()
    ;(retry.tx.intakeRun.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'run-original',
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        status: 'AWAITING_REVIEW',
        requestedBy: 'admin-1',
        requestedByType: 'HUMAN',
        submissionRequestId: input.requestId,
        submissionInputHash: mediaIntakeHash({ input, actorId: 'admin-1' }),
        structuredBootstrap: storedSnapshot,
        evidence: storedEvidence,
      })
    await expect(
      createMediaIntakeHandoff({
        db: retry.client as never,
        input: { ...input, requestId: '33333333-3333-4333-8333-333333333333' },
        actorId: 'admin-1',
      }),
    ).resolves.toEqual({ runId: 'run-original', status: 'AWAITING_REVIEW', replayed: true })
    expect(retry.tx.intakeRun.create).not.toHaveBeenCalled()
  })
})
