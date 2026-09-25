/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProspectCampaignWorkbench } from './ProspectCampaignWorkbench'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  queue: vi.fn(),
  campaign: vi.fn(),
  deliveryBody: vi.fn(),
  members: vi.fn(),
  deliveries: vi.fn(),
  readiness: vi.fn(),
  rehearsal: vi.fn(),
  gmailLink: vi.fn(),
  gmailImport: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => {
  const client = {
    admin: {
      approveProspectSendBatch: { mutate: mocks.approve },
      queueProspectSendBatch: { mutate: mocks.queue },
      getProspectCampaign: { query: mocks.campaign },
      getProspectDeliveryMessageBody: { query: mocks.deliveryBody },
      listProspectCampaignMembers: { query: mocks.members },
      listProspectCampaignDeliveries: { query: mocks.deliveries },
      getProspectOutreachReadiness: { query: mocks.readiness },
      getProspectNoSendRehearsal: { query: mocks.rehearsal },
      saveProspectOutreachDraft: { mutate: vi.fn() },
      linkExistingGmailDraft: { mutate: mocks.gmailLink },
      importExistingGmailDraft: { mutate: mocks.gmailImport },
      reviewProspectOutreachDraft: { mutate: vi.fn() },
      stageProspectSendBatch: { mutate: vi.fn() },
    },
  }
  return { useTRPCClient: () => client }
})

const frozenItem = {
  id: 'item-1',
  status: 'STAGED',
  recipientEmailSnapshot: 'internal@example.com',
  subjectSnapshot: 'Exact frozen subject',
  textBodySnapshot: 'Exact frozen body',
  htmlBodySnapshot: null,
  contentHashSnapshot: 'c'.repeat(64),
  headerSnapshot: {
    launchAttachments: [
      {
        filename: 'miniature-museum-visitor-qr.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 170361,
        publicUrl: 'https://guide.torchiko.com/miniaturemuseum/chat?source=qr',
        sha256: 'd'.repeat(64),
      },
    ],
  },
  providerAccountId: null,
  providerMessageId: null,
}

function fixture(batchStatus: 'STAGED' | 'APPROVED') {
  return {
    campaign: {
      id: 'campaign-1',
      name: 'Internal fixture campaign',
      status: 'DRAFT',
      playbookVersion: 'fixture-v1',
      members: [],
      page: { hasMoreMembers: false, hasMoreBatches: false, memberLimit: 50, batchLimit: 20 },
      sendBatches: [
        {
          id: 'batch-1',
          status: batchStatus,
          recipientCount: 1,
          snapshotHash: 'a'.repeat(64),
          items: [frozenItem],
          _count: { items: 1 },
        },
      ],
    } as never,
    readiness: {
      deliveryEnabled: true,
      internalOnly: true,
      providerConfigured: true,
      provider: 'GMAIL',
      accounts: [
        {
          id: 'mailbox-1',
          mailboxAddress: 'outreach@torchiko.com',
          connectionStatus: 'CONNECTED',
          deliveryEnabled: true,
          pausedAt: null,
          lastSuccessfulSyncAt: new Date('2026-08-20T12:00:00Z'),
          lastReconciliationAt: new Date('2026-08-20T12:05:00Z'),
          watchExpiration: new Date('2026-08-21T12:00:00Z'),
          healthErrorCode: null,
          healthErrorSummary: null,
        },
      ],
      limits: { cohort: 5000, technicalBatch: 500, activeRelease: 50 },
      policy: {
        agentsMayDraft: true,
        agentsMayApprove: false,
        agentsMaySend: false,
        release: {
          phase: 'INITIAL_CANARY',
          maxRecipients: 50,
          nextPhase: 'EVALUATED_CANARY',
          nextPhaseMaxRecipients: 100,
          promotionStatus: 'NOT_AUTHORIZED',
          promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE',
        },
      },
    } as never,
    rehearsal: {
      campaignId: 'campaign-1',
      generatedAt: new Date('2026-08-26T04:00:00Z'),
      mode: 'NO_SEND_REHEARSAL',
      outcome: 'READY_FOR_HUMAN_REVIEW',
      readyForHumanReview: true,
      readyToSend: false,
      blockers: [],
      safety: {
        deliveryDark: true,
        processDeliveryEnabled: false,
        globalDeliveryEnabled: false,
        internalOnly: true,
        emergencyStopAvailable: true,
        emergencyStopDirection: 'DISABLE_ONLY',
        providerRequired: false,
        providerCallsMade: 0,
        estimatedProviderCostUsd: 0,
      },
      releasePolicy: {
        phase: 'INITIAL_CANARY',
        maxRecipients: 50,
        nextPhase: 'EVALUATED_CANARY',
        nextPhaseMaxRecipients: 100,
        promotionStatus: 'NOT_AUTHORIZED',
        promotionRequirement: 'REVIEWED_EVIDENCE_AND_CODE_CHANGE',
      },
      cohort: {
        memberCount: 1,
        maxCohort: 5000,
        technicalMaxBatch: 500,
        activeReleaseLimit: 50,
        bounded: true,
        withinActiveReleaseLimit: true,
        unsafeMemberCount: 0,
        missingProvenanceCount: 0,
        duplicateMemberEmailCount: 0,
        openOrganizationDuplicateCount: 0,
      },
      review: {
        missingDraftCount: 0,
        draftsNeedingReviewCount: 1,
        approvedDraftCount: 0,
        approvalEvidenceMissingCount: 0,
      },
      frozenSnapshots: {
        activeBatchCount: 1,
        recipientCount: 1,
        invalidBatchCount: 0,
        duplicateEmailCount: 0,
        duplicateIdentityCount: 0,
        identities: [
          {
            batchId: 'batch-1',
            status: batchStatus,
            recipientCount: 1,
            snapshotHash: 'a'.repeat(64),
          },
        ],
      },
      campaign: { status: 'DRAFT', paused: false },
    } as never,
  }
}

describe('ProspectCampaignWorkbench release safety', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('links one exact Gmail draft and message ID pair to the current CRM version', async () => {
    const state = fixture('STAGED')
    ;(
      state.readiness as unknown as { accounts: { mailboxAddress: string }[] }
    ).accounts[0]!.mailboxAddress = 'tomschoenekase@torchiko.com'
    const draft = {
      id: 'crm-draft-1',
      version: 1,
      status: 'NEEDS_REVIEW',
      subject: 'Torchiko at Example Museum',
      textBody: 'A verified draft body',
      contentHash: 'a'.repeat(64),
      groundingSnapshot: {},
      escalationFlags: [],
      gmailLink: null,
    }
    ;(state.campaign as unknown as { members: unknown[] }).members = [
      {
        id: 'member-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        status: 'DRAFTED',
        organization: {
          canonicalName: 'Example Museum',
          relationshipTier: 'STANDARD',
          priority: 'NORMAL',
        },
        venue: { name: 'Example Museum', city: 'Chicago', region: 'IL' },
        contact: { fullName: null, email: 'hello@example.org', doNotContact: false },
        drafts: [draft],
      },
    ]
    mocks.gmailLink.mockResolvedValue({ id: 'link-1' })
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={state} />)

    fireEvent.click(screen.getByRole('button', { name: 'Link existing Gmail draft' }))
    fireEvent.change(screen.getByLabelText('Gmail draft ID'), { target: { value: 'draft-abc' } })
    fireEvent.change(screen.getByLabelText('Gmail message ID'), {
      target: { value: 'message-def' },
    })
    fireEvent.click(
      screen.getByLabelText(
        'I personally reviewed this Gmail draft and searched both mailboxes for prior correspondence (operator attestation only).',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Link these IDs' }))

    await waitFor(() =>
      expect(mocks.gmailLink).toHaveBeenCalledWith({
        outreachDraftId: 'crm-draft-1',
        providerAccountId: 'mailbox-1',
        providerDraftId: 'draft-abc',
        providerMessageId: 'message-def',
        expectedContentHash: 'a'.repeat(64),
        historyReviewConfirmed: true,
      }),
    )
    expect(await screen.findByText(/UNVERIFIED association\. Nothing was sent/u)).toBeTruthy()
  })

  it('imports one existing Gmail draft by stable ID after an explicit history review', async () => {
    const state = fixture('STAGED')
    ;(
      state.readiness as unknown as { accounts: { mailboxAddress: string }[] }
    ).accounts[0]!.mailboxAddress = 'tomschoenekase@torchiko.com'
    ;(state.campaign as unknown as { members: unknown[] }).members = [
      {
        id: 'member-import-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        status: 'SELECTED',
        organization: {
          canonicalName: 'Example Garden',
          relationshipTier: 'STANDARD',
          priority: 'NORMAL',
        },
        venue: { name: 'Example Garden', city: 'Chicago', region: 'IL' },
        contact: { fullName: null, email: 'hello@example.org', doNotContact: false },
        drafts: [],
      },
    ]
    mocks.gmailImport.mockResolvedValue({ draft: { version: 1 } })
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import existing Gmail draft' }))
    fireEvent.change(screen.getByLabelText('Stable Gmail draft ID'), {
      target: { value: 'stable-draft-1' },
    })
    fireEvent.click(
      screen.getByLabelText(
        'I reviewed both business and personal mailboxes and aliases for earlier contact with this venue.',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Read and import for review' }))
    await waitFor(() =>
      expect(mocks.gmailImport).toHaveBeenCalledWith({
        memberId: 'member-import-1',
        providerAccountId: 'mailbox-1',
        providerDraftId: 'stable-draft-1',
        historyReviewConfirmed: true,
      }),
    )
    expect(
      await screen.findByText(/Gmail draft imported into CRM as version 1 for review/u),
    ).toBeTruthy()
  })

  it('shows the exact frozen recipient/content and keeps approval separate from release', async () => {
    mocks.deliveryBody.mockResolvedValue({ textBodySnapshot: 'Exact frozen body' })
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)

    fireEvent.click(screen.getByText('Inspect exact frozen recipients and content'))
    expect(screen.getByText('To: internal@example.com')).toBeTruthy()
    expect(screen.getByText('Exact frozen subject')).toBeTruthy()
    expect(screen.getByText(/Frozen attachment: miniature-museum-visitor-qr\.pdf/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load full frozen message' }))
    expect(await screen.findByText('Exact frozen body')).toBeTruthy()
    expect(mocks.deliveryBody).toHaveBeenCalledWith(
      { campaignId: 'campaign-1', sendItemId: 'item-1', detailVersion: 2 },
      { signal: expect.any(AbortSignal) },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve exact batch' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Approve this exact frozen batch?')).toBeTruthy()
    expect(within(dialog).getByText('internal@example.com')).toBeTruthy()
    expect(within(dialog).getByText(/Exact count: 1/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /do not send/i })).toBeTruthy()
  })

  it('shows a recoverable error when a frozen-message read exceeds its deadline', async () => {
    vi.useFakeTimers()
    mocks.deliveryBody.mockImplementationOnce(() => new Promise(() => undefined))
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load full frozen message' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001)
    })
    expect(screen.getByText(/frozen message could not be loaded/i)).toBeTruthy()
    vi.useRealTimers()
  })

  it('shows a zero-cost rehearsal that cannot authorize sending', () => {
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)

    expect(screen.getByText('Ready for human review — never ready to send')).toBeTruthy()
    expect(screen.getByText(/made 0 provider calls and cost \$0.00/i)).toBeTruthy()
    expect(screen.getByText(/Emergency stop: disable only/i)).toBeTruthy()
    expect(screen.getByText(/Initial canary: at most 50 recipients/i)).toBeTruthy()
    expect(screen.getByText(/moving to 100 requires reviewed evidence/i)).toBeTruthy()
  })

  it('moves focus into the confirmation, traps it, and closes on Escape', async () => {
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact batch' }))

    const close = screen.getByRole('button', { name: 'Close confirmation' })
    await waitFor(() => expect(document.activeElement).toBe(close))
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /do not send/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('requires a selected Gmail account and passes it to final release', async () => {
    mocks.queue.mockResolvedValue({ pendingDispatch: 1, dispatched: 0 })
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('APPROVED')} />)

    await waitFor(() =>
      expect((screen.getByLabelText('Connected Gmail mailbox') as HTMLSelectElement).value).toBe(
        'mailbox-1',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(screen.getByText('Gmail mailbox: outreach@torchiko.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Release 1 through Gmail/i }))

    await waitFor(() =>
      expect(mocks.queue).toHaveBeenCalledWith({
        batchId: 'batch-1',
        expectedRecipientCount: 1,
        expectedSnapshotHash: 'a'.repeat(64),
        providerAccountId: 'mailbox-1',
      }),
    )
  })

  it('has no automated accessibility violations with the confirmation open', async () => {
    const { container } = render(
      <ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact batch' }))
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('loads all campaign evidence through cancellable transports', async () => {
    const state = fixture('STAGED')
    mocks.campaign.mockResolvedValueOnce(state.campaign)
    mocks.readiness.mockResolvedValueOnce(state.readiness)
    mocks.rehearsal.mockResolvedValueOnce(state.rehearsal)

    render(<ProspectCampaignWorkbench campaignId="campaign-1" />)
    expect(await screen.findByText('Internal fixture campaign')).toBeTruthy()
    expect(mocks.campaign).toHaveBeenCalledWith(
      { campaignId: 'campaign-1' },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.readiness).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.rehearsal).toHaveBeenCalledWith(
      { campaignId: 'campaign-1' },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('loads recipient and delivery pages while retaining explicit draft selection', async () => {
    const state = fixture('STAGED')
    const firstMember = {
      id: 'member-1',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      status: 'READY',
      organization: { canonicalName: 'First museum', relationshipTier: 'NEW', priority: 1 },
      venue: null,
      contact: { fullName: 'One', email: 'one@example.com', doNotContact: false },
      drafts: [
        {
          id: 'draft-1',
          version: 1,
          status: 'APPROVED',
          subject: 'One',
          textBody: 'One',
          escalationFlags: [],
        },
      ],
    }
    const campaign = state.campaign as unknown as {
      members: (typeof firstMember)[]
      page: {
        hasMoreMembers: boolean
        hasMoreBatches: boolean
        memberLimit: number
        batchLimit: number
      }
    }
    campaign.members = [firstMember]
    campaign.page = { ...campaign.page, hasMoreMembers: true }
    const memberPage = {
      detailVersion: 2,
      items: [
        {
          ...firstMember,
          id: 'member-2',
          organization: { ...firstMember.organization, canonicalName: 'Second museum' },
          drafts: [{ ...firstMember.drafts[0], id: 'draft-2' }],
        },
      ],
      nextCursor: null,
    }
    const deliveryPage = {
      detailVersion: 2,
      items: [
        {
          ...frozenItem,
          id: 'delivery-item-2',
          subjectSnapshot: 'Newly loaded delivery subject',
          batchId: 'batch-1',
          createdAt: new Date('2026-09-01T00:00:00Z'),
        },
      ],
      nextCursor: null,
    }
    let resolveMembers!: (page: typeof memberPage) => void
    let resolveDeliveries!: (page: typeof deliveryPage) => void
    mocks.members.mockReturnValueOnce(
      new Promise<typeof memberPage>((resolve) => {
        resolveMembers = resolve
      }),
    )
    mocks.deliveries.mockReturnValueOnce(
      new Promise<typeof deliveryPage>((resolve) => {
        resolveDeliveries = resolve
      }),
    )

    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={state} />)
    fireEvent.click(screen.getByLabelText('Include in batch'))
    fireEvent.click(screen.getByRole('button', { name: 'Load more recipients' }))
    await waitFor(() =>
      expect(mocks.members).toHaveBeenCalledWith(
        {
          campaignId: 'campaign-1',
          cursor: {
            version: 2,
            campaignId: 'campaign-1',
            createdAt: '2026-09-01T00:00:00.000Z',
            id: 'member-1',
          },
          detailVersion: 2,
        },
        { signal: expect.any(AbortSignal) },
      ),
    )

    // Existing content does not prove that the pending member page has finished.
    expect(screen.getByText('First museum', { selector: 'h3' })).toBeTruthy()
    expect(screen.getByText('Exact frozen subject', { selector: 'p' })).toBeTruthy()
    expect(screen.queryByText('Second museum', { selector: 'h3' })).toBeNull()
    const browseDeliveries = screen.getByRole('button', {
      name: 'Browse deliveries',
    }) as HTMLButtonElement
    expect(browseDeliveries.disabled).toBe(true)
    fireEvent.click(browseDeliveries)
    expect(mocks.deliveries).not.toHaveBeenCalled()

    await act(async () => {
      resolveMembers(memberPage)
    })
    expect(await screen.findByText('Second museum', { selector: 'h3' })).toBeTruthy()
    await waitFor(() => expect(browseDeliveries.disabled).toBe(false))
    expect(screen.getByText('Stage 1 approved draft')).toBeTruthy()
    expect(
      screen
        .getAllByLabelText('Include in batch')
        .map((input) => (input as HTMLInputElement).checked),
    ).toEqual([true, false])

    fireEvent.click(browseDeliveries)
    await waitFor(() => expect(mocks.deliveries).toHaveBeenCalledTimes(1))
    expect(mocks.deliveries).toHaveBeenCalledWith(
      { campaignId: 'campaign-1', detailVersion: 2 },
      { signal: expect.any(AbortSignal) },
    )
    expect(screen.queryByText('Newly loaded delivery subject', { selector: 'p' })).toBeNull()
    await act(async () => {
      resolveDeliveries(deliveryPage)
    })
    expect(await screen.findByText('Newly loaded delivery subject', { selector: 'p' })).toBeTruthy()
    expect(
      screen
        .getAllByLabelText('Include in batch')
        .map((input) => (input as HTMLInputElement).checked),
    ).toEqual([true, false])
    expect(screen.getByText('Stage 1 approved draft')).toBeTruthy()
  })

  it('aborts every in-flight evidence transport on unmount', async () => {
    const signals: AbortSignal[] = []
    const pending = (_input: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal)
      return new Promise(() => undefined)
    }
    mocks.campaign.mockImplementationOnce(pending)
    mocks.readiness.mockImplementationOnce(pending)
    mocks.rehearsal.mockImplementationOnce(pending)
    const rendered = render(<ProspectCampaignWorkbench campaignId="campaign-1" />)

    await waitFor(() => expect(signals).toHaveLength(3))
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
    rendered.unmount()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('fails closed with retry guidance and does not expose provider errors', async () => {
    mocks.campaign.mockRejectedValueOnce(new Error('provider://secret'))
    mocks.readiness.mockImplementationOnce(() => new Promise(() => undefined))
    mocks.rehearsal.mockImplementationOnce(() => new Promise(() => undefined))

    render(<ProspectCampaignWorkbench campaignId="campaign-1" />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be refreshed/i)
    expect(screen.getByRole('button', { name: 'Retry campaign refresh' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('provider://secret')
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })
})
