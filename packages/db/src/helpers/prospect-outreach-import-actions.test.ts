import { describe, expect, it, vi } from 'vitest'
import type { db } from '../client'
import {
  appendProspectCampaignEmailSourceEvidenceAction,
  addSourcedProspectCampaignContactAction,
  importExistingProspectGmailDraftAction,
  isTerminalProspectOutreachImportRow,
  selectProspectCampaignContactRouteAction,
} from './prospect-outreach-import-actions'

function sourceEvidenceClient(existing: Array<Record<string, unknown>> = []) {
  const member = {
    id: 'member-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    contactId: 'contact-1',
    status: 'SELECTED',
    campaign: { status: 'DRAFT', pausedAt: null },
    organization: { archivedAt: null },
    venue: { id: 'venue-1', archivedAt: null },
    contact: { id: 'contact-1', organizationId: 'org-1', venueId: 'venue-1', archivedAt: null },
    drafts: [],
    sendItems: [],
  }
  const tx = {
    prospectCampaignMember: { findUnique: vi.fn(async () => member) },
    prospectDuplicateCandidate: { findFirst: vi.fn(async () => null) },
    prospectSourceEvidence: {
      findMany: vi.fn(async () => existing),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'source-1',
        sourceUrl: data.sourceUrl,
        capturedValue: data.capturedValue,
      })),
    },
    prospectActivity: { create: vi.fn(async () => ({ id: 'activity-1' })) },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  }
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as typeof db
  return { client, tx, member }
}

describe('appendProspectCampaignEmailSourceEvidenceAction', () => {
  const input = {
    memberId: 'member-1',
    email: ' INFO@VENUE.COM ',
    sourceUrl: 'https://www.venue.com/contact#team',
    actor: admin,
  }
  it('appends review-only public page evidence with audit and activity', async () => {
    const { client, tx } = sourceEvidenceClient()
    const result = await appendProspectCampaignEmailSourceEvidenceAction(input, client)
    expect(result).toMatchObject({
      id: 'source-1',
      idempotent: false,
      sourceUrl: 'https://www.venue.com/contact',
    })
    expect(result.capturedValue).toEqual({
      email: 'info@venue.com',
      sourcePage: 'https://www.venue.com/contact',
      captureMethod: 'operator_supplied',
      emailVerified: false,
      permissionApproved: false,
    })
    expect(tx.prospectSourceEvidence.create).toHaveBeenCalledOnce()
    expect(tx.prospectActivity.create).toHaveBeenCalledOnce()
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('returns the same evidence ID on an exact retry without creating a second row', async () => {
    const capturedValue = {
      email: 'info@venue.com',
      sourcePage: 'https://www.venue.com/contact',
      captureMethod: 'operator_supplied',
      emailVerified: false,
      permissionApproved: false,
    }
    const { client, tx } = sourceEvidenceClient([
      { id: 'source-existing', sourceUrl: 'https://www.venue.com/contact', capturedValue },
    ])
    const result = await appendProspectCampaignEmailSourceEvidenceAction(input, client)
    expect(result).toMatchObject({ id: 'source-existing', idempotent: true })
    expect(tx.prospectSourceEvidence.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('holds evidence append when organization identity is unresolved', async () => {
    const { client, tx } = sourceEvidenceClient()
    vi.mocked(tx.prospectDuplicateCandidate.findFirst).mockResolvedValueOnce({
      id: 'duplicate-1',
    } as never)
    await expect(appendProspectCampaignEmailSourceEvidenceAction(input, client)).rejects.toThrow(
      /identity or alias/u,
    )
    expect(tx.prospectSourceEvidence.create).not.toHaveBeenCalled()
  })

  it('rejects private, local, credential-bearing, and non-HTTPS URLs before database access', async () => {
    for (const sourceUrl of [
      'http://www.venue.com/contact',
      'https://127.0.0.1/contact',
      'https://192.168.1.5/contact',
      'https://localhost/contact',
      'https://user:pass@www.venue.com/contact',
    ]) {
      const { client, tx } = sourceEvidenceClient()
      await expect(
        appendProspectCampaignEmailSourceEvidenceAction({ ...input, sourceUrl }, client),
      ).rejects.toThrow(/public HTTPS/u)
      expect(tx.prospectCampaignMember.findUnique).not.toHaveBeenCalled()
    }
  })
})

const admin = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function contactRouteClient(overrides: Record<string, unknown> = {}) {
  const member = {
    id: 'member-1',
    campaignId: 'campaign-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    contactId: 'named-contact-1',
    status: 'SELECTED',
    campaign: { status: 'DRAFT', pausedAt: null },
    organization: { archivedAt: null },
    venue: { id: 'venue-1', archivedAt: null },
    drafts: [],
    sendItems: [],
  }
  const tx = {
    prospectCampaignMember: {
      findUnique: vi.fn(async () => member),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    prospectSourceEvidence: {
      findUnique: vi.fn(async () => ({
        id: 'evidence-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        contactId: null,
        sourceUrl: 'https://venue.example/contact',
        sourceType: 'WEBSITE',
        capturedValue: { email: 'info@venue.example' },
      })),
      findMany: vi.fn(async () => [
        {
          id: 'evidence-1',
          sourceUrl: 'https://venue.example/contact',
          capturedValue: { email: 'info@venue.example' },
        },
      ]),
    },
    prospectContact: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({
        id: 'new-contact-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        archivedAt: null,
        normalizedEmail: 'info@venue.example',
        emailReadiness: 'REVIEW_REQUIRED',
        permissionState: 'REVIEW_REQUIRED',
        sources: [{ id: 'evidence-1', organizationId: 'org-1', venueId: 'venue-1' }],
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-contact-1',
        ...data,
      })),
    },
    prospectDuplicateCandidate: { findFirst: vi.fn(async () => null) },
    prospectActivity: { create: vi.fn(async () => ({ id: 'activity-1' })) },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
    ...overrides,
  }
  const client = {
    $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as typeof db
  return { client, tx, member }
}

describe('importExistingProspectGmailDraftAction', () => {
  it('adds only an exact same-venue sourced email with no permission approval', async () => {
    const { client, tx } = contactRouteClient()
    const contact = await addSourcedProspectCampaignContactAction(
      {
        memberId: 'member-1',
        email: 'INFO@VENUE.EXAMPLE',
        sourceEvidenceId: 'evidence-1',
        actor: admin,
      },
      client,
    )
    expect(contact).toMatchObject({
      email: 'info@venue.example',
      normalizedEmail: 'info@venue.example',
      emailReadiness: 'REVIEW_REQUIRED',
      permissionState: 'REVIEW_REQUIRED',
      permissionEvidence: { sourceEvidenceId: 'evidence-1', approvalGranted: false },
    })
    expect(tx.prospectContact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        venueId: 'venue-1',
        source: 'SOURCE_EVIDENCE:evidence-1',
      }),
    })
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('rejects case-insensitive duplicate addresses before creating a contact', async () => {
    const { client, tx } = contactRouteClient()
    vi.mocked(tx.prospectContact.findFirst).mockResolvedValueOnce({ id: 'existing' } as never)
    await expect(
      addSourcedProspectCampaignContactAction(
        {
          memberId: 'member-1',
          email: 'info@venue.example',
          sourceEvidenceId: 'evidence-1',
          actor: admin,
        },
        client,
      ),
    ).rejects.toThrow(/already has that email route/u)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('recovers the same retained contact after an uncertain exact save without adding another', async () => {
    const { client, tx } = contactRouteClient()
    const retained = {
      id: 'retained-contact-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      fullName: null,
      title: null,
      email: 'info@venue.example',
      normalizedEmail: 'info@venue.example',
      archivedAt: null,
      source: 'SOURCE_EVIDENCE:evidence-1',
      provenance: [{ evidenceId: 'evidence-1', sourceUrl: 'https://venue.example/contact' }],
      permissionEvidence: { sourceEvidenceId: 'evidence-1', approvalGranted: false },
      emailReadiness: 'REVIEW_REQUIRED',
      permissionState: 'REVIEW_REQUIRED',
      doNotContact: false,
      suppressedAt: null,
      unsubscribedAt: null,
      complainedAt: null,
      lastHardBounceAt: null,
    }
    vi.mocked(tx.prospectContact.findFirst).mockResolvedValueOnce(retained as never)
    const result = await addSourcedProspectCampaignContactAction(
      {
        memberId: 'member-1',
        email: 'INFO@VENUE.EXAMPLE',
        sourceEvidenceId: 'evidence-1',
        actor: admin,
      },
      client,
    )
    expect(result).toEqual(retained)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
    expect(tx.prospectActivity.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('never recovers an unrelated or suppressed contact as an exact retry', async () => {
    const { client, tx } = contactRouteClient()
    vi.mocked(tx.prospectContact.findFirst).mockResolvedValueOnce({
      id: 'other-contact',
      venueId: 'venue-1',
      source: 'SOURCE_EVIDENCE:evidence-1',
      provenance: [{ evidenceId: 'evidence-1', sourceUrl: 'https://venue.example/contact' }],
      permissionEvidence: { sourceEvidenceId: 'evidence-1', approvalGranted: false },
      emailReadiness: 'REVIEW_REQUIRED',
      permissionState: 'REVIEW_REQUIRED',
      doNotContact: true,
    } as never)
    await expect(
      addSourcedProspectCampaignContactAction(
        {
          memberId: 'member-1',
          email: 'info@venue.example',
          sourceEvidenceId: 'evidence-1',
          actor: admin,
        },
        client,
      ),
    ).rejects.toThrow(/already has that email route/u)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('rejects source evidence for a different venue or a different email', async () => {
    const { client, tx } = contactRouteClient()
    const sourceRead = tx.prospectSourceEvidence.findUnique
    sourceRead.mockResolvedValueOnce({
      id: 'evidence-1',
      organizationId: 'org-1',
      venueId: 'venue-elsewhere',
      contactId: null,
      sourceUrl: 'https://venue.example/contact',
      sourceType: 'WEBSITE',
      capturedValue: { email: 'info@venue.example' },
    } as never)
    await expect(
      addSourcedProspectCampaignContactAction(
        {
          memberId: 'member-1',
          email: 'info@venue.example',
          sourceEvidenceId: 'evidence-1',
          actor: admin,
        },
        client,
      ),
    ).rejects.toThrow(/exact contact email/u)
    sourceRead.mockResolvedValueOnce({
      id: 'evidence-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: null,
      sourceUrl: 'https://venue.example/contact',
      sourceType: 'WEBSITE',
      capturedValue: { email: 'other@venue.example' },
    } as never)
    await expect(
      addSourcedProspectCampaignContactAction(
        {
          memberId: 'member-1',
          email: 'info@venue.example',
          sourceEvidenceId: 'evidence-1',
          actor: admin,
        },
        client,
      ),
    ).rejects.toThrow(/exact contact email/u)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('holds contact creation when the organization has unresolved duplicate identity evidence', async () => {
    const { client, tx } = contactRouteClient()
    const duplicateRead = tx.prospectDuplicateCandidate.findFirst
    duplicateRead.mockResolvedValueOnce({ id: 'duplicate-1' } as never)
    await expect(
      addSourcedProspectCampaignContactAction(
        {
          memberId: 'member-1',
          email: 'info@venue.example',
          sourceEvidenceId: 'evidence-1',
          actor: admin,
        },
        client,
      ),
    ).rejects.toThrow(/identity or alias evidence/u)
    expect(tx.prospectContact.create).not.toHaveBeenCalled()
  })

  it('selects an exact sourced same-venue contact by changing only contactId on the same member', async () => {
    const { client, tx } = contactRouteClient()
    const result = await selectProspectCampaignContactRouteAction(
      { memberId: 'member-1', contactId: 'new-contact-1', actor: admin },
      client,
    )
    expect(result).toMatchObject({ changed: true, member: { id: 'member-1', status: 'SELECTED' } })
    expect(tx.prospectCampaignMember.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'member-1',
        status: 'SELECTED',
        campaign: { status: 'DRAFT', pausedAt: null },
        drafts: { none: {} },
        sendItems: { none: {} },
      },
      data: { contactId: 'new-contact-1' },
    })
    expect(tx.auditLog.create).toHaveBeenCalledOnce()
  })

  it('can select a newly appended contact by resolving its provenance to immutable evidence', async () => {
    const { client, tx } = contactRouteClient()
    const contact = await addSourcedProspectCampaignContactAction(
      {
        memberId: 'member-1',
        email: 'info@venue.example',
        sourceEvidenceId: 'evidence-1',
        actor: admin,
      },
      client,
    )
    tx.prospectContact.findUnique.mockResolvedValueOnce({
      ...contact,
      sources: [],
    } as never)
    const result = await selectProspectCampaignContactRouteAction(
      { memberId: 'member-1', contactId: contact.id, actor: admin },
      client,
    )
    expect(result).toMatchObject({ changed: true, member: { id: 'member-1' } })
    expect(tx.prospectSourceEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['evidence-1'] },
          organizationId: 'org-1',
          venueId: 'venue-1',
        }),
      }),
    )
    expect(tx.prospectCampaignMember.updateMany).toHaveBeenCalledOnce()
  })

  it('refuses to change drafted members', async () => {
    const { client, tx } = contactRouteClient()
    const member = tx.prospectCampaignMember.findUnique as unknown as ReturnType<typeof vi.fn>
    member.mockResolvedValueOnce({
      id: 'member-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      contactId: 'named-contact-1',
      status: 'SELECTED',
      campaign: { status: 'DRAFT', pausedAt: null },
      organization: { archivedAt: null },
      venue: { id: 'venue-1', archivedAt: null },
      drafts: [{ id: 'draft-1' }],
      sendItems: [],
    })
    await expect(
      selectProspectCampaignContactRouteAction(
        { memberId: 'member-1', contactId: 'new-contact-1', actor: admin },
        client,
      ),
    ).rejects.toThrow(/Only an undrafted selected member/u)
    expect(tx.prospectCampaignMember.updateMany).not.toHaveBeenCalled()
  })

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
