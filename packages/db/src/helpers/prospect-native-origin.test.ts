import { afterEach, describe, expect, it } from 'vitest'
import {
  localFirstSendRehearsalEnabled,
  isLocalFakeDelivery,
  requireProspectApprovalActor,
  requireProspectApprovalScope,
  nativeOriginAccountHash,
  operationalOrigin,
  isIntendedNativeGmailAccount,
  verifyStoredNativeOrigin,
} from './prospect-native-origin'
const original = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]
  Object.assign(process.env, original)
})
const syntheticActor = {
  type: 'SYSTEM' as const,
  role: 'PLATFORM_ADMIN' as const,
  id: 'synthetic:crm-meaning:test',
}
function enable() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    TORCHIKO_LOCAL_CRM_REHEARSAL: '1',
    TORCHIKO_LOCAL_CRM_SALES_ENABLED: '1',
    DATABASE_URL:
      'postgresql://fixture@127.0.0.1:58617/pathfinder_disposable_crm_research_20260919',
  })
  delete process.env.DIRECT_DATABASE_URL
  delete process.env.APP_ENV
  delete process.env.DEPLOYMENT_ENV
}
function account() {
  return {
    id: 'SYN-CRM-FIRSTSEND-account',
    externalAccountId: 'SYN-CRM-FIRSTSEND-mailbox',
    mailboxAddress: 'test@example.invalid',
    provider: 'FAKE',
    deliveryEnabled: false,
    connectionStatus: 'DISCONNECTED',
    credentialReferenceId: null,
    pausedAt: null,
    capabilities: [],
  }
}
describe('native-origin rehearsal is not a permission bypass', () => {
  it('rejects invalid, expired and changed-business preparations without private voice files', async () => {
    const native = { snapshotHash: 'a'.repeat(64) } as never
    const preparation = {
      schema: 'torchiko.native-sales-components/1',
      SEND_AUTHORIZED: false, senderAvailable: false, blocker: null,
      nativeSnapshotHash: 'a'.repeat(64),
      gate: { can_prepare: true }, componentCodeHashes: { gate: 'hash' },
      preparation: { fileSha256s: { 'writer-context.md': 'hash' },
        businessFreshnessReviewDueAt: '2999-01-01T00:00:00Z' },
    }
    await expect(verifyStoredNativeOrigin(native, preparation as never)).resolves.toBe(preparation)
    await expect(verifyStoredNativeOrigin(native, { ...preparation, schema: 'forged' } as never))
      .rejects.toThrow('NATIVE_PREPARATION_INVALID')
    await expect(verifyStoredNativeOrigin(native, { ...preparation,
      preparation: { ...preparation.preparation,
        businessFreshnessReviewDueAt: '2000-01-01T00:00:00Z' } } as never))
      .rejects.toThrow('NATIVE_PREPARATION_INVALID')
    await expect(verifyStoredNativeOrigin(native, { ...preparation,
      nativeSnapshotHash: 'b'.repeat(64) } as never))
      .rejects.toThrow('NATIVE_PREPARATION_INVALID')
  })
  it('does not confuse another Gmail account with the confirmed company mailbox', () => {
    expect(isIntendedNativeGmailAccount({ provider: 'GMAIL', mailboxAddress: 'tomschoenekase@torchiko.com' })).toBe(true)
    expect(isIntendedNativeGmailAccount({ provider: 'GMAIL', mailboxAddress: 'personal@example.invalid' })).toBe(false)
    expect(isIntendedNativeGmailAccount({ provider: 'FAKE', mailboxAddress: 'tomschoenekase@torchiko.com' })).toBe(false)
    expect(isIntendedNativeGmailAccount({ provider: 'GMAIL', mailboxAddress: 'tomschoenekase@torchiko.com.attacker.invalid' })).toBe(false)
  })
  it('defaults off', () => {
    delete process.env.TORCHIKO_LOCAL_CRM_REHEARSAL
    expect(localFirstSendRehearsalEnabled()).toBe(false)
    expect(() => requireProspectApprovalActor(syntheticActor)).toThrow()
  })
  it('only admits the exact retained loopback database', () => {
    enable()
    expect(localFirstSendRehearsalEnabled()).toBe(true)
    process.env.DATABASE_URL =
      'postgresql://fixture@remote.example:58617/pathfinder_disposable_crm_research_20260919'
    expect(localFirstSendRehearsalEnabled()).toBe(false)
  })
  it.each(['NODE_ENV', 'APP_ENV', 'DEPLOYMENT_ENV'])('rejects production %s', (key) => {
    enable()
    process.env[key] = 'production'
    expect(localFirstSendRehearsalEnabled()).toBe(false)
  })
  it('rejects a conflicting direct database', () => {
    enable()
    process.env.DIRECT_DATABASE_URL = 'postgresql://prod'
    expect(localFirstSendRehearsalEnabled()).toBe(false)
  })
  it('SYSTEM approvals cannot target a genuine prospect', () => {
    enable()
    expect(() => requireProspectApprovalScope(syntheticActor, ['real-prospect'])).toThrow()
    expect(() =>
      requireProspectApprovalScope(syntheticActor, ['SYN-CRM-FIRSTSEND-org']),
    ).not.toThrow()
  })
  it('never treats an AGENT as a human approval', () => {
    enable()
    expect(() =>
      requireProspectApprovalActor({ ...syntheticActor, type: 'AGENT' } as never),
    ).toThrow()
  })
  it('permits only disabled credential-free fake account and example.invalid recipient', () => {
    enable()
    expect(
      isLocalFakeDelivery(account(), ['SYN-CRM-FIRSTSEND-org'], ['fixture@example.invalid']),
    ).toBe(true)
    for (const change of [
      { provider: 'GMAIL' },
      { deliveryEnabled: true },
      { credentialReferenceId: 'secret' },
      { connectionStatus: 'CONNECTED' },
      { capabilities: ['SEND_ONE_APPROVED'] },
      { mailboxAddress: 'tom@torchiko.com' },
    ])
      expect(
        isLocalFakeDelivery(
          { ...account(), ...change },
          ['SYN-CRM-FIRSTSEND-org'],
          ['fixture@example.invalid'],
        ),
      ).toBe(false)
    expect(isLocalFakeDelivery(account(), ['SYN-CRM-FIRSTSEND-org'], ['real@venue.org'])).toBe(
      false,
    )
  })
  it('pins account identity separately from an enablement setting', () => {
    expect(nativeOriginAccountHash(account())).not.toBe(
      nativeOriginAccountHash({ ...account(), mailboxAddress: 'other@example.invalid' }),
    )
  })
  it('does not invent native provenance for legacy operational drafts', () => {
    expect(operationalOrigin({})).toBeNull()
    expect(() => operationalOrigin({ nativeSalesOrigin: { approved: true } })).toThrow()
  })
})
