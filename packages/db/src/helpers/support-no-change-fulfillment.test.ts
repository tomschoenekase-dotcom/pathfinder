import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashSemanticCanonicalKnowledgeTarget } from '@pathfinder/contracts'

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  snapshot: vi.fn(),
  guestRead: vi.fn(),
}))

vi.mock('./support-fulfillment-sources', () => ({
  readSupportFulfillmentSources: mocks.sources,
  SupportFulfillmentSourceError: class SupportFulfillmentSourceError extends Error {},
}))
vi.mock('./native-guest-content-read', () => ({
  resolveNativeGuestReadSnapshotAction: mocks.snapshot,
  applyNativeGuestContentRead: mocks.guestRead,
}))

import {
  readSupportNoChangeFulfillment,
  SupportNoChangeFulfillmentError,
} from './support-no-change-fulfillment'

const tenantId = 'tenant-a'
const venueId = 'venue-a'
const supportRequestId = 'request-a'
const proposalId = '00000000-0000-4000-8000-000000000001'
const now = new Date('2026-09-10T14:00:00.000Z')
const target = {
  id: 'knowledge-a',
  title: 'Quiet room',
  category: 'Visitor services',
  content: 'The quiet room is beside the gallery.',
  isEnabled: true,
  visibility: 'PUBLIC',
  humanConfirmedAt: now,
  authorship: 'HUMAN_AUTHORED',
  sourceType: 'OPERATOR',
  sourceName: 'Venue team',
  sourceUrl: null,
  contentModuleId: null,
  contentRevisionId: null,
  contentPublicationId: null,
  contentModule: null,
  contentRevision: null,
}
const message = {
  id: 'message-a',
  body: 'The quiet room is beside the gallery.',
  createdAt: new Date('2026-09-10T13:00:00.000Z'),
  requestVersion: 2,
}

function targetHash(value = target) {
  return hashSemanticCanonicalKnowledgeTarget({
    id: value.id,
    title: value.title,
    category: value.category,
    content: value.content,
    isEnabled: value.isEnabled,
    humanConfirmedAt: value.humanConfirmedAt,
    authorship: value.authorship,
    sourceType: value.sourceType,
  })
}

function sourceEvidence() {
  return [
    {
      sourceId: `support-message:${message.id}`,
      locator: `support-request:${supportRequestId}`,
      capturedAt: message.createdAt.toISOString(),
      excerptHash: createHash('sha256').update(message.body).digest('hex'),
    },
  ]
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    status: 'APPROVED',
    updatedAt: now,
    reviewerId: 'admin-a',
    reviewNote: null,
    supportRequestId,
    supportRequestVersion: 2,
    evidenceMessageIds: [message.id],
    packageHandoff: null,
    operationalUpdateHandoff: null,
    universalContentHandoff: null,
    legacyContentAdoption: null,
    ...overrides,
  }
}

function duplicate(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    proposalId,
    proposalUpdatedAt: now,
    targetKnowledgeEntryId: target.id,
    targetSnapshotHash: targetHash(),
    sourceEvidence: sourceEvidence(),
    createdAt: now,
    createdBy: 'admin-a',
    proposal: proposal(),
    ...overrides,
  }
}

function client(
  input: {
    duplicates?: unknown[]
    conflicts?: unknown[]
    targets?: unknown[]
    messages?: unknown[]
  } = {},
) {
  return {
    semanticDuplicateResolution: {
      findMany: vi.fn().mockResolvedValue(input.duplicates ?? [duplicate()]),
    },
    semanticConflictResolution: {
      findMany: vi.fn().mockResolvedValue(input.conflicts ?? []),
    },
    venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue(input.targets ?? [target]) },
    supportMessage: { findMany: vi.fn().mockResolvedValue(input.messages ?? [message]) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: target.id }]),
    knowledgeChangeProposal: { findMany: vi.fn() },
    supportRequestAuditEvent: { findUnique: vi.fn() },
    tenantFeatureFlag: { findFirst: vi.fn() },
    nativeVenueDeploymentHead: { findFirst: vi.fn() },
    nativeVenueDeploymentEvaluationEvidence: { findFirst: vi.fn() },
  }
}

describe('readSupportNoChangeFulfillment', () => {
  beforeEach(() => {
    mocks.sources.mockReset().mockResolvedValue([
      {
        proposalId,
        sourceProposalId: proposalId,
        sourceRequestVersion: 2,
        replacementOfProposalId: null,
        status: 'APPROVED',
        packageHandoffVenuePackageId: null,
        operationalUpdateHandoffId: null,
      },
    ])
    mocks.snapshot.mockReset().mockResolvedValue({ path: 'LEGACY', releaseId: null, state: null })
    mocks.guestRead.mockReset().mockImplementation(({ legacyKnowledgeEntries }) => ({
      path: 'LEGACY',
      knowledgeEntries: legacyKnowledgeEntries,
    }))
  })

  it('returns exact source, target, guest observation, and digest metadata', async () => {
    const db = client()
    const result = await readSupportNoChangeFulfillment(db as never, {
      tenantId,
      venueId,
      supportRequestId,
      asOf: now,
    })

    expect(result).toMatchObject({
      contractVersion: 1,
      guestRead: { path: 'LEGACY', releaseId: null, nativeStateHash: null },
      verifiedAt: now.toISOString(),
      receipts: [
        {
          outcome: 'DUPLICATE_NOOP',
          proposalId,
          sourceProposalId: proposalId,
          sourceRequestVersion: 2,
          targetKnowledgeEntryId: target.id,
          targetSnapshotHash: targetHash(),
          contentModuleId: null,
          contentRevisionId: null,
          contentPublicationId: null,
        },
      ],
    })
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(db.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it('returns a non-applicable empty identity without semantic delegates', async () => {
    mocks.sources.mockResolvedValue([])
    const result = await readSupportNoChangeFulfillment({} as never, {
      tenantId,
      venueId,
      supportRequestId,
      asOf: now,
    })
    expect(result).toMatchObject({
      contractVersion: 1,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE', releaseId: null, nativeStateHash: null },
      verifiedAt: now.toISOString(),
    })
  })

  it('returns a non-applicable empty identity when sources have no no-change receipt', async () => {
    const db = client({ duplicates: [], conflicts: [] })
    const result = await readSupportNoChangeFulfillment(db as never, {
      tenantId,
      venueId,
      supportRequestId,
      asOf: now,
    })
    expect(result).toMatchObject({
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' },
    })
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('rejects retained duplicate evidence that no longer matches frozen messages', async () => {
    const db = client({ messages: [{ ...message, body: 'Changed evidence.' }] })
    await expect(
      readSupportNoChangeFulfillment(db as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      }),
    ).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })

  it('rejects a canonical target whose full snapshot changed', async () => {
    const db = client({ targets: [{ ...target, content: 'Changed canonical guidance.' }] })
    await expect(
      readSupportNoChangeFulfillment(db as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      }),
    ).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })

  it('rejects guest-read drift even when the stored canonical target still matches', async () => {
    mocks.guestRead.mockReturnValue({
      path: 'NATIVE',
      knowledgeEntries: [{ ...target, content: 'Stale native projection.' }],
    })
    await expect(
      readSupportNoChangeFulfillment(client() as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      }),
    ).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })

  it('rejects conflicting no-change outcomes for one proposal', async () => {
    const conflict = {
      ...duplicate({ sourceEvidence: undefined }),
      proposal: proposal({
        status: 'REJECTED',
        reviewNote: 'Resolved by semantic conflict decision 00000000-0000-4000-8000-000000000020.',
      }),
      id: '00000000-0000-4000-8000-000000000020',
      questionUpdatedAt: now,
      answeredAt: now,
      answerHash: createHash('sha256').update('Keep canonical.').digest('hex'),
      question: { status: 'ANSWERED', updatedAt: now, answeredAt: now, answer: 'Keep canonical.' },
    }
    await expect(
      readSupportNoChangeFulfillment(client({ conflicts: [conflict] }) as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      }),
    ).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })

  it('rejects a no-change proposal that also has a mutating receipt', async () => {
    const row = duplicate({ proposal: proposal({ universalContentHandoff: { id: 'handoff-a' } }) })
    await expect(
      readSupportNoChangeFulfillment(client({ duplicates: [row] }) as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      }),
    ).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })
  it('verifies KEEP_CANONICAL after retirement and rejects changed review or answer evidence', async () => {
    const id = '00000000-0000-4000-8000-000000000011'
    const answer = 'Keep the current guidance.'
    const kept = {
      ...duplicate(),
      id,
      proposalUpdatedAt: new Date(now.getTime() - 1000),
      proposal: proposal({
        status: 'REJECTED',
        reviewNote: `Resolved by semantic conflict decision ${id}.`,
      }),
      questionUpdatedAt: now,
      answeredAt: now,
      answerHash: createHash('sha256').update(answer).digest('hex'),
      question: { status: 'ANSWERED', updatedAt: now, answeredAt: now, answer },
    }
    const read = (row: unknown) =>
      readSupportNoChangeFulfillment(client({ duplicates: [], conflicts: [row] }) as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      })
    await expect(read(kept)).resolves.toMatchObject({
      receipts: [
        expect.objectContaining({
          outcome: 'KEEP_CANONICAL',
          proposalUpdatedAt: now.toISOString(),
        }),
      ],
    })
    for (const changed of [
      { ...kept, proposal: { ...kept.proposal, status: 'APPROVED' } },
      { ...kept, proposal: { ...kept.proposal, reviewerId: 'another-reviewer' } },
      { ...kept, proposal: { ...kept.proposal, reviewNote: 'Different review' } },
      { ...kept, question: { ...kept.question, answer: 'A different answer.' } },
      { ...kept, question: { ...kept.question, updatedAt: new Date(now.getTime() + 1) } },
    ])
      await expect(read(changed)).rejects.toThrow('Keep-canonical decision evidence is stale')
  })

  it('requires complete, current, effective native projection identity', async () => {
    const linked = {
      ...target,
      contentModuleId: 'module',
      contentRevisionId: 'revision',
      contentPublicationId: 'publication',
      contentModule: {
        revisions: [{ id: 'revision' }],
        publications: [{ id: 'publication', revisionId: 'revision', action: 'PUBLISH' }],
      },
      contentRevision: {
        audience: 'PUBLIC',
        effectiveFrom: new Date(now.getTime() - 1000),
        effectiveUntil: new Date(now.getTime() + 1000),
        operationalFact: null,
      },
    }
    const read = (row: unknown) =>
      readSupportNoChangeFulfillment(client({ targets: [row] }) as never, {
        tenantId,
        venueId,
        supportRequestId,
        asOf: now,
      })
    await expect(read(linked)).resolves.toMatchObject({
      receipts: [expect.objectContaining({ contentPublicationId: 'publication' })],
    })
    for (const changed of [
      { ...linked, contentPublicationId: null },
      {
        ...linked,
        contentModule: {
          ...linked.contentModule,
          publications: [{ id: 'publication', revisionId: 'revision', action: 'WITHDRAW' }],
        },
      },
      { ...linked, contentRevision: { ...linked.contentRevision, effectiveUntil: now } },
      {
        ...linked,
        contentRevision: { ...linked.contentRevision, effectiveFrom: new Date(now.getTime() + 1) },
      },
      {
        ...linked,
        contentRevision: { ...linked.contentRevision, operationalFact: { expiresAt: now } },
      },
    ])
      await expect(read(changed)).rejects.toBeInstanceOf(SupportNoChangeFulfillmentError)
  })

  it('rejects an over-bound receipt query instead of silently truncating evidence', async () => {
    await expect(
      readSupportNoChangeFulfillment(
        client({ duplicates: Array.from({ length: 101 }, () => duplicate()) }) as never,
        { tenantId, venueId, supportRequestId, asOf: now },
      ),
    ).rejects.toThrow('exceeds 100')
  })
})
