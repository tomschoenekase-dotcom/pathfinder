/* @vitest-environment jsdom */
import React from 'react'
import axe from 'axe-core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProspectCampaignWorkbench } from './ProspectCampaignWorkbench'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  queue: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      approveProspectSendBatch: { mutate: mocks.approve },
      queueProspectSendBatch: { mutate: mocks.queue },
      getProspectCampaign: { query: vi.fn() },
      getProspectOutreachReadiness: { query: vi.fn() },
      getProspectNoSendRehearsal: { query: vi.fn() },
      saveProspectOutreachDraft: { mutate: vi.fn() },
      reviewProspectOutreachDraft: { mutate: vi.fn() },
      stageProspectSendBatch: { mutate: vi.fn() },
    },
  }),
}))

const frozenItem = {
  id: 'item-1',
  status: 'STAGED',
  recipientEmailSnapshot: 'internal@example.com',
  subjectSnapshot: 'Exact frozen subject',
  textBodySnapshot: 'Exact frozen body',
  htmlBodySnapshot: null,
  contentHashSnapshot: 'c'.repeat(64),
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
      limits: { cohort: 5000, batch: 500 },
      policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
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
      cohort: {
        memberCount: 1,
        maxCohort: 5000,
        maxBatch: 500,
        bounded: true,
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

  it('shows the exact frozen recipient/content and keeps approval separate from release', async () => {
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)

    fireEvent.click(screen.getByText('Inspect exact frozen recipients and content'))
    expect(screen.getByText('To: internal@example.com')).toBeTruthy()
    expect(screen.getByText('Exact frozen subject')).toBeTruthy()
    expect(screen.getByText('Exact frozen body')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Approve exact batch' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Approve this exact frozen batch?')).toBeTruthy()
    expect(within(dialog).getByText('internal@example.com')).toBeTruthy()
    expect(within(dialog).getByText(/Exact count: 1/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /do not send/i })).toBeTruthy()
  })

  it('shows a zero-cost rehearsal that cannot authorize sending', () => {
    render(<ProspectCampaignWorkbench campaignId="campaign-1" fixture={fixture('STAGED')} />)

    expect(screen.getByText('Ready for human review — never ready to send')).toBeTruthy()
    expect(screen.getByText(/made 0 provider calls and cost \$0.00/i)).toBeTruthy()
    expect(screen.getByText(/Emergency stop: disable only/i)).toBeTruthy()
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
      expect(
        (screen.getByLabelText('Gmail mailbox for final release') as HTMLSelectElement).value,
      ).toBe('mailbox-1'),
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
    expect((await axe.run(container)).violations).toEqual([])
  })
})
