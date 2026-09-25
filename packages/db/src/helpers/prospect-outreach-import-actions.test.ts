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
})
