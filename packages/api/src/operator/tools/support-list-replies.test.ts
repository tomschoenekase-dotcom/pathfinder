/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed in-memory database */
import { describe, expect, it, vi } from 'vitest'

import { OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'

vi.mock('@pathfinder/db', () => ({
  readSupportPackageFulfillment: vi.fn(),
  SupportPackageFulfillmentError: class extends Error {},
}))
vi.mock('@pathfinder/auth', () => ({ resolveVerifiedMemberEmail: vi.fn() }))
vi.mock('@pathfinder/jobs', () => ({ enqueueClientNotificationEmail: vi.fn() }))

import type { OperatorCallContext } from '../registry'
import { supportReadTools } from './support'

type Row = Record<string, any>
const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 12, minute))

function reply(id: string, tenantId: string, minute: number, preview = 'Here is the answer.'): Row {
  return {
    id,
    tenantId,
    supportRequestId: 'request_1',
    intentId: 'intent_1',
    receivedAt: at(minute),
    matchEvidence: ['RFC_REFERENCE'],
    requestEffect: 'MOVED_TO_IN_REVIEW',
    bodyBytes: 20,
    bodyPreview: preview,
    senderHash: 'f'.repeat(64),
    providerMessageId: 'secret-provider-id',
  }
}

function run(rows: Row[], args: Row = {}) {
  const seenWhere: Row[] = []
  const database: Row = {
    tenant: { findUnique: async ({ where }: Row) => ({ id: where.id }) },
    supportRequest: {
      findFirst: async ({ where }: Row) =>
        where.id === 'request_1' && where.tenantId === 'tenant_1' ? { id: 'request_1' } : null,
    },
    clientInboundReply: {
      findMany: async ({ where, take, select }: Row) => {
        seenWhere.push(where)
        return rows
          .filter((row) => row.tenantId === where.tenantId)
          .sort((left, right) => right.receivedAt - left.receivedAt)
          .slice(0, take)
          .map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])))
      },
    },
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
  const tool = supportReadTools.find((candidate) => candidate.name === 'support.list_replies')!
  return {
    seenWhere,
    call: (extra: Row = {}) =>
      tool.handler(
        { tenantId: 'tenant_1', requestId: 'request_1', ...args, ...extra },
        context,
      ) as Promise<any>,
  }
}

describe('support.list_replies', () => {
  it('returns bounded untrusted previews with no sender, provider or message identifiers', async () => {
    const { call } = run([reply('r1', 'tenant_1', 1, 'Mail me at someone@example.test please')])
    const page = await call()

    OPERATOR_MCP_OUTPUTS['support.list_replies'].parse(page)
    expect(page.items[0]).toMatchObject({
      replyId: 'r1',
      notificationId: 'intent_1',
      requestEffect: 'MOVED_TO_IN_REVIEW',
      matchEvidence: ['RFC_REFERENCE'],
      bodyPreview: { untrusted: true },
    })
    const text = JSON.stringify(page)
    expect(text).not.toContain('someone@example.test')
    expect(text).not.toContain('secret-provider-id')
    expect(text).not.toContain('f'.repeat(64))
  })

  it('is tenant scoped: another tenant, an unknown request or an uncovered tenant is not found', async () => {
    const { call, seenWhere } = run([reply('r1', 'tenant_2', 1)])
    expect((await call()).items).toEqual([])
    expect(seenWhere[0]).toMatchObject({ tenantId: 'tenant_1', supportRequestId: 'request_1' })
    await expect(call({ requestId: 'request_9' })).rejects.toThrow()
    await expect(call({ tenantId: 'tenant_2' })).rejects.toThrow()
  })

  it('pages newest first with a cursor', async () => {
    const { call } = run([
      reply('r1', 'tenant_1', 1),
      reply('r2', 'tenant_1', 2),
      reply('r3', 'tenant_1', 3),
    ])
    const first = await call({ limit: 2 })
    expect(first.items.map((item: Row) => item.replyId)).toEqual(['r3', 'r2'])
    expect(first.nextCursor).toBeTruthy()
  })
})
