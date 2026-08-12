import { describe, expect, it, vi } from 'vitest'

import {
  intakeReviewedDraftFinalizer,
  standaloneReviewedDraftFinalizer,
  supportReviewedDraftFinalizer,
} from './admin-reviewed-draft-finalizers'

const completePreview = {
  report: { semanticDuplicateScan: { status: 'COMPLETE' } },
} as never

function harness() {
  const tx = {
    supportPackageHandoff: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'handoff_1' }),
    },
    supportRequest: {
      findFirst: vi.fn().mockResolvedValue({ id: 'support_1', status: 'IN_REVIEW', version: 4 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    supportRequestAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'event_1' }) },
    intakePackageHandoff: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'intake_handoff_1' }),
    },
    intakeRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run_1', status: 'AWAITING_REVIEW' }),
    },
    intakeRunEvent: { create: vi.fn().mockResolvedValue({ id: 'intake_event_1' }) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const base = {
    tx: tx as never,
    packageId: 'package_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    status: 'DRAFT',
    createdBy: 'admin_1',
    preview: completePreview,
    replayed: false,
  }
  return { tx, base }
}

describe('admin reviewed DRAFT finalizers', () => {
  it('requires actor-bound DRAFT identity and semantic COMPLETE evidence', async () => {
    const { base } = harness()
    await expect(standaloneReviewedDraftFinalizer('admin_1')(base)).resolves.toMatchObject({
      packageId: 'package_1',
      replayed: false,
    })
    await expect(
      standaloneReviewedDraftFinalizer('other')({ ...base, replayed: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      standaloneReviewedDraftFinalizer('admin_1')({
        ...base,
        preview: { report: { semanticDuplicateScan: { status: 'NOT_RUN' } } } as never,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('atomically links support with exact expectedVersion CAS and sanitized audit', async () => {
    const { tx, base } = harness()
    const result = await supportReviewedDraftFinalizer({
      actorId: 'admin_1',
      supportRequestId: 'support_1',
      expectedVersion: 4,
    })(base)
    expect(result).toEqual({ requestVersion: 5, replayed: false })
    expect(tx.supportRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 4 }),
        data: { version: 5, updatedByKind: 'OPERATOR', updatedById: 'admin_1' },
      }),
    )
    expect(tx.supportPackageHandoff.create).toHaveBeenCalledOnce()
    expect(tx.supportRequestAuditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'PACKAGE_DRAFT_CREATED_AND_LINKED' }),
      }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('payload')
  })

  it('reconciles exact support replay without incrementing or auditing again', async () => {
    const { tx, base } = harness()
    tx.supportPackageHandoff.findFirst.mockResolvedValueOnce({
      supportRequestId: 'support_1',
      requestVersion: 5,
      linkedById: 'admin_1',
    })
    await expect(
      supportReviewedDraftFinalizer({
        actorId: 'admin_1',
        supportRequestId: 'support_1',
        expectedVersion: 4,
      })({ ...base, replayed: true }),
    ).resolves.toEqual({ requestVersion: 5, replayed: true })
    expect(tx.supportRequest.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('atomically links only AWAITING_REVIEW intake and reconciles exact replay', async () => {
    const first = harness()
    await expect(
      intakeReviewedDraftFinalizer({ actorId: 'admin_1', intakeRunId: 'run_1' })(first.base),
    ).resolves.toEqual({ replayed: false })
    expect(first.tx.intakeRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'AWAITING_REVIEW' }) }),
    )
    expect(first.tx.intakePackageHandoff.create).toHaveBeenCalledOnce()
    expect(first.tx.intakeRunEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'PACKAGE_DRAFT_LINKED' }),
      }),
    )

    const replay = harness()
    replay.tx.intakePackageHandoff.findFirst.mockResolvedValueOnce({
      runId: 'run_1',
      createdBy: 'admin_1',
    })
    await expect(
      intakeReviewedDraftFinalizer({ actorId: 'admin_1', intakeRunId: 'run_1' })({
        ...replay.base,
        replayed: true,
      }),
    ).resolves.toEqual({ replayed: true })
    expect(replay.tx.intakeRun.findFirst).not.toHaveBeenCalled()
  })
})
