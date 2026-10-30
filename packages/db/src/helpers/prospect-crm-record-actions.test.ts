import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../client', () => ({ db: {} }))
vi.mock('./prospect-outreach-actions', () => ({ saveProspectOutreachDraftAction: vi.fn() }))
import {
  projectProspectNoteLifecycle,
  updateProspectCrmRecordAction,
} from './prospect-crm-record-actions'
const actor = { type: 'HUMAN' as const, role: 'PLATFORM_ADMIN' as const, id: 'owner' }
const note = {
  id: 'note',
  organizationId: 'org',
  summary: 'Operator note added',
  detail: 'Original owner words',
  occurredAt: new Date('2026-10-01T12:00:00Z'),
}
const correction = (id: string, action: string, text?: string) => ({
  id,
  occurredAt: new Date(`2026-10-0${id}T12:00:00Z`),
  evidence: { schema: 'crm-note-lifecycle/v1', noteId: 'note', action, ...(text ? { text } : {}) },
})
describe('append-only note lifecycle', () => {
  it('preserves the sole original while projecting correction/archive/restore', () => {
    const edits = [
      correction('2', 'correct', 'Corrected observation'),
      correction('3', 'archive'),
      correction('4', 'restore'),
    ]
    const p = projectProspectNoteLifecycle(note, edits)
    expect(p).toMatchObject({
      text: 'Corrected observation',
      originalText: 'Original owner words',
      archived: false,
      corrected: true,
    })
    expect(note.detail).toBe('Original owner words')
    expect(p.revision).not.toBe(projectProspectNoteLifecycle(note, []).revision)
  })
  it('ignores evidence for unrelated records and is stable under input row ordering', () => {
    const edits = [correction('2', 'correct', 'Corrected observation'), correction('3', 'archive')]
    expect(projectProspectNoteLifecycle(note, [...edits].reverse())).toEqual(
      projectProspectNoteLifecycle(note, edits),
    )
    const other = {
      ...correction('4', 'restore'),
      evidence: { schema: 'crm-note-lifecycle/v1', noteId: 'other', action: 'restore' },
    }
    expect(projectProspectNoteLifecycle(note, [...edits, other]).archived).toBe(true)
  })
})
describe('record mutation guards and receipts', () => {
  const timestamp = new Date('2026-10-01T12:00:00Z')
  const campaign = {
    id: 'campaign',
    name: 'Original',
    description: 'Keep original description',
    status: 'DRAFT',
    updatedAt: timestamp,
    cohortSnapshot: { selectedIds: ['org'] },
  }
  const draft = {
    id: 'draft',
    memberId: 'member',
    version: 2,
    contentHash: 'a'.repeat(64),
    status: 'QUEUED',
  }
  const tx = {
    auditLog: { findUnique: vi.fn(), create: vi.fn() },
    prospectOutreachCampaign: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    prospectOutreachDraft: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    prospectCampaignMember: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    prospectSendItem: { count: vi.fn(), updateMany: vi.fn() },
    prospectSendBatch: { findMany: vi.fn(), updateMany: vi.fn() },
    prospectActivity: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  }
  const client = {
    ...tx,
    $transaction: vi.fn(async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as NonNullable<Parameters<typeof updateProspectCrmRecordAction>[1]>
  beforeEach(() => {
    vi.clearAllMocks()
    tx.auditLog.findUnique.mockResolvedValue(null)
    tx.prospectOutreachCampaign.findUnique.mockResolvedValue(campaign)
    tx.prospectOutreachCampaign.findUniqueOrThrow.mockResolvedValue(campaign)
    tx.prospectOutreachCampaign.updateMany.mockResolvedValue({ count: 1 })
    tx.prospectOutreachDraft.findUnique.mockResolvedValue(draft)
    tx.prospectOutreachDraft.findUniqueOrThrow.mockResolvedValue(draft)
  })
  it('refuses stale campaign state before any write', async () => {
    await expect(
      updateProspectCrmRecordAction(
        {
          actor,
          reason: 'Correct name',
          operationId: 'op',
          record: {
            type: 'campaign',
            campaignId: 'campaign',
            action: 'edit',
            expectedUpdatedAt: '2026-09-01T12:00:00Z',
            name: 'Changed',
          },
        },
        client,
      ),
    ).rejects.toThrow('changed')
    expect(tx.prospectOutreachCampaign.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })
  it('updates only requested campaign fields and persists durable original snapshot', async () => {
    await updateProspectCrmRecordAction(
      {
        actor,
        reason: 'Correct name',
        operationId: 'op',
        record: {
          type: 'campaign',
          campaignId: 'campaign',
          action: 'edit',
          expectedUpdatedAt: timestamp.toISOString(),
          name: 'Changed',
        },
      },
      client,
    )
    expect(tx.prospectOutreachCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'campaign', updatedAt: timestamp },
      data: { name: 'Changed', updatedBy: 'owner' },
    })
    expect(tx.auditLog.create.mock.calls[0]![0].data.beforeState.description).toBe(
      'Keep original description',
    )
  })
  it('retains selected cohort metadata when archiving without queuing any send', async () => {
    const result = await updateProspectCrmRecordAction(
      {
        actor,
        reason: 'Archive unused campaign',
        operationId: 'op',
        record: {
          type: 'campaign',
          campaignId: 'campaign',
          action: 'archive',
          expectedUpdatedAt: timestamp.toISOString(),
        },
      },
      client,
    )
    expect(result).toMatchObject({ status: 'PAUSED', archived: true })
    expect(
      tx.prospectOutreachCampaign.updateMany.mock.calls[0]![0].data.cohortSnapshot,
    ).toMatchObject({ selectedIds: ['org'], crmArchive: { archived: true } })
  })
  it('never discards queued/ambiguous draft content', async () => {
    await expect(
      updateProspectCrmRecordAction(
        {
          actor,
          reason: 'Discard',
          operationId: 'op',
          record: {
            type: 'draft',
            draftId: 'draft',
            action: 'discard',
            expectedVersion: 2,
            expectedContentHash: 'a'.repeat(64),
          },
        },
        client,
      ),
    ).rejects.toThrow('canonical cancellation')
    expect(tx.prospectOutreachDraft.updateMany).not.toHaveBeenCalled()
    expect(tx.prospectSendItem.updateMany).not.toHaveBeenCalled()
  })
  it('refuses member removal while an unsent draft remains', async () => {
    const member = { id: 'member', updatedAt: timestamp, status: 'DRAFTED' }
    tx.prospectCampaignMember.findUnique.mockResolvedValue(member)
    tx.prospectCampaignMember.findUniqueOrThrow.mockResolvedValue(member)
    tx.prospectSendItem.count.mockResolvedValue(0)
    tx.prospectOutreachDraft.count.mockResolvedValue(1)
    await expect(
      updateProspectCrmRecordAction(
        {
          actor,
          reason: 'Remove selection',
          operationId: 'op',
          record: {
            type: 'member',
            memberId: 'member',
            expectedUpdatedAt: timestamp.toISOString(),
            action: 'remove',
          },
        },
        client,
      ),
    ).rejects.toThrow('discard unsent drafts first')
    expect(tx.prospectCampaignMember.updateMany).not.toHaveBeenCalled()
  })
})
