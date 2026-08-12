import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  publishWeeklyReportAction,
  updateWeeklyReportConfigurationAction,
  updateWeeklyReportDraftAction,
  WeeklyReportActionError,
} from './weekly-report-actions'

const actor = { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' } as const
const scope = { tenantId: 'tenant_1', venueId: 'venue_1', actor }
const revision = new Date('2026-08-11T14:30:00.000Z')

function fixture() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    venueReportConfiguration: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weeklyReport: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  return { tx, client }
}

describe('weekly report domain actions', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects a non-human actor before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      updateWeeklyReportDraftAction(
        {
          ...scope,
          actor: { type: 'AGENT', id: 'agent_1', role: 'PLATFORM_ADMIN' } as never,
          reportId: 'report_1',
          expectedUpdatedAt: revision,
          content: 'content',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('rejects invalid content and revisions before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      updateWeeklyReportDraftAction(
        {
          ...scope,
          reportId: 'report_1',
          expectedUpdatedAt: new Date('invalid'),
          content: '',
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('treats a missing configuration as disabled without creating or auditing', async () => {
    const { tx, client } = fixture()
    tx.venueReportConfiguration.findFirst.mockResolvedValueOnce(null)

    await expect(
      updateWeeklyReportConfigurationAction(
        { ...scope, enabled: false, expectedUpdatedAt: null },
        client as never,
      ),
    ).resolves.toMatchObject({ enabled: false, updatedAt: null, replayed: true })
    expect(tx.venueReportConfiguration.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('creates an enabled configuration in exact scope with sanitized strict audit evidence', async () => {
    const { tx, client } = fixture()
    tx.venueReportConfiguration.findFirst.mockResolvedValueOnce(null)
    tx.venueReportConfiguration.create.mockResolvedValueOnce({
      id: 'config_1',
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      enabled: true,
      updatedBy: actor.id,
      createdAt: revision,
      updatedAt: revision,
    })

    await updateWeeklyReportConfigurationAction(
      { ...scope, enabled: true, expectedUpdatedAt: null },
      client as never,
    )

    expect(tx.venue.findFirst).toHaveBeenCalledWith({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { id: true },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: scope.tenantId,
        actorRole: 'PLATFORM_ADMIN',
        beforeState: { enabled: false },
        afterState: { enabled: true },
      }),
    })
  })

  it('rejects a stale configuration revision before any write or audit', async () => {
    const { tx, client } = fixture()
    tx.venueReportConfiguration.findFirst.mockResolvedValueOnce({
      id: 'config_1',
      enabled: true,
      updatedAt: new Date(revision.getTime() + 1),
    })

    await expect(
      updateWeeklyReportConfigurationAction(
        { ...scope, enabled: false, expectedUpdatedAt: revision },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.venueReportConfiguration.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('edits only an exact-scope DRAFT CAS and never audits title or content', async () => {
    const { tx, client } = fixture()
    vi.spyOn(Date, 'now').mockReturnValue(revision.getTime())
    tx.weeklyReport.findFirst.mockResolvedValueOnce({ status: 'DRAFT', updatedAt: revision })
    tx.weeklyReport.updateMany.mockResolvedValueOnce({ count: 1 })

    const result = await updateWeeklyReportDraftAction(
      {
        ...scope,
        reportId: 'report_1',
        expectedUpdatedAt: revision,
        title: 'secret-bearing title',
        content: 'raw private report payload',
      },
      client as never,
    )

    expect(tx.weeklyReport.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'report_1',
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: 'DRAFT',
        updatedAt: revision,
      },
      data: {
        title: 'secret-bearing title',
        content: 'raw private report payload',
        updatedAt: new Date(revision.getTime() + 1),
      },
    })
    expect(result.updatedAt).toBe(new Date(revision.getTime() + 1).toISOString())
    const audit = JSON.stringify(tx.auditLog.create.mock.calls)
    expect(audit).not.toContain('secret-bearing title')
    expect(audit).not.toContain('raw private report payload')
  })

  it.each(['PUBLISHED', 'GENERATING', 'FAILED'])(
    'rejects the illegal %s to DRAFT edit transition',
    async (status) => {
      const { tx, client } = fixture()
      tx.weeklyReport.findFirst.mockResolvedValueOnce({ status, updatedAt: revision })

      await expect(
        updateWeeklyReportDraftAction(
          { ...scope, reportId: 'report_1', expectedUpdatedAt: revision, content: 'content' },
          client as never,
        ),
      ).rejects.toBeInstanceOf(WeeklyReportActionError)
      expect(tx.weeklyReport.updateMany).not.toHaveBeenCalled()
      expect(tx.auditLog.create).not.toHaveBeenCalled()
    },
  )

  it('fails publish closed when configuration is absent and never reads report content', async () => {
    const { tx, client } = fixture()
    tx.venueReportConfiguration.findFirst.mockResolvedValueOnce(null)

    await expect(
      publishWeeklyReportAction(
        { ...scope, reportId: 'report_1', expectedUpdatedAt: revision },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(tx.weeklyReport.findFirst).not.toHaveBeenCalled()
    expect(tx.weeklyReport.updateMany).not.toHaveBeenCalled()
  })

  it('publishes through an exact DRAFT CAS and keeps raw report content out of audit', async () => {
    const { tx, client } = fixture()
    tx.venueReportConfiguration.findFirst.mockResolvedValueOnce({ enabled: true })
    tx.weeklyReport.findFirst.mockResolvedValueOnce({
      status: 'DRAFT',
      content: 'private report content',
      updatedAt: revision,
    })
    tx.weeklyReport.updateMany.mockResolvedValueOnce({ count: 1 })

    await publishWeeklyReportAction(
      { ...scope, reportId: 'report_1', expectedUpdatedAt: revision },
      client as never,
    )

    expect(tx.weeklyReport.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'report_1',
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        status: 'DRAFT',
        updatedAt: revision,
      },
      data: { status: 'PUBLISHED', publishedAt: expect.any(Date) },
    })
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('private report content')
  })

  it('propagates strict audit failure so the transaction cannot report success', async () => {
    const { tx, client } = fixture()
    tx.weeklyReport.findFirst.mockResolvedValueOnce({ status: 'DRAFT', updatedAt: revision })
    tx.weeklyReport.updateMany.mockResolvedValueOnce({ count: 1 })
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))

    await expect(
      updateWeeklyReportDraftAction(
        { ...scope, reportId: 'report_1', expectedUpdatedAt: revision, content: 'content' },
        client as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })
})
