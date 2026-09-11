import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sources: vi.fn() }))
vi.mock('./support-fulfillment-sources', () => ({ readSupportFulfillmentSources: mocks.sources }))

import {
  finalizeSupportProposalResolutionFulfillment,
  readSupportProposalResolutionEvidence,
  SupportProposalResolutionError,
} from './support-proposal-resolution-fulfillment'

const tenantId = 'tenant-a',
  venueId = 'venue-a',
  supportRequestId = 'request-a'
const proposalId = '00000000-0000-4000-8000-000000000001'
const replacementId = '00000000-0000-4000-8000-000000000002'
const source = {
  proposalId,
  sourceProposalId: proposalId,
  sourceRequestVersion: 2,
  replacementOfProposalId: null,
  status: 'REJECTED',
  packageHandoffVenuePackageId: null,
  operationalUpdateHandoffId: null,
}
const reviewedAt = new Date('2026-09-10T15:00:00.000Z')
const updatedAt = new Date('2026-09-10T15:00:01.000Z')
const createdAt = new Date('2026-09-10T15:00:02.000Z')
const message = {
  id: 'message-a',
  body: 'Please keep the current guidance.',
  createdAt: new Date('2026-09-10T14:00:00.000Z'),
  requestVersion: 2,
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const emptyHandoffs = {
  packageHandoff: null,
  operationalUpdateHandoff: null,
  universalContentHandoff: null,
  legacyContentAdoption: null,
}

function decline(overrides: Record<string, unknown> = {}) {
  const reviewNote = 'Already correct.'
  return {
    id: '00000000-0000-4000-8000-000000000010',
    proposalId,
    sourceProposalId: proposalId,
    supportRequestId,
    supportRequestVersion: 2,
    proposalUpdatedAt: reviewedAt,
    reviewedProposalUpdatedAt: updatedAt,
    reviewedAt,
    reviewNoteHash: sha(reviewNote),
    sourceEvidence: [
      {
        sourceId: `support-message:${message.id}`,
        locator: `support-request:${supportRequestId}`,
        capturedAt: message.createdAt.toISOString(),
        excerptHash: sha(message.body),
      },
    ],
    createdBy: 'reviewer-a',
    createdAt,
    proposal: {
      id: proposalId,
      proposedChange: 'Add free parking.',
      status: 'REJECTED',
      updatedAt,
      reviewedAt,
      reviewerId: 'reviewer-a',
      reviewNote,
      evidenceMessageIds: [message.id],
      ...emptyHandoffs,
    },
    ...overrides,
  }
}

function replacement(overrides: Record<string, unknown> = {}) {
  const id = '00000000-0000-4000-8000-000000000020'
  const answer = 'Replace it.'
  return {
    id,
    proposalId,
    replacementProposalId: replacementId,
    proposalUpdatedAt: reviewedAt,
    questionId: 'question-a',
    questionUpdatedAt: updatedAt,
    answeredAt: reviewedAt,
    answerHash: sha(answer),
    createdBy: 'reviewer-a',
    createdAt,
    proposal: {
      id: proposalId,
      proposedChange: 'Add free parking.',
      status: 'REJECTED',
      updatedAt,
      reviewedAt,
      reviewerId: 'reviewer-a',
      reviewNote: `Resolved by semantic conflict decision ${id}.`,
      evidenceMessageIds: [message.id],
      ...emptyHandoffs,
    },
    question: { status: 'ANSWERED', updatedAt, answeredAt: reviewedAt, answer },
    ...overrides,
  }
}

function client(
  input: {
    declines?: unknown[]
    replacements?: unknown[]
    originals?: unknown[]
    messages?: unknown[]
  } = {},
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: proposalId }]),
    semanticReviewedDecline: { findMany: vi.fn().mockResolvedValue(input.declines ?? [decline()]) },
    semanticConflictResolution: { findMany: vi.fn().mockResolvedValue(input.replacements ?? []) },
    knowledgeChangeProposal: {
      findMany: vi.fn().mockResolvedValue(
        input.originals ?? [
          {
            id: proposalId,
            evidenceMessageIds: [message.id],
            supportRequestId,
            supportRequestVersion: 2,
          },
        ],
      ),
    },
    supportMessage: { findMany: vi.fn().mockResolvedValue(input.messages ?? [message]) },
  }
}

async function read(db = client()) {
  return readSupportProposalResolutionEvidence(db as never, { tenantId, venueId, supportRequestId })
}

describe('support proposal resolution fulfillment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T16:00:00.000Z'))
    mocks.sources.mockReset().mockResolvedValue([source])
  })
  afterEach(() => vi.useRealTimers())

  it('returns a fresh reviewed decline with a stable verification clock and digest', async () => {
    const evidence = await read()
    expect(mocks.sources).toHaveBeenCalledTimes(2)
    expect(evidence).toMatchObject({
      verifiedAt: '2026-09-10T16:00:00.000Z',
      declines: [
        {
          proposalId,
          sourceProposalId: proposalId,
          sourceRequestVersion: 2,
          reviewNoteHash: sha('Already correct.'),
        },
      ],
      replacements: [],
    })
    const first = finalizeSupportProposalResolutionFulfillment(evidence, [])
    const second = finalizeSupportProposalResolutionFulfillment(evidence, [])
    expect(first).toEqual(second)
    expect(first.declines[0]).toBeDefined()
  })

  it.each([
    ['post-review timestamp', { reviewedProposalUpdatedAt: new Date(updatedAt.getTime() + 1) }],
    ['review note hash', { reviewNoteHash: 'a'.repeat(64) }],
    ['reviewer', { createdBy: 'other' }],
    [
      'status',
      { proposal: decline().proposal && { ...decline().proposal, status: 'PENDING_REVIEW' } },
    ],
    [
      'competing content',
      { proposal: { ...decline().proposal, packageHandoff: { id: 'handoff' } } },
    ],
  ])('rejects stale %s evidence', async (_name, overrides) => {
    await expect(read(client({ declines: [decline(overrides)] }))).rejects.toBeInstanceOf(
      SupportProposalResolutionError,
    )
  })

  it('rejects wrong scope/version/source rebinding and changed message body', async () => {
    await expect(
      read(client({ declines: [decline({ supportRequestId: 'other' })] })),
    ).rejects.toThrow('Decline source identity is stale')
    await expect(
      read(client({ declines: [decline({ supportRequestVersion: 3 })] })),
    ).rejects.toThrow('Decline source identity is stale')
    await expect(
      read(
        client({
          originals: [
            {
              id: proposalId,
              evidenceMessageIds: [message.id],
              supportRequestId: 'other',
              supportRequestVersion: 2,
            },
          ],
        }),
      ),
    ).rejects.toThrow('Decline source identity is stale')
    await expect(read(client({ messages: [{ ...message, body: 'changed' }] }))).rejects.toThrow(
      'source evidence changed',
    )
  })

  it('rejects source changes across the lock boundary', async () => {
    mocks.sources
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([{ ...source, sourceRequestVersion: 3 }])
    await expect(read()).rejects.toThrow('sources changed while locking')
  })

  it('returns empty evidence without querying receipt delegates', async () => {
    mocks.sources.mockResolvedValue([])
    const db = client({ declines: [], replacements: [], originals: [], messages: [] })
    await expect(read(db)).resolves.toMatchObject({ declines: [], replacements: [] })
    expect(db.semanticReviewedDecline.findMany).not.toHaveBeenCalled()
  })

  it('validates one-hop answered replacement evidence and finalization', async () => {
    const replacementSource = {
      ...source,
      proposalId: replacementId,
      sourceProposalId: proposalId,
      replacementOfProposalId: proposalId,
      status: 'APPROVED',
    }
    mocks.sources.mockResolvedValue([source, replacementSource])
    const evidence = await read(client({ declines: [], replacements: [replacement()] }))
    expect(evidence.replacements).toMatchObject([
      { proposalId, replacementProposalId: replacementId, answerHash: sha('Replace it.') },
    ])
    expect(
      finalizeSupportProposalResolutionFulfillment(evidence, [
        { proposalId: replacementId, kind: 'CONTENT' },
      ]).replacements[0]?.replacementFulfillmentKind,
    ).toBe('CONTENT')
    await expect(
      Promise.resolve().then(() => finalizeSupportProposalResolutionFulfillment(evidence, [])),
    ).rejects.toThrow('no verified fulfillment')
    expect(() =>
      finalizeSupportProposalResolutionFulfillment(evidence, [
        { proposalId: replacementId, kind: 'DECLINE' },
      ]),
    ).not.toThrow()
  })

  it('rejects wrong replacement lineage, pending decision evidence, and conflicting verified kinds', async () => {
    const replacementSource = {
      ...source,
      proposalId: replacementId,
      sourceProposalId: proposalId,
      replacementOfProposalId: proposalId,
      status: 'APPROVED',
    }
    mocks.sources.mockResolvedValue([source, replacementSource])
    await expect(
      read(
        client({
          declines: [],
          replacements: [
            replacement({ question: { ...replacement().question, status: 'PENDING' } }),
          ],
        }),
      ),
    ).rejects.toThrow('decision evidence is stale')
    mocks.sources.mockResolvedValue([
      source,
      { ...replacementSource, replacementOfProposalId: null },
    ])
    await expect(read(client({ declines: [], replacements: [replacement()] }))).rejects.toThrow(
      'lineage is inconsistent',
    )
    mocks.sources.mockResolvedValue([source, replacementSource])
    const evidence = await read(client({ declines: [], replacements: [replacement()] }))
    expect(() =>
      finalizeSupportProposalResolutionFulfillment(evidence, [
        { proposalId: replacementId, kind: 'CONTENT' },
        { proposalId: replacementId, kind: 'DECLINE' },
      ]),
    ).toThrow('competing fulfillment kinds')
  })

  it('does not query KEEP_CANONICAL as a replacement and enforces aggregate bounds', async () => {
    const db = client({
      declines: Array.from({ length: 101 }, (_, i) => decline({ id: `row-${i}` })),
      replacements: [],
    })
    await expect(read(db)).rejects.toThrow('count exceeds 100')
    expect(db.semanticConflictResolution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ outcome: 'PROPOSE_REPLACEMENT' }),
      }),
    )
  })
  it('does not impose decision exclusivity on unrelated historical content receipts', () => {
    expect(() =>
      finalizeSupportProposalResolutionFulfillment(
        { sources: [], declines: [], replacements: [], verifiedAt: updatedAt.toISOString() },
        [
          { proposalId, kind: 'CONTENT' },
          { proposalId, kind: 'PACKAGE' },
        ],
      ),
    ).not.toThrow()
  })
  it('keeps storage envelopes out of bounded human review summaries', async () => {
    const row = decline()
    const evidence = await read(
      client({
        declines: [
          {
            ...row,
            proposal: { ...row.proposal, proposedChange: '[CREATE_KNOWLEDGE]\n' + 'x'.repeat(240) },
          },
        ],
      }),
    )
    expect(evidence.declines[0]?.proposalSummary).toBe('x'.repeat(200) + '...')
  })
})
