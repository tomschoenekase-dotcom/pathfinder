/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed in-memory database */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

const mocks = vi.hoisted(() => {
  class SupportPackageFulfillmentError extends Error {}
  return { readFulfillment: vi.fn(), SupportPackageFulfillmentError }
})

vi.mock('@pathfinder/db', () => ({
  readSupportPackageFulfillment: mocks.readFulfillment,
  SupportPackageFulfillmentError: mocks.SupportPackageFulfillmentError,
}))
vi.mock('@pathfinder/auth', () => ({ resolveVerifiedMemberEmail: vi.fn() }))
vi.mock('@pathfinder/jobs', () => ({ enqueueClientNotificationEmail: vi.fn() }))

import type { OperatorCallContext } from '../registry'
import { supportReadTools } from './support'

type Row = Record<string, any>

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute))
const DIGEST = 'c'.repeat(64)

function request(overrides: Row = {}): Row {
  return {
    id: 'request_1',
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    category: 'CONTENT_CORRECTION',
    status: 'IN_REVIEW',
    subject: 'Admission is stale',
    missingInformation: [],
    version: 7,
    clientVersion: 3,
    createdAt: at(0),
    updatedAt: at(5),
    statusChangedAt: at(2),
    clientActivityAt: at(4),
    createdByKind: 'OPERATOR',
    requesterUserId: 'user_1',
    artifacts: { operatorCreated: true, operatorPriority: 'URGENT' },
    _count: { packageHandoffs: 1, previewFeedback: 1, knowledgeChangeProposals: 1 },
    packageHandoffs: [{ id: 'handoff_1', venuePackageId: 'package_1', requestVersion: 3 }],
    previewFeedback: [{ id: 'feedback_1', venuePackageId: 'package_1' }],
    knowledgeChangeProposals: [{ id: 'proposal_1', status: 'DRAFT' }],
    agentRunLineages: [{ agentRunId: 'run_1', linkedRunStatus: 'COMPLETED', requestVersion: 4 }],
    onboardingQuestionLink: {
      id: 'link_1',
      agentQuestionId: 'question_1',
      answeredSupportMessageId: null,
      resumedAt: null,
    },
    participants: [{ userId: 'user_2' }],
    ...overrides,
  }
}

function fixture(rows: Row[], intents: Row[] = []) {
  const database: Row = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        ['tenant_1', 'tenant_2'].includes(where.id) ? { id: where.id } : null,
    },
    supportRequest: {
      findFirst: async ({ where }: { where: Row }) =>
        rows.find((row) => row.id === where.id && row.tenantId === where.tenantId) ?? null,
    },
    supportMessage: {
      count: async ({ where }: { where: Row }) => (where.visibility ? 1 : 3),
      findFirst: async () => ({
        authorKind: 'CLIENT',
        visibility: 'CLIENT_VISIBLE',
        createdAt: at(4),
      }),
    },
    clientNotificationIntent: {
      findMany: async ({ where }: { where: Row }) =>
        intents.filter(
          (row) =>
            row.tenantId === where.tenantId && row.supportRequestId === where.supportRequestId,
        ),
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({}),
  }
  const context = {
    database,
    grant: {
      grantId: 'grant_1',
      clientId: 'client_1',
      userId: 'user_owner',
      allTenants: false,
      tenantIds: ['tenant_1'],
      capabilities: ['support:read'],
    },
    now: at(30),
  } as unknown as OperatorCallContext
  const getRequest = supportReadTools.find((tool) => tool.name === 'support.get_request')!
  const list = supportReadTools.find((tool) => tool.name === 'support.list')!
  return {
    get: (args: Row) =>
      getRequest.handler({ tenantId: 'tenant_1', ...args }, context) as Promise<any>,
    list: (args: Row = {}) =>
      list.handler({ tenantId: 'tenant_1', ...args }, context) as Promise<any>,
    database,
  }
}

beforeEach(() => {
  mocks.readFulfillment.mockReset()
  mocks.readFulfillment.mockResolvedValue({
    contractVersion: 6,
    linkedPackageCount: 1,
    digest: DIGEST,
    guestObservability: { effects: [{ kind: 'x' }] },
    contentFulfillment: { receipts: [] },
    temporalFulfillment: { receipts: [] },
    noChangeFulfillment: { receipts: [] },
  })
})

describe('support.get_request linked work', () => {
  it('names every linked item by id, the completion digest, who has access and the priority', async () => {
    const { get } = fixture([request()])

    const detail = await get({ requestId: 'request_1' })

    OPERATOR_MCP_OUTPUTS['support.get_request'].parse(detail)
    expect(detail.priority).toBe('URGENT')
    expect(detail.work).toEqual({
      packageHandoffs: [{ handoffId: 'handoff_1', packageId: 'package_1', requestVersion: 3 }],
      previewFeedback: [{ feedbackId: 'feedback_1', packageId: 'package_1' }],
      knowledgeProposals: [{ proposalId: 'proposal_1', status: 'DRAFT' }],
      agentRuns: [{ runId: 'run_1', status: 'COMPLETED', requestVersion: 4 }],
      onboardingQuestion: {
        linkId: 'link_1',
        questionId: 'question_1',
        answered: false,
        resumedAt: null,
      },
      truncated: false,
    })
    expect(detail.fulfillment).toEqual({
      state: 'ready',
      outcome: 'UPDATED',
      digest: DIGEST,
      linkedPackageCount: 1,
      reason: null,
    })
    expect(detail.access).toEqual({ requesterUserId: 'user_1', participantUserIds: ['user_2'] })
    expect(detail.linked).toEqual({ packageHandoffs: 1, previewFeedback: 1, knowledgeProposals: 1 })
    expect(mocks.readFulfillment).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      supportRequestId: 'request_1',
    })
  })

  it('says why completion evidence is not ready instead of inventing a digest', async () => {
    mocks.readFulfillment.mockRejectedValue(
      new mocks.SupportPackageFulfillmentError(
        'Linked venue package package_1 is not fully applied.',
      ),
    )
    const { get } = fixture([request()])

    const detail = await get({ requestId: 'request_1' })

    OPERATOR_MCP_OUTPUTS['support.get_request'].parse(detail)
    expect(detail.fulfillment).toEqual({
      state: 'not_ready',
      outcome: null,
      digest: null,
      linkedPackageCount: null,
      reason: 'Linked venue package package_1 is not fully applied.',
    })
  })

  it('does not hide an unexpected failure as "not ready"', async () => {
    mocks.readFulfillment.mockRejectedValue(new Error('database down'))
    const { get } = fixture([request()])

    await expect(get({ requestId: 'request_1' })).rejects.toThrow('database down')
  })

  it('reports an unlinked request with empty work and no priority', async () => {
    const { get } = fixture([
      request({
        artifacts: {},
        _count: { packageHandoffs: 0, previewFeedback: 0, knowledgeChangeProposals: 0 },
        packageHandoffs: [],
        previewFeedback: [],
        knowledgeChangeProposals: [],
        agentRunLineages: [],
        onboardingQuestionLink: null,
        participants: [],
        requesterUserId: null,
      }),
    ])

    const detail = await get({ requestId: 'request_1' })

    OPERATOR_MCP_OUTPUTS['support.get_request'].parse(detail)
    expect(detail.priority).toBeNull()
    expect(detail.work).toMatchObject({ packageHandoffs: [], onboardingQuestion: null })
    expect(detail.access).toEqual({ requesterUserId: null, participantUserIds: [] })
  })

  it('returns notification receipts for this request only, without any address', async () => {
    const { get } = fixture(
      [request()],
      [
        {
          id: 'intent_1',
          tenantId: 'tenant_1',
          supportRequestId: 'request_1',
          requestVersion: 7,
          recipientUserId: 'user_1',
          contentHash: 'a'.repeat(64),
          emailStatus: 'UNKNOWN',
          emailLastErrorCode: 'PROVIDER_CALL_INTERRUPTED',
          emailAttemptCount: 1,
          questionIds: [],
          createdAt: at(6),
        },
        { id: 'intent_other', tenantId: 'tenant_2', supportRequestId: 'request_1' },
      ],
    )

    const detail = await get({ requestId: 'request_1' })

    OPERATOR_MCP_OUTPUTS['support.get_request'].parse(detail)
    expect(detail.notifications).toEqual([
      expect.objectContaining({
        intentId: 'intent_1',
        portal: 'portal_posted',
        email: 'email_unknown',
        emailFailureCode: 'PROVIDER_CALL_INTERRUPTED',
      }),
    ])
    expect(JSON.stringify(detail.notifications)).not.toContain('@')
  })

  it("treats another tenant's request as not found", async () => {
    const { get } = fixture([request()])

    await expect(get({ tenantId: 'tenant_2', requestId: 'request_1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(get({ requestId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
