import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getOnboardingBootstrapSubmission,
  OnboardingBootstrapError,
  submitOnboardingBootstrapAction,
} from './onboarding-bootstrap-actions'

const requestId = '5d1a79a1-93e0-4af2-88f7-f6cb974a92a4'
const actor = { type: 'HUMAN' as const, id: 'owner-a', role: 'OWNER' as const }
const submission = {
  requestId,
  venue: { name: 'Museum', slug: 'museum', category: 'museum', guideMode: 'non_location' as const },
  rawContent: {
    kind: 'knowledge' as const,
    value: { title: 'Hours', category: 'HOURS', content: 'Private candidate hours text.' },
  },
}

function fixture() {
  const venue = { id: 'venue-a', name: 'Museum', slug: 'museum' }
  const run = {
    id: 'run-a',
    venueId: venue.id,
    sourceKind: 'STRUCTURED_BOOTSTRAP',
    status: 'AWAITING_REVIEW',
    displayName: 'Museum onboarding information',
    submissionInputHash: 'a'.repeat(64),
    createdAt: new Date('2026-08-11T15:00:00Z'),
    venue,
  }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    venue: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ ...venue, places: [], knowledgeEntries: [] }),
    },
    intakeRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(run),
    },
    intakeEvidenceRecord: { create: vi.fn().mockResolvedValue({ id: 'evidence-a' }) },
    intakeRunEvent: { create: vi.fn().mockResolvedValue({ id: 'event-a' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    intakeRun: { findFirst: vi.fn() },
  }
  return { tx, client, run }
}

describe('onboarding bootstrap intake action', () => {
  beforeEach(() => vi.clearAllMocks())

  it('atomically creates only a venue shell and a private review proposal with sanitized audit', async () => {
    const { tx, client } = fixture()
    const result = await submitOnboardingBootstrapAction({
      tenantId: 'tenant-a',
      actor,
      submission,
      client: client as never,
    })

    expect(result).toMatchObject({
      venue: { id: 'venue-a' },
      status: 'AWAITING_REVIEW',
      autoApply: false,
      published: false,
    })
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.venue.create.mock.invocationCallOrder[0]!,
    )
    expect(tx.venue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isActive: false }),
      }),
    )
    expect(tx.venue.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('places')
    expect(tx.venue.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('knowledgeEntries')
    expect(tx.intakeRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          structuredBootstrap: { version: 1, content: submission.rawContent },
          submissionRequestId: requestId,
          requestedBy: actor.id,
        }),
      }),
    )
    expect(tx.intakeEvidenceRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    const events = JSON.stringify(tx.intakeRunEvent.create.mock.calls)
    expect(audit).not.toContain('Private candidate hours text.')
    expect(audit).not.toContain('Hours')
    expect(events).not.toContain('Private candidate hours text.')
    expect(tx.intakeRunEvent.create).toHaveBeenCalledTimes(2)
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('replays the exact tenant request without duplicate venue, evidence, event, or audit writes', async () => {
    const first = fixture()
    await submitOnboardingBootstrapAction({
      tenantId: 'tenant-a',
      actor,
      submission,
      client: first.client as never,
    })
    const inputHash = first.tx.intakeRun.create.mock.calls[0]?.[0]?.data.submissionInputHash
    const replay = fixture()
    replay.tx.intakeRun.findFirst.mockResolvedValue({
      ...replay.run,
      submissionInputHash: inputHash,
    })
    const result = await submitOnboardingBootstrapAction({
      tenantId: 'tenant-a',
      actor,
      submission,
      client: replay.client as never,
    })
    expect(result.replayed).toBe(true)
    expect(replay.tx.venue.create).not.toHaveBeenCalled()
    expect(replay.tx.intakeEvidenceRecord.create).not.toHaveBeenCalled()
    expect(replay.tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects same-key different-content collisions before venue writes', async () => {
    const { tx, client, run } = fixture()
    tx.intakeRun.findFirst.mockResolvedValue({ ...run, submissionInputHash: 'f'.repeat(64) })
    await expect(
      submitOnboardingBootstrapAction({
        tenantId: 'tenant-a',
        actor,
        submission,
        client: client as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<OnboardingBootstrapError>)
    expect(tx.venue.create).not.toHaveBeenCalled()
  })

  it('converges a concurrent request-key unique race onto the durable exact replay', async () => {
    const { tx, client, run } = fixture()
    client.$transaction.mockRejectedValue({ code: 'P2002' })
    const first = fixture()
    await submitOnboardingBootstrapAction({
      tenantId: 'tenant-a',
      actor,
      submission,
      client: first.client as never,
    })
    const inputHash = first.tx.intakeRun.create.mock.calls[0]?.[0]?.data.submissionInputHash
    client.intakeRun.findFirst.mockResolvedValue({ ...run, submissionInputHash: inputHash })

    const result = await submitOnboardingBootstrapAction({
      tenantId: 'tenant-a',
      actor,
      submission,
      client: client as never,
    })
    expect(result.replayed).toBe(true)
    expect(client.intakeRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', submissionRequestId: requestId },
      }),
    )
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('fails closed for malformed authority/input and makes audit failure fail the transaction', async () => {
    const invalid = fixture()
    await expect(
      submitOnboardingBootstrapAction({
        tenantId: 'tenant-a',
        actor: { ...actor, role: 'VIEWER' } as never,
        submission,
        client: invalid.client as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(invalid.client.$transaction).not.toHaveBeenCalled()

    await expect(submitOnboardingBootstrapAction(undefined as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      submitOnboardingBootstrapAction({
        tenantId: 'tenant-a',
        actor: { type: 'HUMAN', id: 42, role: 'OWNER' },
        submission,
        client: invalid.client,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      submitOnboardingBootstrapAction({
        tenantId: 42,
        actor,
        submission,
        client: invalid.client,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(invalid.client.$transaction).not.toHaveBeenCalled()

    const rollback = fixture()
    rollback.tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      submitOnboardingBootstrapAction({
        tenantId: 'tenant-a',
        actor,
        submission,
        client: rollback.client as never,
      }),
    ).rejects.toThrow('audit unavailable')
  })

  it('reads lifecycle by exact tenant and request key without returning raw proposal content', async () => {
    const { client, run } = fixture()
    client.intakeRun.findFirst.mockResolvedValue(run)
    const result = await getOnboardingBootstrapSubmission({
      tenantId: 'tenant-a',
      requestId,
      client: client as never,
    })
    expect(client.intakeRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', submissionRequestId: requestId },
      }),
    )
    expect(JSON.stringify(result)).not.toContain('structuredBootstrap')
    expect(result).toMatchObject({ status: 'AWAITING_REVIEW', nextAction: 'PATHFINDER_REVIEW' })
  })
})
