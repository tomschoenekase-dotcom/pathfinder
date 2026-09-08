import { describe, expect, it, vi } from 'vitest'

import {
  tenantIsolationMiddleware,
  type TenantIsolationMiddlewareParams,
} from '../middleware/tenant-isolation'

import {
  IntakeSubmissionDraftError,
  getIntakeSubmissionDraft,
  saveIntakeSubmissionDraft,
} from './intake-submission-draft-actions'

function client(
  existing: { id: string; revision: number; submittedAt: Date | null } | null = null,
) {
  const guarded = (action: string, result: unknown) =>
    vi.fn(async (args: NonNullable<TenantIsolationMiddlewareParams['args']>) =>
      tenantIsolationMiddleware(
        { model: 'IntakeSubmissionDraft', action, args },
        async () => result,
      ),
    )
  const intakeSubmissionDraft = {
    findUnique: guarded('findUnique', existing),
    findUniqueOrThrow: guarded('findUniqueOrThrow', {
      id: 'draft-1',
      revision: 2,
      updatedAt: new Date(),
    }),
    create: guarded('create', { id: 'draft-1', revision: 1, updatedAt: new Date() }),
    updateMany: guarded('updateMany', { count: 1 }),
  }
  return {
    intakeSubmissionDraft,
    $transaction: vi.fn(
      async (callback: (tx: { intakeSubmissionDraft: typeof intakeSubmissionDraft }) => unknown) =>
        callback({ intakeSubmissionDraft }),
    ),
  }
}

describe('intake submission draft actions', () => {
  it.each([null, new Date('2026-09-01T00:00:00Z')])(
    'keeps update and reopened-draft readback inside the actual tenant guard (submittedAt=%s)',
    async (submittedAt) => {
      const db = client({ id: 'draft-1', revision: 1, submittedAt })
      await expect(
        saveIntakeSubmissionDraft(
          {
            tenantId: 'tenant-a',
            venueId: 'venue-a',
            ownerUserId: 'user-a',
            sourceKind: 'NOTES',
            expectedRevision: submittedAt ? 0 : 1,
            content: { kind: 'NOTES', notes: 'Revised visitor information.' },
          },
          db as never,
        ),
      ).resolves.toMatchObject({ id: 'draft-1', revision: 2 })
      expect(db.intakeSubmissionDraft.updateMany).toHaveBeenCalledOnce()
      expect(db.intakeSubmissionDraft.findUniqueOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'draft-1', tenantId: 'tenant-a' },
        }),
      )
    },
  )
  it('reads only the exact tenant, venue, owner and source identity', async () => {
    const db = client()
    await getIntakeSubmissionDraft(
      { tenantId: 'tenant-a', venueId: 'venue-a', ownerUserId: 'user-a', sourceKind: 'NOTES' },
      db as never,
    )
    expect(db.intakeSubmissionDraft.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          tenantId_venueId_ownerUserId_sourceKind: {
            tenantId: 'tenant-a',
            venueId: 'venue-a',
            ownerUserId: 'user-a',
            sourceKind: 'NOTES',
          },
        },
      }),
    )
  })

  it('creates revision one only when the caller expects no prior draft', async () => {
    const db = client()
    await saveIntakeSubmissionDraft(
      {
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        ownerUserId: 'user-a',
        sourceKind: 'NOTES',
        expectedRevision: 0,
        content: { kind: 'NOTES', notes: 'Step-free east entrance.' },
      },
      db as never,
    )
    expect(db.intakeSubmissionDraft.create).toHaveBeenCalledOnce()
  })

  it('rejects stale concurrent writes without overwriting content', async () => {
    const db = client({ id: 'draft-1', revision: 4, submittedAt: null })
    await expect(
      saveIntakeSubmissionDraft(
        {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          ownerUserId: 'user-a',
          sourceKind: 'NOTES',
          expectedRevision: 3,
          content: { kind: 'NOTES', notes: 'Stale' },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(db.intakeSubmissionDraft.updateMany).not.toHaveBeenCalled()
  })

  it('rejects mismatched source identity and oversized fields', async () => {
    const db = client()
    await expect(
      saveIntakeSubmissionDraft(
        {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          ownerUserId: 'user-a',
          sourceKind: 'WEBSITE',
          expectedRevision: 0,
          content: { kind: 'NOTES', notes: 'wrong source' },
        },
        db as never,
      ),
    ).rejects.toBeInstanceOf(IntakeSubmissionDraftError)
    await expect(
      saveIntakeSubmissionDraft(
        {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          ownerUserId: 'user-a',
          sourceKind: 'NOTES',
          expectedRevision: 0,
          content: { kind: 'NOTES', notes: 'x'.repeat(20_001) },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('bounds interview role keys, question identifiers, question counts, and total bytes', async () => {
    const db = client()
    const answer = {
      mode: 'ANSWER' as const,
      text: 'answer',
      privacy: 'PUBLIC_CANDIDATE' as const,
      uncertain: false,
      confidence: 0.8,
    }
    const base = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      ownerUserId: 'user-a',
      sourceKind: 'INTERVIEW' as const,
      expectedRevision: 0,
    }
    await expect(
      saveIntakeSubmissionDraft(
        {
          ...base,
          content: {
            kind: 'INTERVIEW',
            displayName: 'Interview',
            role: 'EXECUTIVE',
            consent: false,
            draftsByRole: { NOT_A_ROLE: { question: answer } },
          } as never,
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      saveIntakeSubmissionDraft(
        {
          ...base,
          content: {
            kind: 'INTERVIEW',
            displayName: 'Interview',
            role: 'EXECUTIVE',
            consent: false,
            draftsByRole: { EXECUTIVE: { ['q'.repeat(192)]: answer } },
          },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      saveIntakeSubmissionDraft(
        {
          ...base,
          content: {
            kind: 'INTERVIEW',
            displayName: 'Interview',
            role: 'EXECUTIVE',
            consent: false,
            draftsByRole: {
              EXECUTIVE: Object.fromEntries(
                Array.from({ length: 51 }, (_, index) => [`q-${index}`, answer]),
              ),
            },
          },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      saveIntakeSubmissionDraft(
        {
          ...base,
          content: {
            kind: 'INTERVIEW',
            displayName: 'Interview',
            role: 'EXECUTIVE',
            consent: false,
            draftsByRole: {
              EXECUTIVE: Object.fromEntries(
                Array.from({ length: 20 }, (_, index) => [
                  `q-${index}`,
                  { ...answer, text: 'é'.repeat(10_000) },
                ]),
              ),
            },
          },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it('maps a concurrent first-create unique race to a reloadable conflict', async () => {
    const db = client()
    db.intakeSubmissionDraft.create.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      saveIntakeSubmissionDraft(
        {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          ownerUserId: 'user-a',
          sourceKind: 'NOTES',
          expectedRevision: 0,
          content: { kind: 'NOTES', notes: 'Concurrent' },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
