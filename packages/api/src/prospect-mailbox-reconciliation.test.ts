import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ find: vi.fn(), audit: vi.fn(), enqueue: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: { correspondenceProviderAccount: { findUnique: mocks.find } },
  writeAuditLogStrict: mocks.audit,
  isIntendedNativeGmailAccount: (a: { provider: string; mailboxAddress: string }) =>
    a.provider === 'GMAIL' && a.mailboxAddress === 'tomschoenekase@torchiko.com',
}))
vi.mock('@pathfinder/jobs', () => ({ enqueueGmailSync: mocks.enqueue }))
import { requestProspectMailboxReconciliation } from './prospect-mailbox-reconciliation'
const when = '2026-09-21T00:00:00.000Z'
const input = { providerAccountId: 'SYNTHETIC-account-record', expectedUpdatedAt: when, actorId: 'SYNTHETIC-unit-admin' }
const account = () => ({ id: input.providerAccountId, provider: 'GMAIL', mailboxAddress: 'tomschoenekase@torchiko.com',
  externalAccountId: 'SYNTHETIC-mailbox', credentialReferenceId: 'SYNTHETIC-reference-not-a-secret',
  connectionStatus: 'CONNECTED', capabilities: ['RECONCILE'], updatedAt: new Date(when) })
describe('existing mailbox reconciliation access without activation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.find.mockResolvedValue(account())
    mocks.audit.mockResolvedValue(undefined)
    mocks.enqueue.mockResolvedValue(undefined)
  })
  it('uses the existing exact-account queue and reports only queue acceptance', async () => {
    const result = await requestProspectMailboxReconciliation(input)
    expect(mocks.enqueue).toHaveBeenCalledWith({ providerAccountId: input.providerAccountId, trigger: 'SCHEDULED_RECONCILIATION' })
    expect(result.state).toBe('QUEUED_NOT_SYNCHRONIZED')
    expect(result.mailboxActivated).toBe(false)
    expect(result.SEND_AUTHORIZED).toBe(false)
    expect(mocks.audit).toHaveBeenCalledOnce()
  })
  it.each([
    { mailboxAddress: 'personal@example.invalid' },
    { connectionStatus: 'DISCONNECTED' },
    { credentialReferenceId: null },
    { capabilities: [] },
    { updatedAt: new Date('2026-09-22T00:00:00Z') },
  ])('holds stale, wrong or disconnected accounts without enqueueing %j', async (change) => {
    mocks.find.mockResolvedValue({ ...account(), ...change })
    await expect(requestProspectMailboxReconciliation(input)).rejects.toThrow()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('never requests all accounts or fabricates a human actor', async () => {
    await expect(requestProspectMailboxReconciliation({ ...input, providerAccountId: '*' })).rejects.toThrow()
    await expect(requestProspectMailboxReconciliation({ ...input, actorId: '' })).rejects.toThrow()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('does not enqueue after a failed strict audit or claim success after a queue error', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit failed'))
    await expect(requestProspectMailboxReconciliation(input)).rejects.toThrow('audit failed')
    expect(mocks.enqueue).not.toHaveBeenCalled()
    mocks.enqueue.mockRejectedValueOnce(new Error('queue unconfirmed'))
    await expect(requestProspectMailboxReconciliation(input)).rejects.toThrow('queue unconfirmed')
  })
})
