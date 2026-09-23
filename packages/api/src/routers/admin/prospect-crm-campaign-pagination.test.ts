import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  campaign: vi.fn(),
  members: vi.fn(),
  deliveries: vi.fn(),
  delivery: vi.fn(),
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    prospectOutreachCampaign: { findUnique: mocks.campaign },
    prospectCampaignMember: { findMany: mocks.members },
    prospectSendItem: { findMany: mocks.deliveries, findFirst: mocks.delivery },
  },
  withTenantIsolationBypass: mocks.bypass,
  PROSPECT_OUTREACH_RELEASE_POLICY: { maxRecipients: 50 },
  ProspectOutreachError: class ProspectOutreachError extends Error {},
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueProspectImportCommit: vi.fn(),
  enqueueProspectOutreach: vi.fn(),
}))
vi.mock('../../middleware/require-crm-prospect-outreach', () => ({
  requireCrmProspectOutreach: async ({ next }: { next: () => Promise<unknown> }) => next(),
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmOutreachRouter } from './prospect-crm-outreach'

const caller = router({ crm: adminProspectCrmOutreachRouter }).createCaller({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin: true },
})

function member(index: number) {
  return {
    id: `member-${index}`,
    createdAt: new Date(1_700_000_000_000 + index),
    drafts: [],
    organization: {},
    venue: null,
    contact: null,
  }
}

describe('prospect campaign detail pagination v2', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows selected attachment descriptors without returning frozen file bytes', async () => {
    const bytes = Buffer.from('<svg><path d="M0 0h1v1H0z"/></svg>')
    const asset = {
      schema: 'torchiko.venue-launch-asset/1',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release: { kind: 'LEGACY', id: 'release-1', revisionSha256: 'a'.repeat(64) },
      publicUrl: 'https://guide.torchiko.com/miniaturemuseum/chat?source=qr',
      filename: 'museum-qr.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    }
    mocks.campaign.mockResolvedValue({
      id: 'campaign-1',
      members: [
        {
          ...member(1),
          drafts: [{ id: 'draft-1', groundingSnapshot: { launchAttachments: [asset] } }],
        },
      ],
      sendBatches: [
        {
          id: 'batch-1',
          items: [{ id: 'item-1', headerSnapshot: { launchAttachments: [asset] } }],
        },
      ],
    })
    const result = await caller.crm.getProspectCampaign({ campaignId: 'campaign-1' })
    const draftAttachment = (
      result.members[0]?.drafts[0]?.groundingSnapshot as { launchAttachments: (typeof asset)[] }
    ).launchAttachments[0]
    const frozenAttachment = (
      result.sendBatches[0]?.items[0]?.headerSnapshot as { launchAttachments: (typeof asset)[] }
    ).launchAttachments[0]
    expect(draftAttachment).toMatchObject({ filename: asset.filename, sha256: asset.sha256 })
    expect(frozenAttachment).toMatchObject({ filename: asset.filename, sha256: asset.sha256 })
    expect(draftAttachment).not.toHaveProperty('contentBase64')
    expect(frozenAttachment).not.toHaveProperty('contentBase64')
  })

  it('bounds a 5,000-member campaign detail and omits frozen delivery bodies', async () => {
    const members = Array.from({ length: 5_000 }, (_, index) => member(index))
    expect(members).toHaveLength(5_000)
    mocks.campaign.mockImplementation(async (query) => ({
      id: 'campaign-1',
      members: members.slice(0, query.include.members.take),
      sendBatches: [
        {
          id: 'batch-1',
          items: Array.from(
            { length: query.include.sendBatches.include.items.take },
            (_, index) => ({
              id: `item-${index}`,
              createdAt: new Date(),
              subjectSnapshot: 'Subject',
              recipientEmailSnapshot: 'a@example.com',
              contentHashSnapshot: 'a'.repeat(64),
            }),
          ),
        },
      ],
    }))

    const result = await caller.crm.getProspectCampaign({ campaignId: 'campaign-1' })

    expect(result.detailVersion).toBe(2)
    expect(result.members).toHaveLength(50)
    expect(result.sendBatches[0]?.items).toHaveLength(50)
    expect(result.page).toMatchObject({ hasMoreMembers: true, memberLimit: 50, batchLimit: 20 })
    expect(result.sendBatches[0]?.page.hasMoreItems).toBe(true)
    expect(result.sendBatches[0]?.items[0]).not.toHaveProperty('textBodySnapshot')
    const query = mocks.campaign.mock.calls[0]?.[0]
    expect(query.include.members.take).toBe(51)
    expect(query.include.sendBatches.take).toBe(21)
    expect(query.include.sendBatches.include.items.take).toBe(51)
    expect(query.include.sendBatches.include.items.select).not.toHaveProperty('textBodySnapshot')
    expect(query.include.sendBatches.include.items.select).not.toHaveProperty('htmlBodySnapshot')
  })

  it('uses stable bounded cursors for members and deliveries', async () => {
    mocks.members.mockResolvedValue([member(1), member(2), member(3)])
    mocks.deliveries.mockResolvedValue([
      { id: 'delivery-3', createdAt: new Date('2026-09-03T00:00:00Z') },
      { id: 'delivery-2', createdAt: new Date('2026-09-02T00:00:00Z') },
      { id: 'delivery-1', createdAt: new Date('2026-09-01T00:00:00Z') },
    ])
    const memberPage = await caller.crm.listProspectCampaignMembers({
      campaignId: 'campaign-1',
      limit: 2,
    })
    const deliveryPage = await caller.crm.listProspectCampaignDeliveries({
      campaignId: 'campaign-1',
      limit: 2,
    })
    expect(memberPage.items).toHaveLength(2)
    expect(memberPage.nextCursor).toEqual({
      version: 2,
      campaignId: 'campaign-1',
      createdAt: member(2).createdAt.toISOString(),
      id: 'member-2',
    })
    expect(deliveryPage.items).toHaveLength(2)
    expect(deliveryPage.nextCursor).toEqual({
      version: 2,
      campaignId: 'campaign-1',
      createdAt: '2026-09-02T00:00:00.000Z',
      id: 'delivery-2',
    })
    expect(mocks.members.mock.calls[0]?.[0].take).toBe(3)
    expect(mocks.deliveries.mock.calls[0]?.[0].take).toBe(3)
  })

  it('uses the id tie-breaker and rejects a cursor from another campaign', async () => {
    const tiedAt = '2026-09-02T00:00:00.000Z'
    mocks.members.mockResolvedValue([])
    await caller.crm.listProspectCampaignMembers({
      campaignId: 'campaign-1',
      cursor: { version: 2, campaignId: 'campaign-1', createdAt: tiedAt, id: 'member-050' },
    })
    expect(mocks.members.mock.calls[0]?.[0].where.OR).toEqual([
      { createdAt: { gt: new Date(tiedAt) } },
      { createdAt: new Date(tiedAt), id: { gt: 'member-050' } },
    ])
    await expect(
      caller.crm.listProspectCampaignDeliveries({
        campaignId: 'campaign-2',
        cursor: { version: 2, campaignId: 'campaign-1', createdAt: tiedAt, id: 'delivery-050' },
      }),
    ).rejects.toThrow('Campaign cursor does not match this campaign')
    expect(mocks.deliveries).not.toHaveBeenCalled()
  })

  it('walks 5,000 tied-date members without duplicates or omissions', async () => {
    const createdAt = new Date('2026-09-02T00:00:00.000Z')
    const corpus = Array.from({ length: 5_000 }, (_, index) => ({
      ...member(index),
      id: `member-${String(index).padStart(4, '0')}`,
      createdAt,
    }))
    mocks.members.mockImplementation(async (query) => {
      const afterId = query.where.OR?.[1]?.id?.gt as string | undefined
      const start = afterId ? corpus.findIndex((row) => row.id === afterId) + 1 : 0
      return corpus.slice(start, start + query.take)
    })
    const loaded: string[] = []
    let cursor: { version: 2; campaignId: string; createdAt: string; id: string } | undefined
    do {
      const page = await caller.crm.listProspectCampaignMembers({
        campaignId: 'campaign-1',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      loaded.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(loaded).toHaveLength(5_000)
    expect(new Set(loaded).size).toBe(5_000)
    expect(loaded).toEqual(corpus.map((row) => row.id))
  })

  it('loads one full frozen body on demand within its campaign boundary', async () => {
    mocks.delivery.mockResolvedValue({
      id: 'item-1',
      contentHashSnapshot: 'a'.repeat(64),
      textBodySnapshot: 'Full body',
      htmlBodySnapshot: '<p>Full body</p>',
    })
    await expect(
      caller.crm.getProspectDeliveryMessageBody({ campaignId: 'campaign-1', sendItemId: 'item-1' }),
    ).resolves.toMatchObject({ detailVersion: 2, textBodySnapshot: 'Full body' })
    expect(mocks.delivery).toHaveBeenCalledWith({
      where: { id: 'item-1', batch: { campaignId: 'campaign-1' } },
      select: {
        id: true,
        contentHashSnapshot: true,
        headerSnapshot: true,
        textBodySnapshot: true,
        htmlBodySnapshot: true,
      },
    })
  })
})
