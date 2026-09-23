import { createHash } from 'node:crypto'

import { db, withTenantIsolationBypass, writeAuditLogStrict } from '@pathfinder/db'

import type { CorrespondenceProvider } from './provider'
import { readExactSourceOnlyReplyContent, type ExactSourceOnlyReplySelection } from './exact-reply-content'
import { CorrespondenceProviderError, type ProviderMailboxRef } from './types'

export type SelectedReplyRetentionExpectation = Readonly<{
  canonicalMessageId: string
  canonicalThreadId: string
  organizationId: string
  providerAccountId: string
  providerMessageId: string
  providerThreadId: string
  sourceReference: string
  rawBodySha256: string
}>

type RetentionActor =
  | Readonly<{ actorId: string; actor?: never }>
  | Readonly<{ actorId?: never; actor: { type: 'SYSTEM'; role: 'PLATFORM_ADMIN'; id: string } }>

function changed(): never {
  throw new CorrespondenceProviderError(
    'INVALID_INPUT',
    'Selected reply source changed; inspect the current canonical message before retaining content',
  )
}

/** An explicitly selected, authenticated admin mutation. The caller must derive
 * actorId from its session and resolve the provider/mailbox from the native account.
 * The expected hash comes from a prior exact read, never from untrusted mail text. */
export async function retainSelectedSourceOnlyReply(input: {
  provider: CorrespondenceProvider
  mailbox: ProviderMailboxRef
  expected: SelectedReplyRetentionExpectation
  retentionDays: number
  now?: () => Date
} & RetentionActor) {
  const { expected, mailbox, provider } = input
  const actorId = input.actor?.id ?? input.actorId
  const syntheticActor = input.actor !== undefined
  if (
    !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 1 ||
    input.retentionDays > 30 ||
    !actorId ||
    actorId.length > 191 ||
    (syntheticActor && (
      input.actor?.type !== 'SYSTEM' ||
      input.actor.role !== 'PLATFORM_ADMIN' ||
      !actorId.startsWith('synthetic:crm-meaning:') ||
      provider.key !== 'FAKE' ||
      !mailbox.mailboxAddress.endsWith('@example.invalid')
    )) ||
    !/^[a-f0-9]{64}$/u.test(expected.rawBodySha256) ||
    provider.key !== mailbox.provider ||
    expected.providerAccountId !== mailbox.providerAccountId
  ) changed()

  const row = await withTenantIsolationBypass(() =>
    db.prospectEmailMessage.findUnique({
      where: { id: expected.canonicalMessageId },
      select: {
        id: true,
        threadId: true,
        organizationId: true,
        providerAccountId: true,
        providerMessageId: true,
        internetMessageId: true,
        fromAddress: true,
        subject: true,
        occurredAt: true,
        direction: true,
        bodyRetentionState: true,
        textBody: true,
        bodyExpiresAt: true,
        sourceReference: true,
        providerAccount: {
          select: {
            provider: true,
            externalAccountId: true,
            mailboxAddress: true,
            credentialReferenceId: true,
            connectionStatus: true,
            updatedAt: true,
          },
        },
        thread: {
          select: {
            providerMappings: {
              select: { providerAccountId: true, providerThreadId: true },
            },
          },
        },
      },
    }),
  )
  if (
    !row ||
    row.threadId !== expected.canonicalThreadId ||
    row.organizationId !== expected.organizationId ||
    row.providerAccountId !== expected.providerAccountId ||
    row.providerMessageId !== expected.providerMessageId ||
    row.sourceReference !== expected.sourceReference ||
    row.providerAccount?.provider !== mailbox.provider ||
    row.providerAccount.externalAccountId !== mailbox.mailboxId ||
    row.providerAccount.mailboxAddress !== mailbox.mailboxAddress ||
    row.providerAccount.credentialReferenceId !== mailbox.credentialRef ||
    !Number.isFinite(row.providerAccount.updatedAt.getTime()) ||
    !['CONNECTED', 'DEGRADED'].includes(row.providerAccount.connectionStatus) ||
    row.thread.providerMappings.length !== 1 ||
    row.thread.providerMappings[0]!.providerAccountId !== expected.providerAccountId ||
    row.thread.providerMappings[0]!.providerThreadId !== expected.providerThreadId ||
    row.direction !== 'INBOUND'
  ) changed()

  const selectedAccountUpdatedAt = row.providerAccount.updatedAt
  // A lost response to a successful mutation returns the original expiry and
  // never extends retention or writes a second audit event.
  const now = input.now?.() ?? new Date()
  if (row.bodyRetentionState === 'TEMPORARY') {
    if (
      row.textBody &&
      row.bodyExpiresAt &&
      row.bodyExpiresAt > now &&
      createHash('sha256').update(row.textBody, 'utf8').digest('hex') === expected.rawBodySha256
    ) {
      return {
        state: 'REPLAYED' as const,
        canonicalMessageId: row.id,
        contentHash: expected.rawBodySha256,
        expiresAt: row.bodyExpiresAt,
      }
    }
    changed()
  }
  if (row.bodyRetentionState !== 'NOT_STORED' || row.textBody !== null) changed()

  const selected: ExactSourceOnlyReplySelection = {
    canonicalMessageId: row.id,
    canonicalThreadId: row.threadId,
    organizationId: row.organizationId,
    provider: mailbox.provider,
    providerAccountId: expected.providerAccountId,
    mailboxId: mailbox.mailboxId,
    providerMessageId: expected.providerMessageId,
    providerThreadId: expected.providerThreadId,
    internetMessageId: row.internetMessageId,
    fromAddress: row.fromAddress,
    subject: row.subject,
    occurredAt: row.occurredAt,
    sourceReference: expected.sourceReference,
    direction: 'INBOUND',
    bodyRetentionState: 'NOT_STORED',
  }
  const content = await readExactSourceOnlyReplyContent({ provider, mailbox, selected })
  if (content.rawBodySha256 !== expected.rawBodySha256) changed()
  const expiresAt = new Date(now.getTime() + input.retentionDays * 86_400_000)

  await withTenantIsolationBypass(() =>
    db.$transaction(async (tx) => {
      const updated = await tx.prospectEmailMessage.updateMany({
        where: {
          id: expected.canonicalMessageId,
          threadId: expected.canonicalThreadId,
          organizationId: expected.organizationId,
          providerAccountId: expected.providerAccountId,
          providerMessageId: expected.providerMessageId,
          internetMessageId: row.internetMessageId,
          fromAddress: row.fromAddress,
          subject: row.subject,
          occurredAt: row.occurredAt,
          direction: 'INBOUND',
          bodyRetentionState: 'NOT_STORED',
          textBody: null,
          sourceReference: expected.sourceReference,
          providerAccount: {
            provider: mailbox.provider,
            externalAccountId: mailbox.mailboxId,
            mailboxAddress: mailbox.mailboxAddress,
            credentialReferenceId: mailbox.credentialRef,
            updatedAt: selectedAccountUpdatedAt,
            connectionStatus: { in: ['CONNECTED', 'DEGRADED'] },
          },
          thread: {
            providerMappings: {
              some: {
                providerAccountId: expected.providerAccountId,
                providerThreadId: expected.providerThreadId,
              },
              every: {
                providerAccountId: expected.providerAccountId,
                providerThreadId: expected.providerThreadId,
              },
            },
          },
        },
        data: {
          textBody: content.rawText,
          htmlBody: null,
          bodyRetentionState: 'TEMPORARY',
          bodyExpiresAt: expiresAt,
          bodyRemovedAt: null,
        },
      })
      if (updated.count !== 1) changed()
      await writeAuditLogStrict(
        {
          actorType: syntheticActor ? 'SYSTEM' : 'HUMAN',
          actorId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'admin.prospect.reply_body_retained',
          targetType: 'ProspectEmailMessage',
          targetId: row.id,
          sourceReferences: [
            { type: 'ProspectEmailMessage', id: row.id },
            { type: 'ProspectEmailThread', id: row.threadId },
          ],
          beforeState: { bodyRetentionState: 'NOT_STORED' },
          afterState: {
            bodyRetentionState: 'TEMPORARY',
            expiresAt: expiresAt.toISOString(),
            contentHash: content.rawBodySha256,
            retentionDays: input.retentionDays,
            sourceReference: expected.sourceReference,
          },
        },
        tx,
      )
    }),
  )

  return {
    state: 'RETAINED' as const,
    canonicalMessageId: row.id,
    contentHash: content.rawBodySha256,
    expiresAt,
  }
}
