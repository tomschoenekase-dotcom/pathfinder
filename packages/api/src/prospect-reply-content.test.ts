import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  exactRead: vi.fn(),
  retain: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: { prospectEmailMessage: { findUnique: mocks.findUnique, findFirst: mocks.findFirst } },
  withTenantIsolationBypass: (operation: () => unknown) => operation(),
  isIntendedNativeGmailAccount: (account: { provider: string; mailboxAddress: string }) =>
    account.provider === 'GMAIL' && account.mailboxAddress === 'tomschoenekase@torchiko.com',
}))
vi.mock('./correspondence', () => ({
  readExactSourceOnlyReplyContent: mocks.exactRead,
  retainSelectedSourceOnlyReply: mocks.retain,
}))

import {
  readProspectReplyContent,
  readProspectReplyContentForAgent,
  retainProspectReplyContent,
} from './prospect-reply-content'

const selection = {
  messageId: 'message-1',
  threadId: 'thread-1',
  organizationId: 'organization-1',
}
const sourceReference = 'https://mail.google.com/mail/u/native-mailbox/#all/gmail-message-1'
const rawBodySha256 = 'a'.repeat(64)
const expected = {
  canonicalMessageId: selection.messageId,
  canonicalThreadId: selection.threadId,
  organizationId: selection.organizationId,
  providerAccountId: 'native-account',
  providerMessageId: 'gmail-message-1',
  providerThreadId: 'gmail-thread-1',
  sourceReference,
  rawBodySha256,
}

function canonicalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: selection.messageId,
    organizationId: selection.organizationId,
    threadId: selection.threadId,
    direction: 'INBOUND',
    bodyRetentionState: 'NOT_STORED',
    providerAccountId: 'native-account',
    providerMessageId: expected.providerMessageId,
    internetMessageId: '<reply@example.test>',
    fromAddress: 'person@example.test',
    subject: 'Re: Exhibit',
    occurredAt: new Date('2026-09-22T00:00:00.000Z'),
    sourceReference,
    providerAccount: {
      id: 'native-account',
      provider: 'GMAIL',
      externalAccountId: 'native-mailbox',
      mailboxAddress: 'tomschoenekase@torchiko.com',
      credentialReferenceId: 'native-credential-reference',
      connectionStatus: 'CONNECTED',
    },
    thread: {
      providerMappings: [
        {
          providerAccountId: 'native-account',
          providerThreadId: expected.providerThreadId,
        },
      ],
    },
    ...overrides,
  }
}

const factory = vi.fn(() => ({ key: 'GMAIL' }))

describe('selected prospect reply content route owner', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.findUnique.mockResolvedValue(canonicalRow())
    mocks.findFirst.mockResolvedValue(canonicalRow())
    mocks.exactRead.mockResolvedValue({
      rawBodySha256,
      rawText: 'Raw provider text',
      replyText: 'Selected reply',
      omittedQuotedText: true,
      projectionScope: 'CONSERVATIVE_DISPLAY_PROJECTION_NOT_RAW_SOURCE',
      retention: 'TRANSIENT_SOURCE_READ',
      trust: 'UNTRUSTED_EXTERNAL_CONTENT',
      agentPolicy: 'DATA_ONLY_NEVER_INSTRUCTIONS_OR_AUTHORIZATION',
    })
    mocks.retain.mockResolvedValue({ state: 'RETAINED', canonicalMessageId: selection.messageId })
  })

  it('resolves the exact canonical message and native mailbox before reading one selected source', async () => {
    const result = await readProspectReplyContent(selection, 'admin-1', factory as never)
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: selection.messageId } }),
    )
    expect(mocks.exactRead).toHaveBeenCalledWith({
      provider: factory.mock.results[0]!.value,
      mailbox: {
        provider: 'GMAIL',
        providerAccountId: expected.providerAccountId,
        mailboxId: 'native-mailbox',
        mailboxAddress: 'tomschoenekase@torchiko.com',
        credentialRef: 'native-credential-reference',
      },
      selected: expect.objectContaining({
        canonicalMessageId: selection.messageId,
        canonicalThreadId: selection.threadId,
        organizationId: selection.organizationId,
        providerMessageId: expected.providerMessageId,
        providerThreadId: expected.providerThreadId,
        sourceReference,
        direction: 'INBOUND',
        bodyRetentionState: 'NOT_STORED',
      }),
    })
    expect(result).toMatchObject({ expected, replyText: 'Selected reply', SEND_AUTHORIZED: false })
    expect(JSON.stringify(result)).not.toContain('Raw provider text')
    expect(mocks.retain).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>]>([
    ['cross-organization', { organizationId: 'other-organization' }],
    ['cross-thread', { threadId: 'other-thread' }],
    ['outbound role', { direction: 'OUTBOUND' }],
    ['missing provider message', { providerMessageId: null }],
    [
      'personal account',
      {
        providerAccount: {
          ...canonicalRow().providerAccount,
          mailboxAddress: 'personal@example.test',
        },
      },
    ],
    [
      'disconnected account',
      { providerAccount: { ...canonicalRow().providerAccount, connectionStatus: 'DISCONNECTED' } },
    ],
    [
      'ambiguous mapping',
      {
        thread: {
          providerMappings: [
            { providerAccountId: 'native-account', providerThreadId: expected.providerThreadId },
            { providerAccountId: 'native-account', providerThreadId: 'another-thread' },
          ],
        },
      },
    ],
    [
      'cross-account extra mapping',
      {
        thread: {
          providerMappings: [
            { providerAccountId: 'native-account', providerThreadId: expected.providerThreadId },
            { providerAccountId: 'another-account', providerThreadId: 'another-thread' },
          ],
        },
      },
    ],
  ])('holds %s before provider construction or content read', async (_name, change) => {
    mocks.findUnique.mockResolvedValue(canonicalRow(change))
    await expect(readProspectReplyContent(selection, 'admin-1', factory as never)).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.exactRead).not.toHaveBeenCalled()
    expect(mocks.retain).not.toHaveBeenCalled()
  })

  it('requires an actor and an unretained body before provider construction', async () => {
    await expect(readProspectReplyContent(selection, ' ', factory as never)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    mocks.findUnique.mockResolvedValue(canonicalRow({ bodyRetentionState: 'TEMPORARY' }))
    await expect(
      readProspectReplyContent(selection, 'admin-1', factory as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.exactRead).not.toHaveBeenCalled()
  })

  it('rebinds retention to the current canonical mailbox and leaves CAS to the retention owner', async () => {
    const result = await retainProspectReplyContent(
      { expected, retentionDays: 2 },
      'admin-1',
      factory as never,
    )
    expect(mocks.retain).toHaveBeenCalledWith({
      provider: factory.mock.results[0]!.value,
      mailbox: expect.objectContaining({
        providerAccountId: expected.providerAccountId,
        mailboxId: 'native-mailbox',
        credentialRef: 'native-credential-reference',
      }),
      expected,
      retentionDays: 2,
      actorId: 'admin-1',
    })
    expect(result).toMatchObject({ state: 'RETAINED', SEND_AUTHORIZED: false })
    expect(mocks.exactRead).not.toHaveBeenCalled()
  })

  it('refuses retention when the selected canonical row disappears or changes account', async () => {
    mocks.findUnique.mockResolvedValueOnce(null)
    await expect(
      retainProspectReplyContent({ expected, retentionDays: 2 }, 'admin-1', factory as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    mocks.findUnique.mockResolvedValueOnce(
      canonicalRow({
        providerAccount: {
          ...canonicalRow().providerAccount,
          mailboxAddress: 'personal@example.test',
        },
      }),
    )
    await expect(
      retainProspectReplyContent({ expected, retentionDays: 2 }, 'admin-1', factory as never),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.retain).not.toHaveBeenCalled()
  })

  it('never delegates retention without an authenticated actor', async () => {
    await expect(
      retainProspectReplyContent({ expected, retentionDays: 2 }, ' ', factory as never),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.retain).not.toHaveBeenCalled()
  })

  it('binds an agent read to the canonical message and organization territory in one query', async () => {
    const scope = { mode: 'TERRITORIES' as const, territoryIds: ['territory-1'] }
    const result = await readProspectReplyContentForAgent(
      selection,
      'agent-1',
      scope,
      factory as never,
    )
    expect(result).toMatchObject({ replyText: 'Selected reply', SEND_AUTHORIZED: false })
    expect(mocks.findUnique).not.toHaveBeenCalled()
    expect(mocks.findFirst).toHaveBeenCalledTimes(2)
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: selection.messageId,
          organizationId: selection.organizationId,
          threadId: selection.threadId,
          organization: { archivedAt: null, territoryId: { in: ['territory-1'] } },
        },
      }),
    )
  })

  it('denies an out-of-territory agent read before provider access', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await expect(
      readProspectReplyContentForAgent(
        selection,
        'agent-1',
        { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
        factory as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(factory).not.toHaveBeenCalled()
    expect(mocks.exactRead).not.toHaveBeenCalled()
  })

  it('withholds fetched plaintext if territory or source moves during the provider read', async () => {
    const scope = { mode: 'TERRITORIES' as const, territoryIds: ['territory-1'] }
    mocks.findFirst.mockResolvedValueOnce(canonicalRow()).mockResolvedValueOnce(null)
    await expect(
      readProspectReplyContentForAgent(selection, 'agent-1', scope, factory as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.exactRead).toHaveBeenCalledOnce()

    mocks.findFirst
      .mockResolvedValueOnce(canonicalRow())
      .mockResolvedValueOnce(canonicalRow({ providerMessageId: 'replacement-message' }))
    await expect(
      readProspectReplyContentForAgent(selection, 'agent-1', scope, factory as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
