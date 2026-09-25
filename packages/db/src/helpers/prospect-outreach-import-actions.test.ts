import { describe, expect, it, vi } from 'vitest'
import type { db } from '../client'
import {
  importExistingProspectGmailDraftAction,
  isTerminalProspectOutreachImportRow,
} from './prospect-outreach-import-actions'

describe('importExistingProspectGmailDraftAction', () => {
  it('admits only imported rows from a fully reconciled terminal import', () => {
    expect(
      isTerminalProspectOutreachImportRow({
        status: 'IMPORTED',
        import: { status: 'COMPLETE', failedRows: 0, duplicateRows: 0 },
      }),
    ).toBe(true)
    expect(
      isTerminalProspectOutreachImportRow({
        status: 'IMPORTED',
        import: { status: 'PROCESSING', failedRows: 0, duplicateRows: 0 },
      }),
    ).toBe(false)
    expect(
      isTerminalProspectOutreachImportRow({
        status: 'IMPORTED',
        import: { status: 'COMPLETE', failedRows: 0, duplicateRows: 1 },
      }),
    ).toBe(false)
    expect(isTerminalProspectOutreachImportRow(null)).toBe(false)
  })

  it('holds until the connected business mailbox has completed full history reconciliation', async () => {
    const accountRead = vi.fn(async () => ({
      id: 'account-1',
      provider: 'GMAIL',
      connectionStatus: 'CONNECTED',
      mailboxAddress: 'tomschoenekase@torchiko.com',
      credentialReferenceId: 'credential-ref',
      lastReconciliationAt: null,
    }))
    const tx = {
      correspondenceProviderAccount: { findUnique: accountRead },
      prospectOutreachDraftGmailLink: { findUnique: vi.fn(async () => null) },
    }
    const client = {
      $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as unknown as typeof db
    await expect(
      importExistingProspectGmailDraftAction(
        {
          memberId: 'member-1',
          providerAccountId: 'account-1',
          providerDraftId: 'stable-draft-1',
          providerMessageId: 'current-message-1',
          fromEmail: 'tomschoenekase@torchiko.com',
          toEmail: 'guest@example.org',
          subject: 'Torchiko at Venue',
          textBody: 'Hello there.',
          historyReviewConfirmed: true,
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
        },
        client,
      ),
    ).rejects.toThrow(/completed mailbox reconciliation/u)
    expect(accountRead).toHaveBeenCalledOnce()
  })

  it('saves an unsendable review draft for a review-required contact and reopens it on retry', async () => {
    const member = {
      id: 'member-1',
      campaignId: 'campaign-1',
      organizationId: 'organization-1',
      venueId: 'venue-1',
      contactId: 'contact-1',
      status: 'SELECTED',
      drafts: [],
      campaign: { status: 'DRAFT', pausedAt: null },
      organization: {
        archivedAt: null,
        relationshipTier: 'STANDARD',
        opportunity: { stage: 'RESEARCHED' },
      },
      venue: { id: 'venue-1', archivedAt: null, sourceImportRowId: 'source-row-1' },
      contact: {
        id: 'contact-1',
        organizationId: 'organization-1',
        venueId: 'venue-1',
        archivedAt: null,
        normalizedEmail: 'guest@example.org',
        doNotContact: false,
        emailReadiness: 'REVIEW_REQUIRED',
        permissionState: 'REVIEW_REQUIRED',
        sourceImportRowId: 'source-row-1',
        suppressedAt: null,
        unsubscribedAt: null,
        complainedAt: null,
        lastHardBounceAt: null,
        lastSoftBounceAt: null,
      },
    }
    let existingLink: unknown = null
    const draftCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'crm-draft-1',
      ...data,
    }))
    const linkCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const draft = draftCreate.mock.results[0]?.value
      existingLink = {
        id: 'gmail-link-1',
        ...data,
        outreachDraft: await draft,
      }
      return existingLink
    })
    const memberUpdate = vi.fn(async () => ({ id: 'member-1', status: 'DRAFTED' }))
    const auditCreate = vi.fn(async () => ({ id: 'audit-1' }))
    const tx = {
      prospectOutreachDraftGmailLink: {
        findUnique: vi.fn(async () => existingLink),
        create: linkCreate,
      },
      correspondenceProviderAccount: {
        findUnique: vi.fn(async () => ({
          provider: 'GMAIL',
          connectionStatus: 'CONNECTED',
          mailboxAddress: 'tomschoenekase@torchiko.com',
          credentialReferenceId: 'credential-1',
          lastReconciliationAt: new Date('2026-09-25T05:00:00Z'),
        })),
      },
      prospectCampaignMember: { findUnique: vi.fn(async () => member), update: memberUpdate },
      prospectDuplicateCandidate: { findFirst: vi.fn(async () => null) },
      prospectEmailMessage: { findFirst: vi.fn(async () => null) },
      prospectCustomerRelationship: { findFirst: vi.fn(async () => null) },
      prospectImportRow: {
        findUnique: vi.fn(async () => ({
          status: 'IMPORTED',
          import: { status: 'PARTIAL', failedRows: 0, duplicateRows: 0 },
        })),
      },
      prospectOutreachDraft: { create: draftCreate },
      prospectActivity: { create: vi.fn(async () => ({ id: 'activity-1' })) },
      auditLog: { create: auditCreate },
    }
    const client = {
      $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as unknown as typeof db
    const input = {
      memberId: 'member-1',
      providerAccountId: 'account-1',
      providerDraftId: 'stable-draft-1',
      providerMessageId: 'current-message-1',
      fromEmail: 'tomschoenekase@torchiko.com',
      toEmail: 'guest@example.org',
      subject: 'Torchiko at Venue',
      textBody: ' Hello there.\n',
      htmlBody: '<p>Hello there.</p>',
      historyReviewConfirmed: true as const,
      actor: { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const },
    }
    member.contact.permissionState = 'OPTED_OUT'
    await expect(importExistingProspectGmailDraftAction(input, client)).rejects.toMatchObject({
      code: 'SUPPRESSED',
    })
    expect(draftCreate).not.toHaveBeenCalled()
    member.contact.permissionState = 'REVIEW_REQUIRED'

    const first = await importExistingProspectGmailDraftAction(input, client)
    expect(first.idempotent).toBe(false)
    expect(first.draft.status).toBe('NEEDS_REVIEW')
    expect(first.draft.textBody).toBe(' Hello there.\n')
    expect(first.link.providerDraftId).toBe('stable-draft-1')
    expect(draftCreate).toHaveBeenCalledOnce()
    expect(linkCreate).toHaveBeenCalledOnce()
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 'member-1' },
      data: { status: 'DRAFTED' },
    })
    expect(auditCreate).toHaveBeenCalledOnce()

    const retried = await importExistingProspectGmailDraftAction(
      { ...input, providerMessageId: 'rotated-message-2' },
      client,
    )
    expect(retried.idempotent).toBe(true)
    expect(retried.messageIdDrifted).toBe(true)
    expect(retried.draft.id).toBe(first.draft.id)
    expect(draftCreate).toHaveBeenCalledOnce()
    expect(linkCreate).toHaveBeenCalledOnce()
    expect(auditCreate).toHaveBeenCalledOnce()
  })
})
