import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createMediaTemporalClarification,
  createMediaTemporalReceiptClarification,
} from './media-temporal-clarification'
import { mediaIntakeHash } from './media-intake-snapshot'

const { ask, validate, build, validateReceipt, receiptInput } = vi.hoisted(() => ({
  ask: vi.fn(),
  validate: vi.fn(),
  build: vi.fn(),
  validateReceipt: vi.fn(),
  receiptInput: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({ db: {}, askAgentQuestionAction: ask }))
vi.mock('./media-intake-candidate', () => ({ buildReviewedMediaIntakeCandidate: build }))
vi.mock('./media-intake-snapshot', async (original) => ({
  ...(await original<typeof import('./media-intake-snapshot')>()),
  validateMediaIntakeSnapshot: validate,
}))
vi.mock('./media-temporal-review-receipt', () => ({
  validateMediaTemporalReviewSnapshot: validateReceipt,
  mediaTemporalReceiptInput: receiptInput,
}))

function fixture() {
  vi.clearAllMocks()
  const claims = ['Open at 9', 'Open at 11'].map((value, index) => ({
    claimId: `claim-${index}`,
    targetKey: 'entrance:hours',
    targetItemHash: 'a'.repeat(64),
    claimType: 'STABLE_FACT' as const,
    value,
    valueHash: createHash('sha256').update(value).digest('hex'),
    authority: 'AUTHORIZED_STAFF' as const,
    consequential: true,
    source: {
      sourceId: 'poster',
      sourceSha256: 'b'.repeat(64),
      sourceVersion: 'upload',
      capturedAt: null,
      observationIndex: 0,
      observationSha256: 'c'.repeat(64),
    },
  }))
  const snapshot = {
    temporalReview: {
      claims,
      evaluatedAt: '2026-09-07T09:00:00.000Z',
      reconciliationHash: 'd'.repeat(64),
    },
  }
  validate.mockReturnValue(snapshot)
  ask.mockResolvedValue({ question: { id: 'question' }, replayed: false })
  const client = {
    intakeRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run', structuredBootstrap: snapshot }),
    },
    agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'content-agent' }) },
  }
  const input = {
    tenantId: 'tenant',
    venueId: 'venue',
    runId: 'run',
    agentIdentityId: 'content-agent',
    targetKey: 'entrance:hours',
    expectedSnapshotHash: mediaIntakeHash(snapshot),
  }
  return { client, input, snapshot }
}

describe('frozen media temporal clarification', () => {
  it('creates only a local evidence-bound question with deterministic replay identity', async () => {
    const { client, input } = fixture()
    const result = await createMediaTemporalClarification({ client: client as never, input })
    expect(result).toMatchObject({
      blockerScope: 'LOCAL',
      sourceAmendmentRequired: true,
      publicationTriggered: false,
    })
    expect(build).toHaveBeenCalledOnce()
    const first = ask.mock.calls[0]![0]
    expect(first).toMatchObject({
      blocking: false,
      category: 'media-temporal-clarification',
      callbackMetadata: { snapshotHash: input.expectedSnapshotHash, blockerScope: 'LOCAL' },
    })
    await createMediaTemporalClarification({ client: client as never, input: { ...input } })
    expect(ask.mock.calls[1]![0].operationId).toBe(first.operationId)
    expect(client.agentIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant',
          enabled: true,
          agentType: 'CONTENT',
          accessCapabilities: { has: 'content.draft' },
        }),
      }),
    )
  })
  it('refuses missing evidence, changed snapshot, unrelated targets and unavailable identities before any question write', async () => {
    for (const failure of ['missing', 'hash', 'target', 'identity']) {
      const { client, input } = fixture()
      if (failure === 'missing') client.intakeRun.findFirst.mockResolvedValue(null as never)
      if (failure === 'hash') input.expectedSnapshotHash = 'f'.repeat(64)
      if (failure === 'target') input.targetKey = 'unrelated'
      if (failure === 'identity') client.agentIdentity.findFirst.mockResolvedValue(null as never)
      await expect(
        createMediaTemporalClarification({ client: client as never, input }),
      ).rejects.toThrow()
      expect(ask).not.toHaveBeenCalled()
    }
  })
})

describe('compact temporal receipt clarification', () => {
  function receiptFixture() {
    const base = fixture()
    const snapshot = {
      kind: 'MEDIA_TEMPORAL_REVIEW' as const,
      version: 1 as const,
      tenantId: 'tenant',
      venueId: 'venue',
      projectId: 'project',
      sourceGeneration: '11111111-1111-4111-8111-111111111111',
      uploadAttemptId: 'upload',
      requestId: '22222222-2222-4222-8222-222222222222',
      reviewedBy: 'reviewer',
      temporalReview: base.snapshot.temporalReview,
    }
    const submitted = { exact: 'input' }
    receiptInput.mockReturnValue(submitted)
    const requestHash = mediaIntakeHash({ input: submitted, actorId: 'reviewer' })
    const snapshotHash = mediaIntakeHash(snapshot)
    validateReceipt.mockReturnValue(snapshot)
    const receipt = {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tenant',
      venueId: 'venue',
      projectId: 'project',
      sourceGeneration: snapshot.sourceGeneration,
      uploadAttemptId: 'upload',
      requestId: snapshot.requestId,
      requestHash,
      snapshotHash,
      snapshot,
      actorId: 'reviewer',
    }
    const client = {
      mediaTemporalReviewReceipt: { findFirst: vi.fn().mockResolvedValue(receipt) },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'content-agent' }) },
    }
    const input = {
      tenantId: 'tenant',
      venueId: 'venue',
      receiptId: receipt.id,
      agentIdentityId: 'content-agent',
      targetKey: 'entrance:hours',
      expectedRequestHash: requestHash,
      expectedSnapshotHash: snapshotHash,
    }
    return { client, input, receipt, snapshot }
  }

  it('creates one nonblocking local question when every retained item is held', async () => {
    const { client, input } = receiptFixture()
    const first = await createMediaTemporalReceiptClarification({
      client: client as never,
      actorId: 'founder',
      input,
    })
    const operationId = ask.mock.calls[0]![0].operationId
    await createMediaTemporalReceiptClarification({
      client: client as never,
      actorId: 'founder',
      input,
    })
    expect(first).toMatchObject({
      receiptId: input.receiptId,
      blockerScope: 'LOCAL',
      publicationTriggered: false,
      canonicalVenueChanged: false,
    })
    expect(ask.mock.calls[0]![0]).toMatchObject({
      operationId,
      blocking: false,
      category: 'media-temporal-clarification',
      callbackMetadata: {
        workflow: 'media-temporal-receipt-clarification',
        receiptId: input.receiptId,
        blockerScope: 'LOCAL',
      },
    })
    expect(ask.mock.calls[1]![0].operationId).toBe(operationId)
  })

  it.each(['requestHash', 'snapshotHash', 'reviewer', 'scope', 'target', 'identity'])(
    'rejects %s tampering before a question write',
    async (failure) => {
      const { client, input, receipt, snapshot } = receiptFixture()
      if (failure === 'requestHash') input.expectedRequestHash = 'e'.repeat(64)
      if (failure === 'snapshotHash') input.expectedSnapshotHash = 'e'.repeat(64)
      if (failure === 'reviewer') receipt.actorId = 'other-reviewer'
      if (failure === 'scope') snapshot.projectId = 'other-project'
      if (failure === 'target') input.targetKey = 'unrelated'
      if (failure === 'identity') client.agentIdentity.findFirst.mockResolvedValue(null as never)
      await expect(
        createMediaTemporalReceiptClarification({
          client: client as never,
          actorId: 'founder',
          input,
        }),
      ).rejects.toThrow()
      expect(ask).not.toHaveBeenCalled()
    },
  )
})
