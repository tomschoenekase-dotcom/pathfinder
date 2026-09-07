import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMediaTemporalClarification } from './media-temporal-clarification'
import { mediaIntakeHash } from './media-intake-snapshot'

const { ask, validate, build } = vi.hoisted(() => ({
  ask: vi.fn(),
  validate: vi.fn(),
  build: vi.fn(),
}))
vi.mock('@pathfinder/db', () => ({ db: {}, askAgentQuestionAction: ask }))
vi.mock('./media-intake-candidate', () => ({ buildReviewedMediaIntakeCandidate: build }))
vi.mock('./media-intake-snapshot', async (original) => ({
  ...(await original<typeof import('./media-intake-snapshot')>()),
  validateMediaIntakeSnapshot: validate,
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
