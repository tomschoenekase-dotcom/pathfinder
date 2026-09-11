import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  audit: vi.fn(),
  preview: vi.fn(),
  evidence: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  lockVenueContentMutation: mocks.lock,
  writeAuditLogStrict: mocks.audit,
}))
vi.mock('./semantic-venue-updater-service', () => ({
  previewSemanticVenueUpdateFromProposal: mocks.preview,
}))
vi.mock('./support-proposal-content-evidence', () => ({
  resolveSupportProposalContentEvidence: mocks.evidence,
}))

import { resolveSemanticDuplicateService } from './semantic-duplicate-resolution-service'
import { hashSemanticConflictTarget } from './semantic-conflict-resolution-contract'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  relation: 'NEW_FACT' as const,
  desired: { title: 'Hours', category: 'POLICY', content: 'Open daily.', isEnabled: true },
  resolutionNote: 'The published entry already matches the reviewed support evidence.',
}
const updatedAt = new Date(input.expectedProposalUpdatedAt)
const target = {
  id: 'entry_1',
  title: 'Hours',
  category: 'POLICY',
  content: 'Open daily.',
  isEnabled: true,
  humanConfirmedAt: null,
  authorship: 'HUMAN_AUTHORED',
  sourceType: 'PATHFINDER_INTAKE',
}
const preview = {
  classification: 'DUPLICATE_NOOP',
  duplicateMatch: { knowledgeEntryId: target.id, targetSnapshotHash: 'b'.repeat(64) },
  previewHash: input.expectedPreviewHash,
  blockers: [],
  operationCount: 0,
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: input.proposalId,
    status: 'APPROVED',
    updatedAt,
    proposedChange: `[CREATE_KNOWLEDGE]\n${input.desired.content}`,
    packageHandoff: null,
    operationalUpdateHandoff: null,
    universalContentHandoff: null,
    legacyContentAdoption: null,
    conflictResolutions: [],
    ...overrides,
  }
}

function db(overrides: Record<string, unknown> = {}) {
  mocks.lock.mockReset().mockResolvedValue(undefined)
  mocks.audit.mockReset().mockResolvedValue(undefined)
  mocks.preview.mockReset().mockResolvedValue(preview)
  mocks.evidence.mockReset().mockResolvedValue([
    {
      sourceId: 'support-message:message_1',
      locator: 'support-request:request_1',
      capturedAt: '2026-09-10T11:00:00.000Z',
      excerptHash: 'c'.repeat(64),
    },
  ])
  const tx = {
    semanticDuplicateResolution: {
      findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      create: vi.fn().mockResolvedValue({ id: input.operationId }),
    },
    knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(proposal()) },
    venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue(target) },
    $queryRaw: vi.fn(),
    ...overrides,
  }
  return { $transaction: vi.fn(async (fn) => fn(tx)), tx }
}

function inputHash(actorId = 'admin_1') {
  return createHash('sha256')
    .update(JSON.stringify({ ...input, actorId }))
    .digest('hex')
}

describe('resolveSemanticDuplicateService', () => {
  it('creates an exact server-evidenced no-op receipt without canonical or proposal mutation', async () => {
    const client = db()
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).resolves.toMatchObject({
      resolutionId: input.operationId,
      outcome: 'DUPLICATE_NOOP',
      replayed: false,
      canonicalKnowledgeChanged: false,
    })
    expect(client.tx.semanticDuplicateResolution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          proposalId: input.proposalId,
          previewHash: input.expectedPreviewHash,
          targetSnapshotHash: hashSemanticConflictTarget(target),
          sourceEvidence: await mocks.evidence.mock.results[0]?.value,
        }),
      }),
    )
    expect(client.tx.knowledgeChangeProposal).not.toHaveProperty('update')
    expect(client.tx.venueKnowledgeEntry).not.toHaveProperty('update')
  })

  it('replays an exact historical operation only for the same reviewer and input', async () => {
    const client = db({
      semanticDuplicateResolution: {
        findFirst: vi.fn().mockResolvedValue({ id: input.operationId, inputHash: inputHash() }),
        create: vi.fn(),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).resolves.toMatchObject({ replayed: true })
    expect(mocks.preview).not.toHaveBeenCalled()
  })

  it.each([
    ['another reviewer', 'admin_2', input],
    ['another input', 'admin_1', { ...input, resolutionNote: 'Different note.' }],
  ])('rejects replay collision from %s', async (_label, actorId, value) => {
    const client = db({
      semanticDuplicateResolution: {
        findFirst: vi.fn().mockResolvedValue({ id: input.operationId, inputHash: inputHash() }),
        create: vi.fn(),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId, input: value }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each([
    ['stale proposal', proposal({ updatedAt: new Date('2026-09-10T12:01:00.000Z') })],
    ['changed wording', proposal({ proposedChange: 'Changed.' })],
    ['existing handoff', proposal({ universalContentHandoff: { id: 'handoff_1' } })],
  ])('rejects %s before a receipt write', async (_label, value) => {
    const client = db({ knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(value) } })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(client.tx.semanticDuplicateResolution.create).not.toHaveBeenCalled()
  })

  it('propagates a missing scoped support evidence error', async () => {
    const client = db()
    mocks.evidence.mockRejectedValueOnce(new Error('Exact support source evidence is unavailable.'))
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).rejects.toThrow('Exact support source evidence')
  })

  it('accepts the exact unwrapped replacement wording', async () => {
    const client = db({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue(proposal({ proposedChange: input.desired.content })),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).resolves.toMatchObject({ outcome: 'DUPLICATE_NOOP' })
  })

  it('accepts the explicit no-content-change envelope', async () => {
    const client = db({
      knowledgeChangeProposal: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            proposal({ proposedChange: `[NO_CONTENT_CHANGE]\n${input.desired.content}` }),
          ),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).resolves.toMatchObject({ outcome: 'DUPLICATE_NOOP' })
  })

  it.each([
    ['literal backslash-n', `[CREATE_KNOWLEDGE]\\n${input.desired.content}`],
    ['malformed tag', `[CREATE_KNOWLEDGE] ${input.desired.content}`],
    ['retire tag', `[RETIRE_KNOWLEDGE]\n${input.desired.content}`],
    ['retrieval tag', `[RETRIEVAL_CORRECTION]\n${input.desired.content}`],
  ])('rejects %s wording envelope', async (_label, proposedChange) => {
    const client = db({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue(proposal({ proposedChange })),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects a changed locked preview', async () => {
    const client = db()
    mocks.preview
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, previewHash: 'd'.repeat(64) })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each([null, { ...target, isEnabled: false }])(
    'rejects unavailable matched target',
    async (value) => {
      const client = db({ venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue(value) } })
      await expect(
        resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    },
  )

  it('maps a unique receipt race to conflict', async () => {
    const client = db({
      semanticDuplicateResolution: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        create: vi.fn().mockRejectedValue({ code: 'P2002' }),
      },
    })
    await expect(
      resolveSemanticDuplicateService({ db: client as never, actorId: 'admin_1', input }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
