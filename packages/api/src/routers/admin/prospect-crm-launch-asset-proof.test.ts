import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  findMember: vi.fn(),
  linkDraft: vi.fn(),
  saveDraft: vi.fn(),
  selectAsset: vi.fn(),
  resolveProofs: vi.fn(),
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
}))

vi.mock('@pathfinder/db', () => ({
  db: { prospectCampaignMember: { findUnique: mocks.findMember } },
  withTenantIsolationBypass: mocks.bypass,
  linkExistingProspectGmailDraftAction: mocks.linkDraft,
  saveProspectOutreachDraftAction: mocks.saveDraft,
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
vi.mock('../../prospect-launch-assets', () => ({
  selectProspectLaunchAsset: mocks.selectAsset,
  resolveVerifiedCurrentPrintAssets: mocks.resolveProofs,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmOutreachRouter } from './prospect-crm-outreach'

const caller = router({ crm: adminProspectCrmOutreachRouter }).createCaller({
  db: {} as TRPCContext['db'],
  headers: new Headers(),
  session: { userId: 'admin-1', activeTenantId: null, role: null, isPlatformAdmin: true },
})

const pdfBytes = Buffer.from('%PDF-1.4 trusted fixture')
const pdfAsset = {
  schema: 'torchiko.venue-launch-asset/2',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  release: { kind: 'NATIVE', id: 'release-1', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://guide.example.com/venue/chat?source=qr',
  format: 'PDF',
  generatorVersion: 'qr-print-v1',
  filename: 'venue-qr.pdf',
  mimeType: 'application/pdf',
  sizeBytes: pdfBytes.length,
  sha256: createHash('sha256').update(pdfBytes).digest('hex'),
  contentBase64: pdfBytes.toString('base64'),
} as const
const selection = {
  tenantId: pdfAsset.tenantId,
  venueId: pdfAsset.venueId,
  release: pdfAsset.release,
  publicUrl: pdfAsset.publicUrl,
  sha256: pdfAsset.sha256,
  format: 'PDF' as const,
  generatorVersion: pdfAsset.generatorVersion,
}

describe('CRM launch attachment API trust boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findMember.mockResolvedValue({ venueId: 'prospect-venue-1' })
    mocks.selectAsset.mockResolvedValue(pdfAsset)
    mocks.resolveProofs.mockResolvedValue([
      { prospectVenueId: 'prospect-venue-1', asset: pdfAsset },
    ])
    mocks.saveDraft.mockImplementation(async (input) => ({
      id: 'draft-1',
      ...input,
    }))
    mocks.linkDraft.mockResolvedValue({ id: 'gmail-link-1' })
  })

  it('exposes exact Gmail draft linkage through the authenticated CRM outreach router', async () => {
    const input = {
      outreachDraftId: 'crm-draft-1',
      providerAccountId: 'gmail-account-1',
      providerDraftId: 'gmail-draft-1',
      providerMessageId: 'gmail-message-1',
      expectedContentHash: 'a'.repeat(64),
      historyReviewConfirmed: true as const,
    }
    await expect(caller.crm.linkExistingGmailDraft(input)).resolves.toEqual({ id: 'gmail-link-1' })
    expect(mocks.linkDraft).toHaveBeenCalledWith({
      ...input,
      actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
    })
    await expect(
      caller.crm.linkExistingGmailDraft({ ...input, expectedContentHash: 'bad' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.linkDraft).toHaveBeenCalledTimes(1)
  })

  it('resolves PDF bytes server-side from an exact selection and returns a descriptor only', async () => {
    const result = await caller.crm.saveProspectOutreachDraft({
      memberId: 'member-1',
      subject: 'Visit',
      textBody: 'Hello',
      groundingSnapshot: { evidence: [] },
      launchAssetSelection: selection,
    })

    expect(mocks.selectAsset).toHaveBeenCalledWith('prospect-venue-1', selection)
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        groundingSnapshot: { evidence: [], launchAttachments: [pdfAsset] },
        verifiedCurrentPrintAssets: [{ prospectVenueId: 'prospect-venue-1', asset: pdfAsset }],
      }),
    )
    const snapshot = result.groundingSnapshot as { launchAttachments: unknown[] } | null
    expect(snapshot?.launchAttachments[0]).not.toHaveProperty('contentBase64')
  })

  it('passes bounded source evidence IDs to the scoped draft persistence action', async () => {
    const sourceEvidenceIds = ['evidence-1', 'evidence-2']

    await caller.crm.saveProspectOutreachDraft({
      memberId: 'member-1',
      subject: 'Visit',
      textBody: 'Hello',
      groundingSnapshot: { evidence: [] },
      sourceEvidenceIds,
    })

    expect(mocks.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceEvidenceIds }))
  })

  it('rejects empty or excessive source evidence selections before persistence', async () => {
    const input = {
      memberId: 'member-1',
      subject: 'Visit',
      textBody: 'Hello',
      groundingSnapshot: { evidence: [] },
    }

    await expect(
      caller.crm.saveProspectOutreachDraft({ ...input, sourceEvidenceIds: [] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.crm.saveProspectOutreachDraft({
        ...input,
        sourceEvidenceIds: Array.from({ length: 21 }, (_, index) => `evidence-${index}`),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied attachment bytes instead of treating them as proof', async () => {
    await expect(
      caller.crm.saveProspectOutreachDraft({
        memberId: 'member-1',
        subject: 'Visit',
        textBody: 'Hello',
        groundingSnapshot: { evidence: [], launchAttachments: [pdfAsset] },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.saveDraft).not.toHaveBeenCalled()
    expect(mocks.selectAsset).not.toHaveBeenCalled()
  })
})
