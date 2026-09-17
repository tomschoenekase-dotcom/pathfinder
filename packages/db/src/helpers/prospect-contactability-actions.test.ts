import { describe, expect, it, vi } from 'vitest'

vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn().mockResolvedValue(undefined) }))

import { reviewProspectContactReadinessAction } from './prospect-contactability-actions'

const actor = { type: 'HUMAN' as const, id: 'operator-1', role: 'PLATFORM_ADMIN' as const }

function clientFor(contact: Record<string, unknown>) {
  const tx = {
    prospectContact: {
      findUnique: vi.fn().mockResolvedValue(contact),
      update: vi.fn(),
    },
  }
  return { tx, client: { $transaction: vi.fn((work) => work(tx)) } }
}

describe('prospect contact readiness review boundaries', () => {
  it('rejects whitespace-only human evidence before database access', async () => {
    const transaction = vi.fn()
    await expect(
      reviewProspectContactReadinessAction(
        {
          contactId: 'contact-1',
          emailReadiness: 'VALID',
          permissionState: 'LEGITIMATE_INTEREST_RECORDED',
          evidence: { reviewReason: '   ' },
          actor,
        },
        { $transaction: transaction } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each(['OPTED_OUT', 'PROHIBITED'] as const)(
    'keeps terminal permission state %s outside the readiness-review path',
    async (permissionState) => {
      const { tx, client } = clientFor({
        id: 'contact-1',
        normalizedEmail: 'contact@example.test',
        doNotContact: false,
        suppressedAt: null,
        unsubscribedAt: null,
        permissionState,
      })
      await expect(
        reviewProspectContactReadinessAction(
          {
            contactId: 'contact-1',
            emailReadiness: 'VALID',
            permissionState: 'LEGITIMATE_INTEREST_RECORDED',
            evidence: { reviewReason: 'Operator reviewed contact evidence.' },
            actor,
          },
          client as never,
        ),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
      expect(tx.prospectContact.update).not.toHaveBeenCalled()
    },
  )

  it('cannot mark a contact valid without a normalized email address', async () => {
    const { tx, client } = clientFor({
      id: 'contact-1',
      normalizedEmail: null,
      doNotContact: false,
      suppressedAt: null,
      unsubscribedAt: null,
      permissionState: 'REVIEW_REQUIRED',
    })
    await expect(
      reviewProspectContactReadinessAction(
        {
          contactId: 'contact-1',
          emailReadiness: 'VALID',
          permissionState: 'LEGITIMATE_INTEREST_RECORDED',
          evidence: { reviewReason: 'Operator reviewed contact evidence.' },
          actor,
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.prospectContact.update).not.toHaveBeenCalled()
  })
})
