import { describe, expect, it, vi } from 'vitest'

import {
  characterCandidateArtifactFingerprint,
  decideCharacterCandidateReview,
  readCharacterCandidateReviewBrief,
  submitCharacterCandidateReviewBrief,
} from './character-candidate-reviews'

const human = { id: 'admin-1', role: 'PLATFORM_ADMIN', type: 'HUMAN' } as const
const snapshot = {
  id: 'character-1',
  version: 1,
  revision: 2,
  status: 'REVIEW',
  assetStorageReference: null,
  previewStorageReference: { objectKey: 'preview.png' },
  capabilityMetadata: { characterFactory: { spec: { status: 'candidate' } } },
}
const expectedArtifactFingerprint = characterCandidateArtifactFingerprint(snapshot)
const decisionInput = {
  briefId: 'brief-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  expectedVersion: 1,
  expectedRevision: 2,
  expectedArtifactFingerprint,
  operationId: 'operation-1',
  decision: 'ACCEPT',
  actor: human,
} as const

function client(tx: Record<string, unknown>) {
  return {
    $transaction: vi.fn(async (callback: (value: unknown) => unknown) => callback(tx)),
    characterCandidateReviewBrief: {},
    characterCandidateReviewDecision: {},
  } as never
}

describe('character candidate reviews', () => {
  it('fingerprints only exact art-bearing fields', () => {
    const first = { ...snapshot, displayName: 'One' }
    const second = { ...snapshot, displayName: 'Two', spec: {} }
    expect(characterCandidateArtifactFingerprint(first)).toBe(
      characterCandidateArtifactFingerprint(second),
    )
    expect(
      characterCandidateArtifactFingerprint({ ...snapshot, previewStorageReference: null }),
    ).not.toBe(expectedArtifactFingerprint)
  })

  it('rejects a changed historical operation replay without relocking or queuing work', async () => {
    const queryRaw = vi.fn()
    const replayTx = {
      $queryRaw: queryRaw,
      characterCandidateReviewDecision: {
        findFirst: vi.fn().mockResolvedValue({
          requestFingerprint: '0'.repeat(64),
          resultingJob: { id: 'job-1' },
        }),
      },
    }
    await expect(
      decideCharacterCandidateReview(decisionInput, client(replayTx)),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('fences a changed candidate snapshot before creating a decision', async () => {
    const create = vi.fn()
    const tx = {
      $queryRaw: vi.fn(),
      characterCandidateReviewDecision: { findFirst: vi.fn().mockResolvedValue(null), create },
      characterCandidateReviewBrief: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'brief-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          customCharacterId: 'character-1',
          candidateVersion: 1,
          candidateRevision: 2,
          artifactFingerprint: expectedArtifactFingerprint,
        }),
      },
      customCharacter: { findFirst: vi.fn().mockResolvedValue({ ...snapshot, revision: 3 }) },
    }
    await expect(decideCharacterCandidateReview(decisionInput, client(tx))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects ACCEPT when the exact candidate lacks a verified bundle', async () => {
    const create = vi.fn()
    const tx = {
      $queryRaw: vi.fn(),
      characterCandidateReviewDecision: { findFirst: vi.fn().mockResolvedValue(null), create },
      characterCandidateReviewBrief: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'brief-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          customCharacterId: 'character-1',
          candidateVersion: 1,
          candidateRevision: 2,
          artifactFingerprint: expectedArtifactFingerprint,
        }),
      },
      customCharacter: { findFirst: vi.fn().mockResolvedValue(snapshot) },
    }
    await expect(decideCharacterCandidateReview(decisionInput, client(tx))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects mismatched producer actor pairs before persistence', async () => {
    const transaction = vi.fn(async (callback: (value: unknown) => unknown) => callback({}))
    const dbClient = {
      $transaction: transaction,
      characterCandidateReviewBrief: {},
      characterCandidateReviewDecision: {},
    } as never
    await expect(
      submitCharacterCandidateReviewBrief(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          characterId: 'character-1',
          brief: 'Show this neutral candidate.',
          rationale: 'Producer-reported rationale.',
          sourceProvenance: 'IMPORTED_FIXTURE',
          actor: { id: 'agent-1', role: 'PLATFORM_ADMIN', type: 'AGENT' },
        },
        dbClient,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('marks an archived exact-art row non-current in the bounded read receipt', async () => {
    const result = await readCharacterCandidateReviewBrief(
      { tenantId: 'tenant-1', venueId: 'venue-1', briefId: 'brief-1' },
      {
        characterCandidateReviewBrief: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'brief-1',
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            customCharacterId: 'character-1',
            candidateVersion: 1,
            candidateRevision: 2,
            artifactFingerprint: expectedArtifactFingerprint,
            brief: 'Review this candidate.',
            rationale: 'Producer-reported rationale.',
            sourceProvenance: 'IMPORTED_FIXTURE',
            createdBy: 'agent-1',
            createdAt: new Date('2026-09-08T00:00:00Z'),
            decision: null,
          }),
        },
        customCharacter: {
          findFirst: vi.fn().mockResolvedValue({
            ...snapshot,
            displayName: 'Neutral owl',
            status: 'ARCHIVED',
          }),
        },
      } as never,
    )

    expect(result).toMatchObject({
      characterId: 'character-1',
      displayName: 'Neutral owl',
      version: 1,
      revision: 2,
      provenance: 'IMPORTED_FIXTURE',
      current: false,
    })
  })
})
