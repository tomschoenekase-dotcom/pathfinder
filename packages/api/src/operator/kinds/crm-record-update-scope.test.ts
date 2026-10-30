import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@pathfinder/db', () => ({
  readProspectCrmRecord: vi.fn(),
  prospectCrmRecordExpectedRevision: vi.fn(),
  updateProspectCrmRecordAction: vi.fn(),
}))
vi.mock('../outreach-history', () => ({ requireOutreachAccount: vi.fn() }))
import { updateProspectCrmRecordAction } from '@pathfinder/db'
import { requireOutreachAccount } from '../outreach-history'
import { crmRecordUpdateKind, requireCrmRecordScope } from './crm-record-update'
import type { OperatorApplyContext, OperatorKindContext } from '../proposals'

const database = {
  prospectOutreachDraft: { findUnique: vi.fn() },
  prospectCampaignMember: { findUnique: vi.fn(), findMany: vi.fn() },
}
const context = {
  database,
  grant: { allTenants: false, tenantIds: ['allowed'], grantId: 'grant' },
  actor: { type: 'HUMAN', id: 'consenting-owner', role: 'PLATFORM_ADMIN' },
  operationId: 'operation',
  proposalId: 'proposal',
  now: new Date(),
} as unknown as OperatorApplyContext
const note = {
  type: 'note' as const,
  organizationId: 'organization',
  noteId: 'note',
  expectedRevision: 'a'.repeat(64),
  action: 'archive' as const,
}
describe('generic CRM record scope and actor boundaries', () => {
  beforeEach(() => vi.clearAllMocks())
  it('checks the actual owning account of an arbitrary draft UUID', async () => {
    database.prospectOutreachDraft.findUnique.mockResolvedValue({
      organizationId: 'foreign-account',
    })
    vi.mocked(requireOutreachAccount).mockRejectedValueOnce(new Error('NOT_FOUND'))
    await expect(
      requireCrmRecordScope(
        {
          type: 'draft',
          draftId: 'arbitrary-id',
          expectedVersion: 1,
          expectedContentHash: 'a'.repeat(64),
          action: 'discard',
        },
        context,
      ),
    ).rejects.toThrow('NOT_FOUND')
    expect(requireOutreachAccount).toHaveBeenCalledWith('foreign-account', context)
    expect(updateProspectCrmRecordAction).not.toHaveBeenCalled()
  })
  it('requires platform scope for campaign-wide edits', async () => {
    await expect(
      requireCrmRecordScope(
        {
          type: 'campaign',
          campaignId: 'campaign',
          expectedUpdatedAt: new Date().toISOString(),
          action: 'archive',
        },
        context,
      ),
    ).rejects.toThrow()
    expect(database.prospectCampaignMember.findMany).not.toHaveBeenCalled()
  })
  it('checks all actual member account links for a platform campaign edit', async () => {
    database.prospectCampaignMember.findMany.mockResolvedValue([
      { organizationId: 'first' },
      { organizationId: 'second' },
      { organizationId: 'first' },
    ])
    await requireCrmRecordScope(
      {
        type: 'campaign',
        campaignId: 'campaign',
        expectedUpdatedAt: new Date().toISOString(),
        action: 'archive',
      },
      { ...context, grant: { ...context.grant, allTenants: true } } as OperatorKindContext,
    )
    expect(vi.mocked(requireOutreachAccount).mock.calls.map((c) => c[0])).toEqual([
      'first',
      'second',
    ])
  })
  it('retains actual initiating agent provenance instead of relabeling it human', async () => {
    vi.mocked(updateProspectCrmRecordAction).mockResolvedValue({ noteId: 'note', archived: true })
    await crmRecordUpdateKind.apply(
      {
        record: note,
        reason: 'Archive duplicate capture',
        operationId: '12345678-1234-4234-a234-123456789012',
      },
      context,
    )
    expect(updateProspectCrmRecordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          type: 'AGENT',
          id: 'operator:grant',
          capabilities: ['prospects:crm:maintain', 'prospects:draft'],
        },
      }),
      database,
    )
    expect(requireOutreachAccount).toHaveBeenCalledWith('organization', context)
  })
})
