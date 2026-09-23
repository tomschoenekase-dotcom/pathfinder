import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ read: vi.fn(), action: vi.fn(), readiness: vi.fn(),
  accounts: vi.fn(), bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()) }))
vi.mock('@pathfinder/db', () => ({
  ProspectSalesError: class ProspectSalesError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
  },
  db: { correspondenceProviderAccount: { findMany: mocks.accounts } },
  withTenantIsolationBypass: mocks.bypass,
}))
vi.mock('../../prospect-sales-workflow', () => ({
  getNativeSalesWorkflow: mocks.read,
  applyNativeSalesAction: mocks.action,
  readAuthenticatedSalesReadiness: mocks.readiness,
}))
import { adminProspectCrmSalesRouter } from './prospect-crm-sales'
import { salesLocalAction } from '../../prospect-sales-contract'
import type { TRPCSessionContext } from '../../context'

function caller(userId: string | null = 'operator', isPlatformAdmin = true) {
  const session: TRPCSessionContext =
    userId === null
      ? { userId: null, isPlatformAdmin: false, activeTenantId: null, role: null }
      : { userId, isPlatformAdmin, activeTenantId: null, role: null }
  return adminProspectCrmSalesRouter.createCaller({
    db: {} as never,
    headers: new Headers(),
    session,
  })
}
describe('native admin sales procedure authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue({ SEND_AUTHORIZED: false })
    mocks.action.mockResolvedValue({ SEND_AUTHORIZED: false })
    mocks.readiness.mockResolvedValue({ schema: 'torchiko.authenticated-sales-readiness/1',
      component: { state: 'paths-present-runtime-unverified' },
      writingGuide: { state: 'available', sha256: 'a'.repeat(64) } })
    mocks.accounts.mockResolvedValue([])
  })
  it('requires authenticated platform-admin authority for reads and writes', async () => {
    for (const who of [caller(null, false), caller('tenant-user', false)]) {
      await expect(who.getProspectSalesWorkflow({ venueId: 'venue' })).rejects.toBeTruthy()
      await expect(who.getProspectSalesReadiness()).rejects.toBeTruthy()
      await expect(
        who.prepareReviewProspectSales({
          action: 'prepare',
          input: { venueId: 'venue', expectedSnapshotHash: 'a'.repeat(64) },
        }),
      ).rejects.toBeTruthy()
    }
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.readiness).not.toHaveBeenCalled()
    expect(mocks.accounts).not.toHaveBeenCalled()
    expect(mocks.action).not.toHaveBeenCalled()
  })
  it('binds operator identity from the authenticated context, never client JSON', async () => {
    const input = {
      action: 'prepare' as const,
      input: { venueId: 'venue', expectedSnapshotHash: 'a'.repeat(64) },
    }
    await caller().prepareReviewProspectSales(input)
    expect(mocks.action).toHaveBeenCalledWith(input, {
      type: 'HUMAN',
      role: 'PLATFORM_ADMIN',
      id: 'operator',
    }, 'authenticated-admin')
    await expect(
      caller().prepareReviewProspectSales({ ...input, actor: { id: 'Tom' } } as never),
    ).rejects.toBeTruthy()
  })
  it.each(['send', 'approve', 'freeze', 'outbox', 'connectGmail', 'crawl'])(
    'has no %s operation',
    (action) => {
      expect(() => salesLocalAction.parse({ action, input: {} })).toThrow()
    },
  )
  it('requires exact review hash and current native snapshot', async () => {
    await expect(
      caller().prepareReviewProspectSales({
        action: 'review',
        input: { venueId: 'venue', draftId: 'draft', contentHash: 'a'.repeat(64) },
      } as never),
    ).rejects.toBeTruthy()
    expect(mocks.action).not.toHaveBeenCalled()
  })
  it('returns only exact company mailbox metadata and never calls a provider', async () => {
    mocks.accounts.mockResolvedValue([{ id: 'company-account',
      mailboxAddress: 'tomschoenekase@torchiko.com', connectionStatus: 'CONNECTED',
      lastSuccessfulSyncAt: null, updatedAt: new Date('2026-09-22T08:00:00Z') }])
    const result = await caller().getProspectSalesReadiness()
    expect(result).toMatchObject({
      authentication: { scope: 'AUTHENTICATED_PLATFORM_ADMIN' },
      mailbox: { identity: 'tomschoenekase@torchiko.com', state: 'registered',
        connectionStatus: 'CONNECTED', syncEvidence: 'NO_SUCCESSFUL_SYNC_RECORDED',
        queueState: 'NOT_INSPECTED', nextAction: 'REQUEST_EXISTING_ACCOUNT_RECONCILIATION' },
    })
    expect(mocks.accounts).toHaveBeenCalledWith(expect.objectContaining({ take: 2,
      select: expect.not.objectContaining({ credentialReferenceId: true, accessToken: true }) }))
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('does not call a duplicate or failed company account synchronized', async () => {
    mocks.accounts.mockResolvedValueOnce([{ id: 'one' }, { id: 'two' }])
      .mockRejectedValueOnce(new Error('private database path'))
    expect((await caller().getProspectSalesReadiness()).mailbox).toMatchObject({
      state: 'ambiguous', accountId: null, syncEvidence: 'NOT_ESTABLISHED' })
    const failed = await caller().getProspectSalesReadiness()
    expect(failed.mailbox).toMatchObject({ state: 'unavailable', accountId: null,
      queueState: 'NOT_INSPECTED' })
    expect(JSON.stringify(failed)).not.toContain('private database path')
  })
})
