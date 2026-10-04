import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client', () => ({ db: {} }))
vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn(async () => undefined) }))

import {
  beginClientNotificationEmailDelivery,
  ClientNotificationError,
  clientNotificationContentHash,
  completeClientNotificationEmailDelivery,
  createClientNotificationIntent,
  failQueuedClientNotificationEmail,
  reconcileClientNotificationEmail,
  requeueClientNotificationEmail,
  type ClientNotificationContent,
} from './client-notification-intents'

type Row = Record<string, unknown>

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const filter = expected as { in?: unknown[]; gt?: Date }
      if (filter.in) return filter.in.includes(actual)
      if (filter.gt) return (actual as Date).getTime() > filter.gt.getTime()
    }
    return actual === expected
  })
}

/** A tiny in-memory stand-in for exactly the tables the notification helper touches. */
function memory() {
  const state = {
    memberships: [] as Row[],
    intents: [] as Row[],
    receipts: [] as Row[],
    requests: [] as Row[],
    messages: [] as Row[],
    questions: [] as Row[],
    ids: 0,
  }
  const next = (prefix: string) => `${prefix}_${++state.ids}`
  const pick = (row: Row | undefined, select?: Row) => {
    if (!row) return null
    if (!select) return { ...row }
    return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
  }
  const tx = {
    tenantMembership: {
      findFirst: async ({ where }: { where: Row }) =>
        state.memberships.find((row) => matches(row, where)) ?? null,
    },
    clientNotificationIntent: {
      findFirst: async ({ where, select }: { where: Row; select?: Row }) =>
        pick(
          state.intents.find((row) => matches(row, where)),
          select,
        ),
      create: async ({ data, select }: { data: Row; select?: Row }) => {
        const row = {
          id: next('intent'),
          emailAttemptCount: 0,
          createdAt: new Date(`2026-10-02T10:00:${String(state.ids).padStart(2, '0')}.000Z`),
          emailLastErrorCode: null,
          ...data,
        }
        state.intents.push(row)
        return pick(row, select)
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const found = state.intents.filter((row) => matches(row, where))
        for (const row of found) {
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              value && typeof value === 'object' && 'increment' in (value as Row)
                ? (row[key] as number) + ((value as Row).increment as number)
                : value
          }
        }
        return { count: found.length }
      },
    },
    clientNotificationReceipt: {
      create: async ({ data }: { data: Row }) => {
        state.receipts.push({ id: next('receipt'), ...data })
        return { id: 'r' }
      },
    },
    supportRequest: {
      findMany: async ({ where }: { where: { id: { in: string[] } } & Row }) =>
        state.requests.filter((row) => where.id.in.includes(row.id as string)),
    },
    supportMessage: {
      findMany: async ({ where }: { where: Row }) =>
        state.messages.filter((row) =>
          matches(row, {
            authorKind: where.authorKind,
            createdAt: where.createdAt,
          }),
        ),
    },
    agentQuestion: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        state.questions.filter((row) => where.id.in.includes(row.id as string)),
    },
  }
  const client = { $transaction: async <T>(work: (t: typeof tx) => Promise<T>) => work(tx) }
  return { state, tx, client }
}

const content: ClientNotificationContent = {
  version: 1,
  subject: 'Two questions',
  intro: 'We need two answers',
  items: [
    { text: 'Opening hours?', requestId: 'request_1', questionId: 'question_1' },
    { text: 'Parking?', requestId: 'request_2', questionId: 'question_2' },
  ],
}
const baseInput = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  supportRequestId: 'request_1',
  supportMessageId: 'message_1',
  requestVersion: 1,
  questionIds: ['question_1', 'question_2'],
  recipientUserId: 'user_1',
  recipientEmail: 'owner@example.com' as string | null,
  emailRequested: true,
  emailEnabled: true,
  content,
  actor: { actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' },
}

function seed() {
  const store = memory()
  store.state.memberships.push({ tenantId: 'tenant_1', userId: 'user_1', status: 'ACTIVE' })
  store.state.requests.push(
    { id: 'request_1', status: 'WAITING_FOR_CLIENT' },
    { id: 'request_2', status: 'WAITING_FOR_CLIENT' },
  )
  store.state.questions.push(
    { id: 'question_1', status: 'PENDING' },
    { id: 'question_2', status: 'PENDING' },
  )
  return store
}

const create = (store: ReturnType<typeof memory>, overrides: Partial<typeof baseInput> = {}) =>
  createClientNotificationIntent(store.tx as never, { ...baseInput, ...overrides })

const statuses = (store: ReturnType<typeof memory>) =>
  store.state.receipts.map((receipt) => receipt.status)

describe('createClientNotificationIntent', () => {
  it('creates one intent with a portal receipt and a queued email receipt, and replays to the same one', async () => {
    const store = seed()

    const first = await create(store)
    const replay = await create(store)

    expect(first.created).toBe(true)
    expect(replay).toMatchObject({ created: false, intent: { id: first.intent.id } })
    expect(store.state.intents).toHaveLength(1)
    expect(statuses(store)).toEqual(['PORTAL_POSTED', 'EMAIL_QUEUED'])
    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'QUEUED',
      emailGeneration: 1,
      recipientEmail: 'owner@example.com',
      contentHash: clientNotificationContentHash(content, {
        supportRequestId: 'request_1',
        requestVersion: 1,
        recipientUserId: 'user_1',
      }),
    })
    expect(store.state.intents[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('is a different intent for a different revision, recipient or content', async () => {
    const store = seed()
    store.state.memberships.push({ tenantId: 'tenant_1', userId: 'user_2', status: 'ACTIVE' })

    await create(store)
    await create(store, { requestVersion: 2 })
    await create(store, { recipientUserId: 'user_2' })
    await create(store, { content: { ...content, intro: 'Different' } })

    expect(store.state.intents).toHaveLength(4)
  })

  it('refuses a recipient who is not an active member of this tenant', async () => {
    const store = seed()
    store.state.memberships.push({ tenantId: 'tenant_2', userId: 'user_9', status: 'ACTIVE' })
    store.state.memberships.push({ tenantId: 'tenant_1', userId: 'user_3', status: 'SUSPENDED' })

    for (const recipientUserId of ['user_9', 'user_3', 'nobody']) {
      await expect(create(store, { recipientUserId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(store.state.intents).toHaveLength(0)
  })

  it('records the portal post but no queued email when the deployment switch is off', async () => {
    const store = seed()

    await create(store, { emailEnabled: false })

    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'EMAIL_DELIVERY_DISABLED',
    })
    expect(statuses(store)).toEqual(['PORTAL_POSTED', 'EMAIL_FAILED'])
  })

  it('never invents an address: no verified email is a failed, non-retryable email', async () => {
    const store = seed()

    await create(store, { recipientEmail: null })

    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'NO_VERIFIED_EMAIL',
      recipientEmail: null,
    })
    await expect(
      requeueClientNotificationEmail(
        { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled: true },
        store.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('creates a portal-only intent when no email was requested', async () => {
    const store = seed()

    await create(store, { emailRequested: false })

    expect(store.state.intents[0]).toMatchObject({ emailStatus: null, emailRequested: false })
    expect(statuses(store)).toEqual(['PORTAL_POSTED'])
  })
})

describe('email delivery state machine', () => {
  let store: ReturnType<typeof memory>
  const identity = { tenantId: 'tenant_1', intentId: 'intent_1', generation: 1 }

  beforeEach(async () => {
    store = seed()
    await create(store)
  })

  const begin = (overrides: Partial<typeof identity> = {}) =>
    beginClientNotificationEmailDelivery({ ...identity, ...overrides }, store.client as never)
  const complete = (
    outcome: Parameters<typeof completeClientNotificationEmailDelivery>[0]['outcome'],
  ) => completeClientNotificationEmailDelivery({ ...identity, outcome }, store.client as never)

  it('hands the only send claim to the first caller and the exact frozen content to send', async () => {
    const decision = await begin()

    expect(decision).toMatchObject({
      action: 'send',
      to: 'owner@example.com',
      venueId: 'venue_1',
      generation: 1,
    })
    expect(decision.action === 'send' && decision.openItems).toHaveLength(2)
    expect(store.state.intents[0]).toMatchObject({ emailStatus: 'SENDING', emailAttemptCount: 1 })
  })

  it('mints one unguessable Message-ID anchor with the claim when a sending domain is given', async () => {
    const decision = await begin({ messageIdDomain: 'mail.example.com' } as never)

    expect(decision.action === 'send' && decision.rfcMessageId).toMatch(
      /^<ci\.[0-9a-f]{48}@mail\.example\.com>$/u,
    )
    expect(store.state.intents[0]!.emailRfcMessageId).toBe(
      decision.action === 'send' ? decision.rfcMessageId : null,
    )
  })

  it('mints no anchor without a sending domain', async () => {
    const decision = await begin()

    expect(decision.action === 'send' && decision.rfcMessageId).toBeNull()
    expect(store.state.intents[0]!.emailRfcMessageId).toBeUndefined()
  })

  it('treats a claim that never reported as unknown and never offers it for sending again', async () => {
    await begin()

    const second = await begin()
    const third = await begin()

    expect(second).toEqual({ action: 'skip', reason: 'UNKNOWN_NEEDS_RECONCILIATION' })
    expect(third).toEqual({ action: 'skip', reason: 'UNKNOWN_NEEDS_RECONCILIATION' })
    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'UNKNOWN',
      emailLastErrorCode: 'ATTEMPT_INTERRUPTED',
      emailAttemptCount: 1,
    })
    expect(statuses(store).filter((status) => status === 'EMAIL_UNKNOWN')).toHaveLength(1)
  })

  it('records sent once and refuses to send a sent email again', async () => {
    await begin()
    await expect(complete({ kind: 'sent', providerMessageId: 'provider_1' })).resolves.toEqual({
      recorded: true,
    })

    expect(await begin()).toEqual({ action: 'skip', reason: 'ALREADY_SENT' })
    await expect(complete({ kind: 'sent', providerMessageId: 'provider_1' })).resolves.toEqual({
      recorded: false,
    })
    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'SENT',
      emailProviderMessageId: 'provider_1',
    })
    expect(statuses(store).filter((status) => status === 'EMAIL_SENT')).toHaveLength(1)
  })

  it('retries only the failed email channel, under a new generation, never reposting to the portal', async () => {
    await begin()
    await complete({ kind: 'failed', errorCode: 'PROVIDER_REJECTED' })
    const portalBefore = statuses(store).filter((status) => status === 'PORTAL_POSTED').length

    const requeued = await requeueClientNotificationEmail(
      { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled: true },
      store.client as never,
    )

    expect(requeued).toEqual({ intentId: 'intent_1', generation: 2 })
    expect(statuses(store).filter((status) => status === 'PORTAL_POSTED')).toHaveLength(
      portalBefore,
    )
    expect(statuses(store).at(-1)).toBe('EMAIL_QUEUED')
    // The old job (generation 1) can no longer act; the new one delivers.
    expect(await begin()).toEqual({ action: 'skip', reason: 'STALE_GENERATION' })
    expect(await begin({ generation: 2 })).toMatchObject({ action: 'send', generation: 2 })
  })

  it('does not requeue a sent, unknown, in-flight or disabled email', async () => {
    const requeue = (emailEnabled = true) =>
      requeueClientNotificationEmail(
        { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled },
        store.client as never,
      )
    await expect(requeue()).rejects.toMatchObject({ code: 'CONFLICT' }) // queued, not failed
    await begin()
    await expect(requeue()).rejects.toMatchObject({ code: 'CONFLICT' }) // sending
    await complete({ kind: 'unknown', errorCode: 'PROVIDER_CALL_INTERRUPTED' })
    await expect(requeue()).rejects.toMatchObject({ code: 'CONFLICT' }) // unknown
    await expect(requeue(false)).rejects.toBeInstanceOf(ClientNotificationError)
    expect(store.state.intents[0]).toMatchObject({ emailStatus: 'UNKNOWN', emailGeneration: 1 })
  })

  it('refuses to send an unknown outcome until a person reconciles it', async () => {
    await begin()
    await complete({ kind: 'unknown', errorCode: 'PROVIDER_CALL_INTERRUPTED' })

    expect(await begin()).toEqual({ action: 'skip', reason: 'UNKNOWN_NEEDS_RECONCILIATION' })

    await reconcileClientNotificationEmail(
      { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', outcome: 'NOT_SENT' },
      store.client as never,
    )
    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'RECONCILED_NOT_SENT',
    })
    await expect(
      requeueClientNotificationEmail(
        { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled: true },
        store.client as never,
      ),
    ).resolves.toMatchObject({ generation: 2 })
  })

  it('closes an unknown outcome as sent when a person confirms the provider delivered it', async () => {
    await begin()
    await complete({ kind: 'unknown', errorCode: 'PROVIDER_CALL_INTERRUPTED' })

    await reconcileClientNotificationEmail(
      {
        tenantId: 'tenant_1',
        intentId: 'intent_1',
        actorId: 'operator_1',
        outcome: 'SENT',
        providerMessageId: 'provider_9',
      },
      store.client as never,
    )

    expect(store.state.intents[0]).toMatchObject({ emailStatus: 'SENT' })
    expect(await begin()).toEqual({ action: 'skip', reason: 'ALREADY_SENT' })
    await expect(
      reconcileClientNotificationEmail(
        { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', outcome: 'NOT_SENT' },
        store.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('can mark a never-queued job as failed, retryable, without touching a sent email', async () => {
    await failQueuedClientNotificationEmail(
      { ...identity, errorCode: 'ENQUEUE_FAILED' },
      store.client as never,
    )

    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'ENQUEUE_FAILED',
    })
    await requeueClientNotificationEmail(
      { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled: true },
      store.client as never,
    )
    await begin({ generation: 2 })
    await completeClientNotificationEmailDelivery(
      { ...identity, generation: 2, outcome: { kind: 'sent' } },
      store.client as never,
    )
    await failQueuedClientNotificationEmail(
      { ...identity, generation: 2, errorCode: 'LATE' },
      store.client as never,
    )
    expect(store.state.intents[0]).toMatchObject({ emailStatus: 'SENT' })
  })

  it('stops an email for a question that was answered, declined or superseded', async () => {
    store.state.questions.find((row) => row.id === 'question_1')!.status = 'ANSWERED'
    store.state.questions.find((row) => row.id === 'question_2')!.status = 'DISMISSED'

    expect(await begin()).toEqual({ action: 'skip', reason: 'SUPERSEDED' })

    expect(store.state.intents[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'SUPERSEDED',
    })
    await expect(
      requeueClientNotificationEmail(
        { tenantId: 'tenant_1', intentId: 'intent_1', actorId: 'operator_1', emailEnabled: true },
        store.client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('asks only the questions that are still open', async () => {
    store.state.questions.find((row) => row.id === 'question_1')!.status = 'ANSWERED'

    const decision = await begin()

    expect(decision.action === 'send' && decision.openItems.map((item) => item.text)).toEqual([
      'Parking?',
    ])
  })

  it('stops the email once the customer has replied after the portal post', async () => {
    store.state.messages.push({
      authorKind: 'CLIENT',
      supportRequestId: 'request_1',
      createdAt: new Date('2099-01-01T00:00:00.000Z'),
    })
    store.state.messages.push({
      authorKind: 'CLIENT',
      supportRequestId: 'request_2',
      createdAt: new Date('2099-01-01T00:00:00.000Z'),
    })

    expect(await begin()).toEqual({ action: 'skip', reason: 'SUPERSEDED' })
  })

  it('does not send to a recipient who is no longer an active member', async () => {
    store.state.memberships[0]!.status = 'REMOVED'

    expect(await begin()).toEqual({ action: 'skip', reason: 'RECIPIENT_INACTIVE' })
    expect(store.state.intents[0]).toMatchObject({ emailLastErrorCode: 'RECIPIENT_INACTIVE' })
  })

  it('does not send content that no longer matches its frozen hash', async () => {
    const snapshot = store.state.intents[0]!.contentSnapshot as ClientNotificationContent
    snapshot.intro = 'Tampered'

    expect(await begin()).toEqual({ action: 'skip', reason: 'CONTENT_MISMATCH' })
    expect(store.state.intents[0]).toMatchObject({ emailLastErrorCode: 'CONTENT_MISMATCH' })
  })

  it("does not act on another tenant's intent", async () => {
    expect(await begin({ tenantId: 'tenant_2' })).toEqual({ action: 'skip', reason: 'NOT_FOUND' })
    expect(store.state.intents[0]).toMatchObject({ emailStatus: 'QUEUED' })
  })
})
