/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed in-memory database */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appendSupportMessageAction: vi.fn(),
  requestSupportInformationAction: vi.fn(),
  createClientOnboardingQuestionAction: vi.fn(),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  appendSupportMessageAction: mocks.appendSupportMessageAction,
  requestSupportInformationAction: mocks.requestSupportInformationAction,
  createClientOnboardingQuestionAction: mocks.createClientOnboardingQuestionAction,
}))
vi.mock('@pathfinder/auth', () => ({ resolveVerifiedMemberEmail: vi.fn() }))
vi.mock('@pathfinder/jobs', () => ({ enqueueClientNotificationEmail: vi.fn() }))

import { setNotificationDepsForTests } from '../notifications'
import { OperatorStaleError } from '../proposals'
import { onboardingQuestionOperationId, onboardingQuestionsKind } from './onboarding-questions'
import {
  supportClientReplyKind,
  supportCreateRequestKind,
  supportInformationRequestKind,
} from './support'

type Row = Record<string, any>

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return (expected as Row[]).some((branch) => matches(row, branch))
    const actual = row[key]
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const filter = expected as Row
      if ('in' in filter) return (filter.in as unknown[]).includes(actual)
      if ('has' in filter) return (actual as unknown[]).includes(filter.has)
      if ('gt' in filter) return actual.getTime() > filter.gt.getTime()
      if ('is' in filter) return filter.is === null ? !actual : true
    }
    return actual === expected
  })
}

function memoryDatabase() {
  let clock = 0
  const tables = {
    tenant: [{ id: 'tenant_1' }, { id: 'tenant_2' }] as Row[],
    venue: [
      { id: 'venue_1', tenantId: 'tenant_1' },
      { id: 'venue_9', tenantId: 'tenant_2' },
    ] as Row[],
    tenantMembership: [
      { id: 'm1', tenantId: 'tenant_1', userId: 'user_1', status: 'ACTIVE' },
      { id: 'm2', tenantId: 'tenant_1', userId: 'user_2', status: 'ACTIVE' },
      { id: 'm3', tenantId: 'tenant_2', userId: 'user_other', status: 'ACTIVE' },
    ] as Row[],
    agentQuestion: [
      {
        id: 'q1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'What are the opening hours?',
        status: 'PENDING',
        updatedAt: new Date('2026-10-01T10:00:00.000Z'),
      },
      {
        id: 'q2',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Is parking free?',
        status: 'PENDING',
        updatedAt: new Date('2026-10-01T11:00:00.000Z'),
      },
      {
        id: 'q_other',
        tenantId: 'tenant_2',
        venueId: 'venue_9',
        question: 'Other tenant question',
        status: 'PENDING',
        updatedAt: new Date('2026-10-01T11:00:00.000Z'),
      },
    ] as Row[],
    supportRequest: [] as Row[],
    supportMessage: [] as Row[],
    supportRequestAuditEvent: [] as Row[],
    supportRequestParticipant: [] as Row[],
    clientNotificationIntent: [] as Row[],
    clientNotificationReceipt: [] as Row[],
    auditLog: [] as Row[],
  }
  const stamp = () => new Date(Date.UTC(2026, 9, 2, 10, 0, ++clock))
  const generic = (name: keyof typeof tables) => ({
    findFirst: async ({ where }: { where: Row }) =>
      tables[name].find((row) => matches(row, where)) ?? null,
    findMany: async ({ where, take }: { where: Row; take?: number }) =>
      tables[name].filter((row) => matches(row, where)).slice(0, take ?? 1000),
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `${name}_${tables[name].length + 1}`,
        createdAt: stamp(),
        emailAttemptCount: 0,
        ...data,
      }
      tables[name].push(row)
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const found = tables[name].filter((row) => matches(row, where))
      for (const row of found) Object.assign(row, data)
      return { count: found.length }
    },
  })
  const database: Row = {
    $executeRaw: async () => 0,
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tables.tenant.find((row) => row.id === where.id) ?? null,
    },
    venue: generic('venue'),
    tenantMembership: generic('tenantMembership'),
    agentQuestion: generic('agentQuestion'),
    supportRequestAuditEvent: generic('supportRequestAuditEvent'),
    supportRequestParticipant: generic('supportRequestParticipant'),
    clientNotificationIntent: generic('clientNotificationIntent'),
    clientNotificationReceipt: generic('clientNotificationReceipt'),
    auditLog: generic('auditLog'),
    supportRequest: {
      ...generic('supportRequest'),
      findFirst: async ({ where }: { where: Row }) => {
        const request = tables.supportRequest.find((row) => matches(row, where))
        if (!request) return null
        return {
          ...request,
          requesterMembership: request.requesterUserId
            ? (tables.tenantMembership.find(
                (member) =>
                  member.tenantId === request.tenantId && member.userId === request.requesterUserId,
              ) ?? null)
            : null,
          participants: tables.supportRequestParticipant
            .filter((p) => p.supportRequestId === request.id && !p.revokedAt)
            .map((p) => ({
              ...p,
              membership: tables.tenantMembership.find(
                (member) => member.tenantId === p.tenantId && member.userId === p.userId,
              ),
            })),
        }
      },
    },
    supportMessage: {
      ...generic('supportMessage'),
      findFirst: async ({ where }: { where: Row }) => {
        const message = tables.supportMessage.find((row) => matches(row, where))
        if (!message) return null
        return {
          ...message,
          supportRequest: tables.supportRequest.find((row) => row.id === message.supportRequestId),
        }
      },
    },
  }
  database.$transaction = async (work: (tx: Row) => Promise<unknown>) => work(database)
  return { database, tables }
}

const grant = {
  grantId: 'grant_1',
  clientId: 'client_1',
  userId: 'user_owner',
  allTenants: false,
  tenantIds: ['tenant_1'],
  capabilities: ['support:propose', 'customers:propose'],
} as const
const OPERATION = '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60'
const actor = { type: 'HUMAN', id: 'user_owner', role: 'PLATFORM_ADMIN' } as const

let store: ReturnType<typeof memoryDatabase>
let enqueue: ReturnType<typeof vi.fn>
let emailEnabled: boolean
let verifiedEmail: string | null

const kindContext = () => ({
  database: store.database as never,
  grant: grant as never,
  now: new Date(),
})
const applyContext = (operationId = OPERATION, proposalId = 'proposal_1') => ({
  ...kindContext(),
  actor,
  proposalId,
  operationId,
})

beforeEach(() => {
  vi.resetAllMocks()
  store = memoryDatabase()
  enqueue = vi.fn(async () => undefined)
  emailEnabled = true
  verifiedEmail = 'owner@example.com'
  setNotificationDepsForTests({
    enqueueEmail: enqueue as never,
    emailEnabled: () => emailEnabled,
    resolveVerifiedEmail: async () => verifiedEmail,
  })
})
afterEach(() => setNotificationDepsForTests(null))

describe('support.propose_create_request', () => {
  const args = (overrides: Row = {}) =>
    supportCreateRequestKind.parse({
      operationId: OPERATION,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      recipientUserId: 'user_1',
      subject: 'A few questions',
      body: 'Could you help with these?',
      ...overrides,
    })

  it('defaults to a general, normal-priority, portal-only request', () => {
    expect(args()).toMatchObject({
      category: 'GENERAL',
      priority: 'NORMAL',
      questionIds: [],
      notifyByEmail: false,
    })
    expect(() => args({ questionIds: ['q1', 'q1'] })).toThrow()
    expect(() => args({ priority: 'EXTREME' })).toThrow()
    expect(() => args({ extra: true })).toThrow()
  })

  it.each([
    ['a member of another tenant', { recipientUserId: 'user_other' }],
    ['an unknown member', { recipientUserId: 'nobody' }],
    ['a question of another tenant', { questionIds: ['q_other'] }],
    ['an unknown question', { questionIds: ['missing'] }],
    ['a venue of another tenant', { venueId: 'venue_9' }],
  ])('refuses %s at proposal time as not found', async (_name, overrides) => {
    await expect(
      supportCreateRequestKind.authorize!(args(overrides), kindContext()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a tenant outside the grant', async () => {
    await expect(
      supportCreateRequestKind.authorize!(
        args({ tenantId: 'tenant_2', venueId: 'venue_9', recipientUserId: 'user_other' }),
        kindContext(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('goes stale when the recipient leaves or a linked question changes after the preview', async () => {
    const a = args({ questionIds: ['q1', 'q2'] })
    const proposed = await supportCreateRequestKind.targetVersion(a, kindContext())
    expect(await supportCreateRequestKind.currentVersion(a, kindContext())).toBe(proposed)

    store.tables.agentQuestion[0]!.updatedAt = new Date('2026-10-02T00:00:00.000Z')
    expect(await supportCreateRequestKind.currentVersion(a, kindContext())).not.toBe(proposed)
    store.tables.agentQuestion[0]!.updatedAt = new Date('2026-10-01T10:00:00.000Z')

    store.tables.agentQuestion[1]!.status = 'ANSWERED'
    expect(await supportCreateRequestKind.currentVersion(a, kindContext())).toBeNull()
    store.tables.agentQuestion[1]!.status = 'PENDING'

    store.tables.tenantMembership[0]!.status = 'REMOVED'
    expect(await supportCreateRequestKind.currentVersion(a, kindContext())).toBeNull()
  })

  it('creates a portal-only request, with no notification and nothing queued', async () => {
    const outcome = await supportCreateRequestKind.apply(args(), applyContext())

    expect(outcome.result).toMatchObject({
      status: 'OPEN',
      priority: 'NORMAL',
      portalOnly: true,
      portalPosted: true,
    })
    expect(outcome.result).not.toHaveProperty('notification')
    expect(store.tables.supportRequest).toHaveLength(1)
    expect(store.tables.supportRequestParticipant[0]).toMatchObject({ userId: 'user_1' })
    expect(store.tables.clientNotificationIntent).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('records one intent and queues one email to the verified address when asked and allowed', async () => {
    const outcome = await supportCreateRequestKind.apply(
      args({ notifyByEmail: true, questionIds: ['q2', 'q1'] }),
      applyContext(),
    )

    expect(outcome.result).toMatchObject({
      status: 'WAITING_FOR_CLIENT',
      portalOnly: false,
      notification: { portal: 'portal_posted', email: 'email_queued' },
    })
    expect(store.tables.clientNotificationIntent).toHaveLength(1)
    const intent = store.tables.clientNotificationIntent[0]!
    expect(intent).toMatchObject({
      tenantId: 'tenant_1',
      recipientUserId: 'user_1',
      recipientEmail: 'owner@example.com',
      emailStatus: 'QUEUED',
      emailGeneration: 1,
      questionIds: ['q2', 'q1'],
    })
    expect(intent.contentSnapshot.items.map((item: Row) => item.text)).toEqual([
      'Is parking free?',
      'What are the opening hours?',
    ])
    expect(store.tables.clientNotificationReceipt.map((r) => r.status)).toEqual([
      'PORTAL_POSTED',
      'EMAIL_QUEUED',
    ])
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      intentId: intent.id,
      generation: 1,
    })
  })

  it('posts to the portal but queues nothing while the deployment switch is off', async () => {
    emailEnabled = false

    const outcome = await supportCreateRequestKind.apply(
      args({ notifyByEmail: true }),
      applyContext(),
    )

    expect(outcome.result).toMatchObject({ notification: { email: 'email_failed' } })
    expect(store.tables.clientNotificationIntent[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'EMAIL_DELIVERY_DISABLED',
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('never emails an address the identity provider has not verified', async () => {
    verifiedEmail = null

    await supportCreateRequestKind.apply(args({ notifyByEmail: true }), applyContext())

    expect(store.tables.clientNotificationIntent[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'NO_VERIFIED_EMAIL',
      recipientEmail: null,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps the portal post and records a retryable failure when the queue is unreachable', async () => {
    enqueue.mockRejectedValue(new Error('redis down'))

    const outcome = await supportCreateRequestKind.apply(
      args({ notifyByEmail: true }),
      applyContext(),
    )

    expect(outcome.result).toMatchObject({
      portalPosted: true,
      notification: { portal: 'portal_posted', email: 'email_failed' },
    })
    expect(store.tables.supportRequest).toHaveLength(1)
    expect(store.tables.clientNotificationIntent[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'ENQUEUE_FAILED',
    })
  })

  it('replays to the same request without a second request, intent or new email generation', async () => {
    const a = args({ notifyByEmail: true })
    const first = await supportCreateRequestKind.apply(a, applyContext())
    const replay = await supportCreateRequestKind.apply(a, applyContext())

    expect(replay.after).toEqual(first.after)
    expect(store.tables.supportRequest).toHaveLength(1)
    expect(store.tables.clientNotificationIntent).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('reconciles an interrupted apply and re-offers the same queued email', async () => {
    const a = args({ notifyByEmail: true })
    await supportCreateRequestKind.apply(a, applyContext())
    enqueue.mockClear()

    const reconciled = await supportCreateRequestKind.reconcile!(a, applyContext())

    expect(reconciled).toMatchObject({
      state: 'applied',
      outcome: { result: { portalPosted: true, notification: { email: 'email_queued' } } },
    })
    // The same job identity: a real queue deduplicates it, so this can never send twice.
    expect(enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      intentId: store.tables.clientNotificationIntent[0]!.id,
      generation: 1,
    })
    expect(store.tables.supportRequest).toHaveLength(1)
    expect(
      await supportCreateRequestKind.reconcile!(
        a,
        applyContext('11111111-1111-4111-8111-111111111111'),
      ),
    ).toEqual({
      state: 'not_applied',
    })
  })

  it('treats a changed replay or a recipient of another tenant as a stale proposal', async () => {
    await supportCreateRequestKind.apply(args(), applyContext())

    await expect(
      supportCreateRequestKind.apply(args({ body: 'Entirely different' }), applyContext()),
    ).rejects.toBeInstanceOf(OperatorStaleError)
    await expect(
      supportCreateRequestKind.apply(
        args({ recipientUserId: 'user_other' }),
        applyContext('11111111-1111-4111-8111-111111111111'),
      ),
    ).rejects.toBeInstanceOf(OperatorStaleError)
    expect(store.tables.supportRequest).toHaveLength(1)
  })
})

describe('support.propose_client_reply', () => {
  const seedRequest = (overrides: Row = {}) =>
    store.tables.supportRequest.push({
      id: 'request_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      status: 'IN_REVIEW',
      version: 4,
      subject: 'Menu photos',
      ...overrides,
    })
  const args = (overrides: Row = {}) =>
    supportClientReplyKind.parse({
      operationId: OPERATION,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 4,
      body: 'Thanks, we have updated the menu.',
      ...overrides,
    })

  it('is bound to the version it was read at, so a newer customer message makes it stale', async () => {
    seedRequest()
    const a = args()
    const proposed = await supportClientReplyKind.targetVersion(a, kindContext())

    expect(proposed).toBe('4')
    expect(await supportClientReplyKind.currentVersion(a, kindContext())).toBe('4')

    // The customer writes again: the canonical append bumps the request version.
    store.tables.supportRequest[0]!.version = 5

    expect(await supportClientReplyKind.currentVersion(a, kindContext())).toBe('5')
    expect(await supportClientReplyKind.currentVersion(a, kindContext())).not.toBe(proposed)
  })

  it.each([
    ['another tenant', { tenantId: 'tenant_2', venueId: 'venue_9' }],
    ['another venue', { venueId: 'venue_9' }],
    ['an unknown request', { requestId: 'nope' }],
  ])('refuses a request in %s as not found', async (_name, overrides) => {
    seedRequest()
    await expect(
      supportClientReplyKind.authorize!(args(overrides), kindContext()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('appends one customer-visible operator message at the expected version, portal only', async () => {
    seedRequest()
    mocks.appendSupportMessageAction.mockResolvedValue({
      message: { id: 'message_9' },
      requestVersion: 5,
      status: 'IN_REVIEW',
      replayed: false,
    })

    const outcome = await supportClientReplyKind.apply(args(), applyContext())

    expect(mocks.appendSupportMessageAction).toHaveBeenCalledTimes(1)
    expect(mocks.appendSupportMessageAction.mock.calls[0]![0]).toMatchObject({
      operationId: OPERATION,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 4,
      visibility: 'CLIENT_VISIBLE',
      body: 'Thanks, we have updated the menu.',
      actor: { participantKind: 'OPERATOR', actorId: 'user_owner' },
    })
    expect(outcome.result).toMatchObject({ messageId: 'message_9', portalOnly: true })
    expect(enqueue).not.toHaveBeenCalled()
    expect(store.tables.clientNotificationIntent).toHaveLength(0)
  })

  it('reconciles from the message the operation id left behind', async () => {
    seedRequest()
    expect(await supportClientReplyKind.reconcile!(args(), applyContext())).toEqual({
      state: 'not_applied',
    })
    store.tables.supportMessage.push({
      id: 'message_9',
      tenantId: 'tenant_1',
      supportRequestId: 'request_1',
      submissionRequestId: OPERATION,
      requestVersion: 5,
      visibility: 'CLIENT_VISIBLE',
    })

    expect(await supportClientReplyKind.reconcile!(args(), applyContext())).toMatchObject({
      state: 'applied',
      outcome: { result: { messageId: 'message_9', portalOnly: true } },
    })
  })
})

describe('support.propose_information_request notification', () => {
  const seedRequest = (overrides: Row = {}) =>
    store.tables.supportRequest.push({
      id: 'request_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      status: 'IN_REVIEW',
      version: 4,
      subject: 'Menu photos',
      requesterUserId: 'user_1',
      ...overrides,
    })
  const args = (overrides: Row = {}) =>
    supportInformationRequestKind.parse({
      operationId: OPERATION,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      requestId: 'request_1',
      expectedVersion: 4,
      body: 'Please send current menu photos.',
      missingInformation: ['Photo of the lunch menu', 'Photo of the drinks menu'],
      ...overrides,
    })
  const postedByAction = () =>
    mocks.requestSupportInformationAction.mockImplementation(async (input: Row) => {
      const existing = store.tables.supportMessage.find(
        (row) => row.submissionRequestId === input.operationId,
      )
      const message =
        existing ??
        (await store.database.supportMessage.create({
          data: {
            tenantId: input.tenantId,
            supportRequestId: input.requestId,
            submissionRequestId: input.operationId,
            requestVersion: 5,
            visibility: 'CLIENT_VISIBLE',
          },
        }))
      return {
        message: { id: message.id },
        requestVersion: 6,
        status: 'WAITING_FOR_CLIENT',
        replayed: Boolean(existing),
      }
    })

  it('names no recipient: the only eligible person is used, never a guess among several', async () => {
    seedRequest()
    postedByAction()
    const alone = await supportInformationRequestKind.apply(args(), applyContext())
    expect(alone.result).toMatchObject({
      portalOnly: false,
      notification: { email: 'email_queued' },
    })
    expect(store.tables.clientNotificationIntent[0]).toMatchObject({ recipientUserId: 'user_1' })

    // A second eligible person makes the recipient ambiguous: portal only, nothing guessed.
    store.tables.clientNotificationIntent.length = 0
    enqueue.mockClear()
    store.tables.supportRequestParticipant.push({
      tenantId: 'tenant_1',
      supportRequestId: 'request_1',
      userId: 'user_2',
      revokedAt: null,
    })
    const ambiguous = await supportInformationRequestKind.apply(
      args(),
      applyContext('11111111-1111-4111-8111-111111111111'),
    )
    expect(ambiguous.result).toMatchObject({
      portalOnly: true,
      notification: { state: 'no_exact_recipient' },
    })
    expect(store.tables.clientNotificationIntent).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('accepts only a named recipient who can open this conversation in this tenant', async () => {
    seedRequest()
    store.tables.supportRequestParticipant.push({
      tenantId: 'tenant_1',
      supportRequestId: 'request_1',
      userId: 'user_2',
      revokedAt: null,
    })

    await expect(
      supportInformationRequestKind.authorize!(args({ recipientUserId: 'user_2' }), kindContext()),
    ).resolves.toBeUndefined()
    for (const recipientUserId of ['user_other', 'nobody'])
      await expect(
        supportInformationRequestKind.authorize!(args({ recipientUserId }), kindContext()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // A recipient who left after approval makes the proposal stale rather than misdirected.
    store.tables.tenantMembership[1]!.status = 'REMOVED'
    expect(
      await supportInformationRequestKind.currentVersion(
        args({ recipientUserId: 'user_2' }),
        kindContext(),
      ),
    ).toBeNull()
  })

  it('records one intent bound to the revision the message produced, with the checklist as content', async () => {
    seedRequest()
    postedByAction()

    await supportInformationRequestKind.apply(args(), applyContext())

    const intent = store.tables.clientNotificationIntent[0]!
    expect(intent).toMatchObject({
      requestVersion: 5,
      supportRequestId: 'request_1',
      emailStatus: 'QUEUED',
    })
    expect(intent.contentSnapshot).toMatchObject({
      subject: 'Information needed: Menu photos',
      items: [
        { text: 'Photo of the lunch menu', requestId: 'request_1' },
        { text: 'Photo of the drinks menu', requestId: 'request_1' },
      ],
    })
  })

  it('does not duplicate the intent on replay, and re-offers the same email job', async () => {
    seedRequest()
    postedByAction()

    await supportInformationRequestKind.apply(args(), applyContext())
    await supportInformationRequestKind.apply(args(), applyContext())

    expect(store.tables.clientNotificationIntent).toHaveLength(1)
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([
      {
        tenantId: 'tenant_1',
        intentId: store.tables.clientNotificationIntent[0]!.id,
        generation: 1,
      },
      {
        tenantId: 'tenant_1',
        intentId: store.tables.clientNotificationIntent[0]!.id,
        generation: 1,
      },
    ])
  })

  it('keeps the portal post when the email cannot be queued, and says the email failed', async () => {
    seedRequest()
    postedByAction()
    enqueue.mockRejectedValue(new Error('redis down'))

    const outcome = await supportInformationRequestKind.apply(args(), applyContext())

    expect(outcome.result).toMatchObject({
      portalPosted: true,
      notification: { portal: 'portal_posted', email: 'email_failed' },
    })
    expect(store.tables.clientNotificationIntent[0]).toMatchObject({
      emailStatus: 'FAILED',
      emailLastErrorCode: 'ENQUEUE_FAILED',
    })
  })
})

describe('customers.propose_onboarding_questions notification', () => {
  const args = (overrides: Row = {}) =>
    onboardingQuestionsKind.parse({
      operationId: OPERATION,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      recipientUserId: 'user_1',
      questions: [
        {
          questionId: 'q1',
          expectedUpdatedAt: '2026-10-01T10:00:00.000Z',
          subject: 'Opening hours',
          why: 'Visitors ask every day',
          effect: 'The guide answers hours correctly',
        },
        {
          questionId: 'q2',
          expectedUpdatedAt: '2026-10-01T11:00:00.000Z',
          subject: 'Parking',
          why: 'Visitors ask where to park',
          effect: 'The guide can give parking advice',
        },
      ],
      ...overrides,
    })
  const routedByAction = () =>
    mocks.createClientOnboardingQuestionAction.mockImplementation(async (input: Row) => {
      const request = await store.database.supportRequest.create({
        data: { tenantId: input.tenantId, venueId: input.venueId, status: 'WAITING_FOR_CLIENT' },
      })
      await store.database.supportMessage.create({
        data: {
          tenantId: input.tenantId,
          supportRequestId: request.id,
          submissionRequestId: input.operationId,
        },
      })
      return {
        link: {
          id: `link_${input.agentQuestionId}`,
          agentQuestionId: input.agentQuestionId,
          supportRequestId: request.id,
        },
      }
    })

  it('records one intent for the whole approved group, with every question and its own conversation', async () => {
    routedByAction()
    // The kind reads the rows' agentRun and link relations; the memory rows carry neither.
    const outcome = await onboardingQuestionsKind.apply(
      args(),
      applyContext(OPERATION, 'proposal_1'),
    )

    expect(store.tables.clientNotificationIntent).toHaveLength(1)
    const intent = store.tables.clientNotificationIntent[0]!
    expect(intent).toMatchObject({
      tenantId: 'tenant_1',
      recipientUserId: 'user_1',
      recipientEmail: 'owner@example.com',
      emailStatus: 'QUEUED',
      questionIds: ['q1', 'q2'],
    })
    expect(intent.contentSnapshot.items).toEqual([
      expect.objectContaining({
        text: 'What are the opening hours?',
        why: 'Visitors ask every day',
        effect: 'The guide answers hours correctly',
        questionId: 'q1',
      }),
      expect.objectContaining({ text: 'Is parking free?', questionId: 'q2' }),
    ])
    const requestIds = intent.contentSnapshot.items.map((item: Row) => item.requestId)
    expect(new Set(requestIds).size).toBe(2)
    expect(outcome.result).toMatchObject({
      portalPosted: true,
      workAuthorized: false,
      notification: { portal: 'portal_posted', email: 'email_queued', intentId: intent.id },
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(onboardingQuestionOperationId('proposal_1', 'q1')).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('does not email a recipient who is not an active member of this tenant', async () => {
    routedByAction()

    await expect(
      onboardingQuestionsKind.apply(args({ recipientUserId: 'user_other' }), applyContext()),
    ).rejects.toBeInstanceOf(OperatorStaleError)

    expect(store.tables.clientNotificationIntent).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
  })
})
