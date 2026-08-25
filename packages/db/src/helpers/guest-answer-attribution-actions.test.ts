import { describe, expect, it, vi } from 'vitest'

import { buildGuestAnswerEvidenceBundle } from '@pathfinder/contracts/guest-answer-attribution-node'

import {
  recordHumanReviewedGuestAnswerAttributionAction,
  type RecordGuestAnswerAttributionInput,
} from './guest-answer-attribution-actions'

const answer = 'The museum is open today.'
const evidence = buildGuestAnswerEvidenceBundle({
  assistantResponse: answer,
  staticSystemPrompt: 'You are the venue guide.',
  dynamicSystemPrompt: 'The museum is open today.',
  routeConfigurationVersion: 'route-v1',
  sources: [
    {
      sourceId: 'venue:venue-1',
      kind: 'VENUE_PROFILE',
      label: 'Museum',
      snapshot: { name: 'Museum', hours: 'Open today' },
    },
  ],
})
const baseInput: RecordGuestAnswerAttributionInput = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  guestChatTurnId: '22222222-2222-4222-8222-222222222222',
  evaluator: {
    provider: 'human-review',
    model: 'platform-admin',
    configurationVersion: 'review-form-v1',
    promptVersion: 'claim-rubric-v1',
  },
  claims: [
    {
      start: 0,
      end: answer.length,
      text: answer,
      support: 'SUPPORTED',
      sourceIds: ['venue:venue-1'],
      rationale: 'The frozen venue profile supports the reviewed claim.',
    },
  ],
  actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
}

function makeClient(overrides: Record<string, unknown> = {}) {
  const transaction = {
    guestAnswerAttribution: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) => ({
        ...data,
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
      })),
    },
    guestChatTurn: {
      findFirst: vi.fn().mockResolvedValue({
        id: baseInput.guestChatTurnId,
        sessionId: 'session-1',
        replayMetadata: { places: [], citations: [], answerEvidence: evidence },
        assistantMessage: { content: answer },
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...overrides,
  }
  const client = {
    $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  }
  return { client, transaction }
}

describe('recordHumanReviewedGuestAnswerAttributionAction', () => {
  it('records exact claim evidence without inventing a pass threshold', async () => {
    const { client, transaction } = makeClient()
    const result = await recordHumanReviewedGuestAnswerAttributionAction(baseInput, client as never)

    expect(result.replayed).toBe(false)
    expect(result.attribution).toMatchObject({
      claimCount: 1,
      supportedCount: 1,
      unsupportedCount: 0,
      supportRate: 1,
      actorType: 'HUMAN',
      actorId: 'admin-1',
    })
    expect(result.attribution).not.toHaveProperty('passed')
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'guest-answer-attribution.recorded',
        targetType: 'GuestAnswerAttribution',
        afterState: expect.objectContaining({
          answerHash: evidence.answerHash,
          evidenceSetHash: evidence.evidenceSetHash,
        }),
      }),
    })
  })

  it('replays the exact operation and rejects drift without another write', async () => {
    const first = makeClient()
    await recordHumanReviewedGuestAnswerAttributionAction(baseInput, first.client as never)
    const created = first.transaction.guestAnswerAttribution.create.mock.results[0]?.value

    const replay = makeClient()
    replay.transaction.guestAnswerAttribution.findFirst.mockResolvedValue(await created)
    await expect(
      recordHumanReviewedGuestAnswerAttributionAction(baseInput, replay.client as never),
    ).resolves.toMatchObject({ replayed: true })
    expect(replay.transaction.guestChatTurn.findFirst).not.toHaveBeenCalled()
    expect(replay.transaction.auditLog.create).not.toHaveBeenCalled()

    await expect(
      recordHumanReviewedGuestAnswerAttributionAction(
        { ...baseInput, claims: [{ ...baseInput.claims[0]!, support: 'UNCERTAIN' }] },
        replay.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses legacy or tampered evidence before persistence', async () => {
    const legacy = makeClient()
    legacy.transaction.guestChatTurn.findFirst.mockResolvedValue({
      id: baseInput.guestChatTurnId,
      sessionId: 'session-1',
      replayMetadata: { places: [], citations: [] },
      assistantMessage: { content: answer },
    })
    await expect(
      recordHumanReviewedGuestAnswerAttributionAction(baseInput, legacy.client as never),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })

    const tampered = makeClient()
    tampered.transaction.guestChatTurn.findFirst.mockResolvedValue({
      id: baseInput.guestChatTurnId,
      sessionId: 'session-1',
      replayMetadata: { places: [], citations: [], answerEvidence: evidence },
      assistantMessage: { content: 'Changed after generation.' },
    })
    await expect(
      recordHumanReviewedGuestAnswerAttributionAction(baseInput, tampered.client as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tampered.transaction.guestAnswerAttribution.create).not.toHaveBeenCalled()
  })
})
