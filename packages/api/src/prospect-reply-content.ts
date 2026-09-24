import { TRPCError } from '@trpc/server'
import { db, isIntendedNativeGmailAccount, withTenantIsolationBypass } from '@pathfinder/db'
import {
  createGmailApiClient,
  createGmailCorrespondenceProvider,
  createGmailOAuthRuntime,
  readExactSourceOnlyReplyContent,
  retainSelectedSourceOnlyReply,
  type ExactSourceOnlyReplySelection,
  type SelectedReplyRetentionExpectation,
  type CorrespondenceProvider,
  type ProviderMailboxRef,
} from './correspondence'

type Selection = { messageId: string; threadId: string; organizationId: string }
type ProviderFactory = () => CorrespondenceProvider
type AgentReplyScope = Readonly<
  { mode: 'ALL' } | { mode: 'TERRITORIES'; territoryIds: readonly string[] }
>

/** Existing encrypted Gmail credential owner; configuration is never returned to callers. */
function nativeProvider() {
  const {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
    GMAIL_OAUTH_REDIRECT_URI: redirectUri,
    INTEGRATION_ENCRYPTION_KEY: integrationEncryptionKey,
  } = process.env
  if (!clientId || !clientSecret || !redirectUri || !integrationEncryptionKey)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'The existing Gmail runtime is not configured. Ask the mailbox owner to finish its existing setup.',
    })
  const runtime = createGmailOAuthRuntime({
    configuration: { clientId, clientSecret, redirectUri, integrationEncryptionKey },
  })
  return createGmailCorrespondenceProvider({
    credentials: runtime.credentials,
    client: createGmailApiClient(),
  })
}

async function resolve(input: Selection, actorId: string, scope: AgentReplyScope | null = null) {
  if (!actorId.trim())
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'An authenticated operator is required.' })
  const select = {
    id: true,
    organizationId: true,
    threadId: true,
    direction: true,
    bodyRetentionState: true,
    providerAccountId: true,
    providerMessageId: true,
    internetMessageId: true,
    fromAddress: true,
    subject: true,
    occurredAt: true,
    sourceReference: true,
    providerAccount: {
      select: {
        id: true,
        provider: true,
        externalAccountId: true,
        mailboxAddress: true,
        credentialReferenceId: true,
        connectionStatus: true,
      },
    },
    thread: {
      select: { providerMappings: { select: { providerAccountId: true, providerThreadId: true } } },
    },
  } as const
  const row = await withTenantIsolationBypass(() =>
    scope
      ? db.prospectEmailMessage.findFirst({
          where: {
            id: input.messageId,
            organizationId: input.organizationId,
            threadId: input.threadId,
            organization: {
              archivedAt: null,
              ...(scope.mode === 'TERRITORIES'
                ? { territoryId: { in: [...new Set(scope.territoryIds)] } }
                : {}),
            },
          },
          select,
        })
      : db.prospectEmailMessage.findUnique({ where: { id: input.messageId }, select }),
  )
  if (!row || row.organizationId !== input.organizationId || row.threadId !== input.threadId)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'This exact message is not in the selected organization and thread.',
    })
  const account = row.providerAccount
  if (
    !account ||
    !isIntendedNativeGmailAccount(account) ||
    !account.credentialReferenceId ||
    !['CONNECTED', 'DEGRADED'].includes(account.connectionStatus)
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'This needs the connected tomschoenekase@torchiko.com account. Personal and synthetic mailbox IDs cannot be substituted.',
    })
  const mappings = row.thread.providerMappings.filter(
    (item) => item.providerAccountId === account.id,
  )
  if (
    row.direction !== 'INBOUND' ||
    !row.providerMessageId ||
    !row.sourceReference ||
    mappings.length !== 1 ||
    row.thread.providerMappings.length !== 1
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'An exact inbound provider message and unambiguous thread mapping are required.',
    })
  const mailbox: ProviderMailboxRef = {
    provider: 'GMAIL',
    providerAccountId: account.id,
    mailboxId: account.externalAccountId,
    mailboxAddress: account.mailboxAddress,
    credentialRef: account.credentialReferenceId,
  }
  return { row, mailbox, providerThreadId: mappings[0]!.providerThreadId }
}

async function readSelected(
  input: Selection,
  actorId: string,
  scope: AgentReplyScope | null,
  factory: ProviderFactory,
) {
  const { row, mailbox, providerThreadId } = await resolve(input, actorId, scope)
  if (row.bodyRetentionState !== 'NOT_STORED')
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The body retention state changed. Reload this message before continuing.',
    })
  const selected: ExactSourceOnlyReplySelection = {
    canonicalMessageId: row.id,
    canonicalThreadId: row.threadId,
    organizationId: row.organizationId,
    provider: 'GMAIL',
    providerAccountId: mailbox.providerAccountId,
    mailboxId: mailbox.mailboxId,
    providerMessageId: row.providerMessageId!,
    providerThreadId,
    internetMessageId: row.internetMessageId,
    fromAddress: row.fromAddress,
    subject: row.subject,
    occurredAt: row.occurredAt,
    sourceReference: row.sourceReference!,
    direction: 'INBOUND',
    bodyRetentionState: 'NOT_STORED',
  }
  const content = await readExactSourceOnlyReplyContent({ provider: factory(), mailbox, selected })
  if (scope) {
    // The provider request is asynchronous. Recheck the scoped canonical row before
    // releasing plaintext in case its organization, territory, account or source moved.
    const current = await resolve(input, actorId, scope)
    if (
      current.row.bodyRetentionState !== 'NOT_STORED' ||
      current.row.providerAccountId !== row.providerAccountId ||
      current.row.providerMessageId !== row.providerMessageId ||
      current.row.internetMessageId !== row.internetMessageId ||
      current.row.fromAddress !== row.fromAddress ||
      current.row.subject !== row.subject ||
      current.row.occurredAt.getTime() !== row.occurredAt.getTime() ||
      current.row.sourceReference !== row.sourceReference ||
      current.providerThreadId !== providerThreadId ||
      current.mailbox.mailboxId !== mailbox.mailboxId ||
      current.mailbox.mailboxAddress !== mailbox.mailboxAddress ||
      current.mailbox.credentialRef !== mailbox.credentialRef
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'The selected reply source changed during the read.',
      })
  }
  const expected: SelectedReplyRetentionExpectation = {
    canonicalMessageId: row.id,
    canonicalThreadId: row.threadId,
    organizationId: row.organizationId,
    providerAccountId: mailbox.providerAccountId,
    providerMessageId: row.providerMessageId!,
    providerThreadId,
    sourceReference: row.sourceReference!,
    rawBodySha256: content.rawBodySha256,
  }
  return {
    expected,
    replyText: content.replyText,
    omittedQuotedText: content.omittedQuotedText,
    projectionScope: content.projectionScope,
    retention: content.retention,
    trust: content.trust,
    agentPolicy: content.agentPolicy,
    SEND_AUTHORIZED: false as const,
  }
}

/** Explicit selected-message read. No retention, sync, approval or delivery is implied. */
export async function readProspectReplyContent(
  input: Selection,
  actorId: string,
  factory: ProviderFactory = nativeProvider,
) {
  return readSelected(input, actorId, null, factory)
}

/** Internal agent path: scope comes only from the bridge's verified, leased run. */
export async function readProspectReplyContentForAgent(
  input: Selection,
  actorId: string,
  scope: AgentReplyScope,
  factory: ProviderFactory = nativeProvider,
) {
  return readSelected(input, actorId, scope, factory)
}

export async function retainProspectReplyContent(
  input: { expected: SelectedReplyRetentionExpectation; retentionDays: number },
  actorId: string,
  factory: ProviderFactory = nativeProvider,
) {
  const { mailbox } = await resolve(
    {
      messageId: input.expected.canonicalMessageId,
      threadId: input.expected.canonicalThreadId,
      organizationId: input.expected.organizationId,
    },
    actorId,
  )
  const result = await retainSelectedSourceOnlyReply({
    provider: factory(),
    mailbox,
    expected: input.expected,
    retentionDays: input.retentionDays,
    actorId,
  })
  return { ...result, SEND_AUTHORIZED: false as const }
}
