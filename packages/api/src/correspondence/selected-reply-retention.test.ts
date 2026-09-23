import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    prospectEmailMessage: { findUnique: mocks.findUnique },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
      prospectEmailMessage: { updateMany: mocks.updateMany },
      auditLog: { create: mocks.auditCreate },
    }),
  },
  withTenantIsolationBypass: (callback: () => unknown) => callback(),
  writeAuditLogStrict: (input: unknown, tx: { auditLog: { create: (value: unknown) => unknown } }) =>
    tx.auditLog.create({ data: input }),
}))

vi.mock('./reply-text', () => ({
  projectReplyText: (raw: string) => ({
    text: raw.trim(),
    omittedQuotedText: false,
    scope: 'CONSERVATIVE_DISPLAY_PROJECTION_NOT_RAW_SOURCE',
  }),
}))

import { createHash } from 'node:crypto'
import { normalizeUntrustedCorrespondenceBody } from './content-safety'
import { createFakeCorrespondenceProvider } from './fake'
import { retainSelectedSourceOnlyReply } from './selected-reply-retention'

const rawText = 'A selected customer reply.'
const rawBodySha256 = createHash('sha256').update(rawText).digest('hex')
const mailbox = {
  provider: 'FAKE' as const,
  providerAccountId: 'account-1',
  mailboxId: 'box-1',
  mailboxAddress: 'team@example.invalid',
  credentialRef: 'fixture-only',
}
const expected = {
  canonicalMessageId: 'canonical-message-1',
  canonicalThreadId: 'canonical-thread-1',
  organizationId: 'organization-1',
  providerAccountId: mailbox.providerAccountId,
  providerMessageId: 'provider-message-1',
  providerThreadId: 'provider-thread-1',
  sourceReference: 'synthetic:crm-sales:fake-provider:provider-message-1',
  rawBodySha256,
}
const occurredAt = new Date('2026-09-22T00:00:00.000Z')

function providerFixture() {
  const provider = createFakeCorrespondenceProvider()
  provider.state.messages.set(expected.providerMessageId, {
    message: { ...mailbox, externalId: expected.providerMessageId },
    thread: { ...mailbox, externalId: expected.providerThreadId },
    rfcMessageId: '<reply@example.test>',
    inReplyTo: null,
    references: [],
    from: [{ email: 'person@example.test' }],
    to: [{ email: mailbox.mailboxAddress }],
    cc: [],
    bcc: [],
    subject: 'Re: Exhibit',
    internalDate: occurredAt,
    direction: 'INBOUND',
    body: normalizeUntrustedCorrespondenceBody({ text: rawText }),
    attachments: [],
  })
  return provider
}

function canonicalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: expected.canonicalMessageId,
    threadId: expected.canonicalThreadId,
    organizationId: expected.organizationId,
    providerAccountId: expected.providerAccountId,
    providerMessageId: expected.providerMessageId,
    internetMessageId: '<reply@example.test>',
    fromAddress: 'person@example.test',
    subject: 'Re: Exhibit',
    occurredAt,
    direction: 'INBOUND',
    bodyRetentionState: 'NOT_STORED',
    textBody: null,
    bodyExpiresAt: null,
    sourceReference: expected.sourceReference,
    providerAccount: {
      provider: 'FAKE',
      externalAccountId: mailbox.mailboxId,
      mailboxAddress: mailbox.mailboxAddress,
      credentialReferenceId: mailbox.credentialRef,
      connectionStatus: 'CONNECTED',
      updatedAt: new Date('2026-09-21T00:00:00.000Z'),
    },
    thread: { providerMappings: [{
      providerAccountId: expected.providerAccountId,
      providerThreadId: expected.providerThreadId,
    }] },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findUnique.mockResolvedValue(canonicalRow())
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' })
})

describe('selected SOURCE_ONLY reply retention', () => {
  it('CAS retains one selected body with a bounded expiry and content-hash-only audit', async () => {
    const provider = providerFixture()
    const now = new Date('2026-09-22T01:00:00.000Z')
    const result = await retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 2, actorId: 'admin-1', now: () => now,
    })

    expect(result).toMatchObject({ state: 'RETAINED', contentHash: rawBodySha256 })
    expect(result.expiresAt.toISOString()).toBe('2026-09-24T01:00:00.000Z')
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: expected.canonicalMessageId,
        bodyRetentionState: 'NOT_STORED',
        sourceReference: expected.sourceReference,
        providerAccount: expect.objectContaining({
          mailboxAddress: mailbox.mailboxAddress,
          credentialReferenceId: mailbox.credentialRef,
          updatedAt: new Date('2026-09-21T00:00:00.000Z'),
        }),
        thread: { providerMappings: {
          some: {
            providerAccountId: expected.providerAccountId,
            providerThreadId: expected.providerThreadId,
          },
          every: {
            providerAccountId: expected.providerAccountId,
            providerThreadId: expected.providerThreadId,
          },
        } },
      }),
      data: expect.objectContaining({ textBody: rawText, bodyRetentionState: 'TEMPORARY' }),
    }))
    const audit = mocks.auditCreate.mock.calls[0]![0]
    expect(audit.data.afterState.contentHash).toBe(rawBodySha256)
    expect(JSON.stringify(audit)).not.toContain(rawText)
  })

  it('rejects stale content and a lost CAS without writing an audit', async () => {
    const provider = providerFixture()
    await expect(retainSelectedSourceOnlyReply({
      provider, mailbox, expected: { ...expected, rawBodySha256: '0'.repeat(64) },
      retentionDays: 2, actorId: 'admin-1',
    })).rejects.toThrow('source changed')
    expect(mocks.updateMany).not.toHaveBeenCalled()

    mocks.updateMany.mockResolvedValue({ count: 0 })
    await expect(retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 2, actorId: 'admin-1',
    })).rejects.toThrow('source changed')
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  it('refuses account rebind or an added provider mapping before any provider read or write', async () => {
    const provider = providerFixture()
    const retrieve = vi.spyOn(provider, 'retrieveMessage')
    mocks.findUnique.mockResolvedValueOnce(canonicalRow({
      providerAccount: {
        provider: 'FAKE',
        externalAccountId: mailbox.mailboxId,
        mailboxAddress: 'other@example.test',
        credentialReferenceId: 'different-credential',
        connectionStatus: 'CONNECTED',
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
      },
    }))
    await expect(retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 2, actorId: 'admin-1',
    })).rejects.toThrow('source changed')

    mocks.findUnique.mockResolvedValueOnce(canonicalRow({
      thread: { providerMappings: [
        { providerAccountId: expected.providerAccountId, providerThreadId: expected.providerThreadId },
        { providerAccountId: 'another-account', providerThreadId: 'another-thread' },
      ] },
    }))
    await expect(retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 2, actorId: 'admin-1',
    })).rejects.toThrow('source changed')
    expect(retrieve).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  it('replays the original unexpired retention without another provider read or expiry extension', async () => {
    const provider = providerFixture()
    const retrieve = vi.spyOn(provider, 'retrieveMessage')
    mocks.findUnique.mockResolvedValue(canonicalRow({
      bodyRetentionState: 'TEMPORARY',
      textBody: rawText,
      bodyExpiresAt: new Date('2026-09-24T00:00:00.000Z'),
    }))
    const result = await retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 30, actorId: 'admin-1',
      now: () => new Date('2026-09-22T00:00:00.000Z'),
    })
    expect(result).toMatchObject({ state: 'REPLAYED' })
    expect(result.expiresAt.toISOString()).toBe('2026-09-24T00:00:00.000Z')
    expect(retrieve).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('attributes the isolated FAKE proof to SYSTEM and rejects a forged fixture actor', async () => {
    const provider = providerFixture()
    await retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 1,
      actor: { type: 'SYSTEM', role: 'PLATFORM_ADMIN', id: 'synthetic:crm-meaning:selected-reply-proof' },
    })
    expect(mocks.auditCreate.mock.calls[0]![0].data).toMatchObject({
      actorType: 'SYSTEM', actorId: 'synthetic:crm-meaning:selected-reply-proof',
      actorRole: 'PLATFORM_ADMIN',
    })
    vi.clearAllMocks()
    await expect(retainSelectedSourceOnlyReply({
      provider, mailbox, expected, retentionDays: 1,
      actor: { type: 'SYSTEM', role: 'PLATFORM_ADMIN', id: 'admin-1' },
    })).rejects.toThrow('source changed')
    expect(mocks.findUnique).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})
