import { describe, expect, it, vi } from 'vitest'

vi.mock('../client', () => ({ db: {} }))

import {
  createOperatorSupportRequestAction,
  operatorSupportRequestOperationHash,
  OperatorSupportRequestError,
} from './support-operator-request-actions'

type Row = Record<string, unknown>

function memory() {
  const state = {
    venues: [{ id: 'venue_1', tenantId: 'tenant_1' }] as Row[],
    members: [
      { tenantId: 'tenant_1', userId: 'user_1', status: 'ACTIVE' },
      { tenantId: 'tenant_1', userId: 'user_gone', status: 'REMOVED' },
      { tenantId: 'tenant_2', userId: 'user_other', status: 'ACTIVE' },
    ] as Row[],
    questions: [
      { id: 'q1', tenantId: 'tenant_1', venueId: 'venue_1', question: 'Hours?', status: 'PENDING' },
      {
        id: 'q2',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Parking?',
        status: 'PENDING',
      },
      {
        id: 'q_done',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        question: 'Old',
        status: 'ANSWERED',
      },
      {
        id: 'q_other',
        tenantId: 'tenant_2',
        venueId: 'venue_9',
        question: 'Other',
        status: 'PENDING',
      },
    ] as Row[],
    requests: [] as Row[],
    messages: [] as Row[],
    events: [] as Row[],
    participants: [] as Row[],
    audits: [] as Row[],
  }
  const tx = {
    $executeRaw: async () => 0,
    supportMessage: {
      findFirst: async ({ where }: { where: Row }) => {
        const message = state.messages.find(
          (row) =>
            row.tenantId === where.tenantId &&
            row.submissionRequestId === where.submissionRequestId,
        )
        if (!message) return null
        const request = state.requests.find((row) => row.id === message.supportRequestId)!
        return { ...message, supportRequest: request }
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `message_${state.messages.length + 1}`, ...data }
        state.messages.push(row)
        return { id: row.id }
      },
    },
    venue: {
      findFirst: async ({ where }: { where: Row }) =>
        state.venues.find((row) => row.id === where.id && row.tenantId === where.tenantId) ?? null,
    },
    tenantMembership: {
      findFirst: async ({ where }: { where: Row }) =>
        state.members.find(
          (row) =>
            row.tenantId === where.tenantId &&
            row.userId === where.userId &&
            row.status === where.status,
        ) ?? null,
    },
    agentQuestion: {
      findMany: async ({
        where,
      }: {
        where: { tenantId: string; venueId: string; id: { in: string[] } }
      }) =>
        state.questions.filter(
          (row) =>
            row.tenantId === where.tenantId &&
            row.venueId === where.venueId &&
            where.id.in.includes(row.id as string),
        ),
    },
    supportRequest: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: `request_${state.requests.length + 1}`, ...data }
        state.requests.push(row)
        return { id: row.id, status: row.status, version: row.version }
      },
    },
    supportRequestAuditEvent: {
      create: async ({ data }: { data: Row }) => {
        state.events.push(data)
        return { id: 'e' }
      },
    },
    supportRequestParticipant: {
      create: async ({ data }: { data: Row }) => {
        state.participants.push(data)
        return { id: 'p' }
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.audits.push(data)
        return data
      },
    },
  }
  return {
    state,
    client: { $transaction: async <T>(work: (t: typeof tx) => Promise<T>) => work(tx) },
  }
}

const OPERATION = '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60'
const input = {
  operationId: OPERATION,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  category: 'GENERAL' as const,
  subject: 'Menu photos',
  body: 'Could you send current menu photos?',
  priority: 'HIGH' as const,
  recipientUserId: 'user_1',
  questionIds: [] as string[],
  actor: { actorId: 'operator_1', auditRole: 'PLATFORM_ADMIN' as const },
}
const run = (store: ReturnType<typeof memory>, overrides: Partial<typeof input> = {}) =>
  createOperatorSupportRequestAction({ ...input, ...overrides }, store.client as never)

describe('createOperatorSupportRequestAction', () => {
  it('creates an open request with a client-visible first message, access for the recipient and an audit', async () => {
    const store = memory()

    const saved = await run(store)

    expect(saved).toMatchObject({ status: 'OPEN', requestVersion: 1, replayed: false })
    expect(store.state.requests[0]).toMatchObject({
      tenantId: 'tenant_1',
      createdByKind: 'OPERATOR',
      requesterUserId: null,
      artifacts: { operatorCreated: true, operatorPriority: 'HIGH' },
    })
    expect(store.state.messages[0]).toMatchObject({
      visibility: 'CLIENT_VISIBLE',
      authorKind: 'OPERATOR',
      submissionRequestId: OPERATION,
      requestVersion: 1,
    })
    expect(store.state.participants[0]).toMatchObject({
      userId: 'user_1',
      grantedByKind: 'OPERATOR',
    })
    expect(store.state.events[0]).toMatchObject({ eventType: 'REQUEST_CREATED', requestVersion: 1 })
    expect(store.state.audits[0]).toMatchObject({
      action: 'support-request.created-by-operator',
      tenantId: 'tenant_1',
    })
    expect(JSON.stringify(store.state.audits)).not.toContain('menu photos')
  })

  it('waits for the client and keeps the linked question text as its checklist', async () => {
    const store = memory()

    const saved = await run(store, { questionIds: ['q2', 'q1'] })

    expect(saved).toMatchObject({
      status: 'WAITING_FOR_CLIENT',
      questionTexts: ['Parking?', 'Hours?'],
    })
    expect(store.state.requests[0]).toMatchObject({
      missingInformation: ['Parking?', 'Hours?'],
      artifacts: { linkedQuestionIds: ['q2', 'q1'] },
    })
  })

  it('replays the same operation to the same request and refuses a changed replay', async () => {
    const store = memory()

    const first = await run(store)
    const replay = await run(store)

    expect(replay).toMatchObject({
      requestId: first.requestId,
      messageId: first.messageId,
      replayed: true,
    })
    expect(store.state.requests).toHaveLength(1)
    await expect(run(store, { body: 'Something else entirely' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(run(store, { recipientUserId: 'user_gone' })).rejects.toBeInstanceOf(
      OperatorSupportRequestError,
    )
    expect(store.state.requests).toHaveLength(1)
  })

  it.each([
    ['a member of another tenant', { recipientUserId: 'user_other' }],
    ['a removed member', { recipientUserId: 'user_gone' }],
    ['an unknown user', { recipientUserId: 'nobody' }],
    ['a venue of another tenant', { venueId: 'venue_9' }],
    ['a question of another tenant', { questionIds: ['q_other'] }],
    ['an unknown question', { questionIds: ['missing'] }],
  ])('refuses %s without creating anything', async (_name, overrides) => {
    const store = memory()

    await expect(run(store, overrides)).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(store.state.requests).toHaveLength(0)
    expect(store.state.messages).toHaveLength(0)
    expect(store.state.participants).toHaveLength(0)
  })

  it('refuses a question that is no longer pending and duplicate question ids', async () => {
    const store = memory()

    await expect(run(store, { questionIds: ['q_done'] })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(run(store, { questionIds: ['q1', 'q1'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    expect(store.state.requests).toHaveLength(0)
  })

  it('hashes the operation independent of question order', () => {
    const base = { ...input, questionIds: ['q1', 'q2'] }
    const parsed = (value: unknown) => value as never
    expect(operatorSupportRequestOperationHash(parsed(base))).toBe(
      operatorSupportRequestOperationHash(parsed({ ...base, questionIds: ['q2', 'q1'] })),
    )
    expect(operatorSupportRequestOperationHash(parsed(base))).not.toBe(
      operatorSupportRequestOperationHash(parsed({ ...base, priority: 'LOW' })),
    )
  })
})
