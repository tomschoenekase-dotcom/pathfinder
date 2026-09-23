import { z } from 'zod'
import { db } from '../client'
import {
  readNativeSalesSnapshot,
  salesHash,
  salesJson,
  ProspectSalesError,
  type SalesClient,
} from './prospect-sales-snapshot'

const syntheticId = z.string().regex(/^SYN-[A-Za-z0-9_-]{1,150}$/u)
const stamp = z.string().datetime()
const fixtureSchema = z
  .object({
    venueId: z.string().min(1).max(191),
    expectedSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    synthetic: z.literal(true),
    SEND_AUTHORIZED: z.literal(false),
    threadId: syntheticId,
    providerThreadId: syntheticId,
    accountId: syntheticId,
    accountExternalId: syntheticId,
    ownerAddress: z
      .string()
      .email()
      .refine((value) => value.endsWith('@example.invalid')),
    recipientAddress: z.string().email(),
    contactId: z.string().min(1).max(191).nullable(),
    subject: z
      .string()
      .min(1)
      .max(160)
      .refine((value) => !/[\r\n\0]/u.test(value)),
    messages: z
      .array(
        z
          .object({
            id: syntheticId,
            providerMessageId: syntheticId,
            direction: z.enum(['INBOUND', 'OUTBOUND']),
            body: z.string().min(1).max(2500),
            occurredAt: stamp,
            references: z.array(syntheticId).max(10),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    actorId: z
      .string()
      .regex(/^synthetic:crm-sales:/u)
      .max(191),
  })
  .strict()
export type SyntheticSalesThreadInput = z.infer<typeof fixtureSchema>

function localFixtureOnly() {
  let target: URL
  try {
    target = new URL(process.env.DATABASE_URL ?? '')
  } catch {
    throw new ProspectSalesError('FORBIDDEN', 'Exact retained local database required')
  }
  if (
    process.env.TORCHIKO_LOCAL_CRM_SALES_ENABLED !== '1' ||
    process.env.NODE_ENV !== 'development' ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '58617' ||
    target.pathname !== '/pathfinder_disposable_crm_research_20260919' ||
    target.search ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== process.env.DATABASE_URL) ||
    process.env.APP_ENV === 'production'
  )
    throw new ProspectSalesError(
      'FORBIDDEN',
      'Synthetic acceptance is restricted to the retained local database',
    )
}

/**
 * Bounded create-only native correspondence adapter for local acceptance, never an
 * HTTP/admin procedure. SENT here is visibly SYNTHETIC historical input, not delivery.
 * Replays do not touch lastSeen/updatedAt. Existing message identities are immutable.
 */
export async function admitSyntheticSalesThread(
  value: SyntheticSalesThreadInput,
  client: SalesClient = db,
) {
  localFixtureOnly()
  const input = fixtureSchema.parse(value)
  const ids = new Set(input.messages.map((message) => message.id))
  if (
    ids.size !== input.messages.length ||
    new Set(input.messages.map((message) => message.providerMessageId)).size !== ids.size
  )
    throw new ProspectSalesError(
      'CONFLICT',
      'PROVIDER_MESSAGE_IDENTITY_CONFLICT: duplicate fixture identities',
    )
  const now = new Date()
  for (const message of input.messages) {
    if (
      new Date(message.occurredAt) > now ||
      message.references.some((id) => !ids.has(id) || id === message.id)
    )
      throw new ProspectSalesError(
        'INVALID_INPUT',
        'Message time or reference is not an authoritative bounded snapshot',
      )
    for (const parentId of message.references) {
      const parent = input.messages.find((item) => item.id === parentId)!
      if (new Date(parent.occurredAt) > new Date(message.occurredAt))
        throw new ProspectSalesError('CONFLICT', 'Reply predates its referenced message')
    }
  }
  return client.$transaction(
    async (tx) => {
      const native = await readNativeSalesSnapshot(input.venueId, tx)
      if (native.snapshotHash !== input.expectedSnapshotHash)
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_NATIVE_SNAPSHOT: ingestion cannot overwrite newer correspondence',
        )
      if (
        input.contactId &&
        !native.contacts.some(
          (contact) =>
            contact.id === input.contactId &&
            contact.normalizedEmail === input.recipientAddress.toLowerCase(),
        )
      )
        throw new ProspectSalesError(
          'CONFLICT',
          'Fixture contact is outside this native venue/routing scope',
        )
      const account = await tx.correspondenceProviderAccount.findUnique({
        where: { id: input.accountId },
      })
      if (
        account &&
        (account.provider !== 'FAKE' ||
          account.externalAccountId !== input.accountExternalId ||
          account.mailboxAddress !== input.ownerAddress ||
          account.connectionStatus !== 'DISABLED' ||
          account.deliveryEnabled ||
          account.capabilities.length ||
          account.credentialReferenceId ||
          account.syncCursor)
      )
        throw new ProspectSalesError('CONFLICT', 'PROVIDER_ACCOUNT_IDENTITY_CONFLICT')
      const mapping = await tx.prospectEmailThreadProvider.findUnique({
        where: {
          providerAccountId_providerThreadId: {
            providerAccountId: input.accountId,
            providerThreadId: input.providerThreadId,
          },
        },
      })
      if (mapping && mapping.threadId !== input.threadId)
        throw new ProspectSalesError('CONFLICT', 'PROVIDER_THREAD_IDENTITY_CONFLICT')
      const existing = await tx.prospectEmailThread.findUnique({
        where: { id: input.threadId },
        include: { messages: true, providerMappings: true },
      })
      if (
        existing &&
        (existing.venueId !== input.venueId ||
          existing.organizationId !== native.organization.id ||
          existing.contactId !== input.contactId ||
          existing.subject !== input.subject ||
          existing.providerMappings.length !== 1 ||
          existing.providerMappings[0]?.providerAccountId !== input.accountId ||
          existing.providerMappings[0]?.providerThreadId !== input.providerThreadId)
      )
        throw new ProspectSalesError('CONFLICT', 'NATIVE_THREAD_IDENTITY_CONFLICT')
      if (existing?.messages.some((message) => !ids.has(message.id)))
        throw new ProspectSalesError(
          'CONFLICT',
          'STALE_THREAD_SNAPSHOT: existing messages cannot disappear',
        )
      const pending = []
      for (const message of input.messages) {
        const data = {
          id: message.id,
          threadId: input.threadId,
          organizationId: native.organization.id,
          venueId: input.venueId,
          contactId: input.contactId,
          providerAccountId: input.accountId,
          providerMessageId: message.providerMessageId,
          direction: message.direction,
          status: message.direction === 'INBOUND' ? ('RECEIVED' as const) : ('SENT' as const),
          subject: input.subject,
          textBody: message.body,
          references: message.references,
          fromAddress:
            message.direction === 'INBOUND' ? input.recipientAddress : input.ownerAddress,
          toAddresses: [
            message.direction === 'INBOUND' ? input.ownerAddress : input.recipientAddress,
          ],
          ccAddresses: [],
          bccAddresses: [],
          occurredAt: new Date(message.occurredAt),
          sourceReference: `synthetic:crm-sales:${input.threadId}:${message.id}`,
          bodyPreview: message.body.slice(0, 500),
          // Explicit retained historical fixture, not a live provider body marked NOT_STORED.
          bodyRetentionState: 'LEGACY_REVIEW_REQUIRED' as const,
        }
        const collision = await tx.prospectEmailMessage.findMany({
          where: {
            OR: [
              { id: message.id },
              { providerAccountId: input.accountId, providerMessageId: message.providerMessageId },
            ],
          },
        })
        if (collision.length) {
          const previous = collision[0]!
          const exact = Object.fromEntries(
            Object.keys(data).map((key) => [key, previous[key as keyof typeof previous]]),
          )
          if (collision.length !== 1 || salesHash(salesJson(exact)) !== salesHash(salesJson(data)))
            throw new ProspectSalesError(
              'CONFLICT',
              'PROVIDER_MESSAGE_IDENTITY_CONFLICT: same identity cannot carry changed content or scope',
            )
        } else pending.push(data)
      }
      if (existing && pending.length === 0)
        return { threadId: existing.id, createdMessages: 0, replayed: true, SEND_AUTHORIZED: false }
      if (!account)
        await tx.correspondenceProviderAccount.create({
          data: {
            id: input.accountId,
            provider: 'FAKE',
            externalAccountId: input.accountExternalId,
            mailboxAddress: input.ownerAddress,
            displayName: 'SYNTHETIC CRM acceptance — no live mailbox',
            capabilities: [],
            connectionStatus: 'DISABLED',
            deliveryEnabled: false,
            dailySendCap: 0,
            createdBy: input.actorId,
            updatedBy: input.actorId,
          },
        })
      const latestAt = new Date(
        Math.max(...input.messages.map((message) => new Date(message.occurredAt).getTime())),
      )
      if (!existing)
        await tx.prospectEmailThread.create({
          data: {
            id: input.threadId,
            organizationId: native.organization.id,
            venueId: input.venueId,
            contactId: input.contactId,
            subject: input.subject,
            replyTokenHash: salesHash({ synthetic: input.threadId }),
            lastMessageAt: latestAt,
          },
        })
      if (!mapping)
        await tx.prospectEmailThreadProvider.create({
          data: {
            id:
              'SYN-map-' +
              salesHash({
                accountId: input.accountId,
                providerThreadId: input.providerThreadId,
              }).slice(0, 24),
            threadId: input.threadId,
            providerAccountId: input.accountId,
            providerThreadId: input.providerThreadId,
          },
        })
      for (const data of pending) await tx.prospectEmailMessage.create({ data })
      if (existing)
        await tx.prospectEmailThread.update({
          where: { id: existing.id },
          data: { lastMessageAt: latestAt },
        })
      await tx.prospectActivity.create({
        data: {
          organizationId: native.organization.id,
          venueId: input.venueId,
          contactId: input.contactId,
          type: 'NOTE_ADDED',
          summary: 'SYNTHETIC correspondence fixture ingested — no provider contacted',
          evidence: {
            schema: 'torchiko.synthetic-correspondence-acceptance/1',
            threadId: input.threadId,
            messageIds: pending.map((message) => message.id),
            fixtureInputHash: salesHash(input),
            SEND_AUTHORIZED: false,
          },
          actorId: input.actorId,
        },
      })
      return {
        threadId: input.threadId,
        createdMessages: pending.length,
        replayed: false,
        SEND_AUTHORIZED: false,
      }
    },
    { isolationLevel: 'Serializable', timeout: 15000 },
  )
}
