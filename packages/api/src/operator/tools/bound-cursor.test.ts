import { describe, expect, it } from 'vitest'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import {
  createOperatorRegistry,
  type OperatorCallContext,
  type OperatorReadTool,
} from '../registry'
import {
  issueBoundCursor,
  queryHash,
  readBoundCursor,
  withBoundCursor,
  type CursorQuery,
} from './bound-cursor'
import { OperatorInvalidCursorError, pageResult } from './page'

const base: CursorQuery = {
  tool: 'crm.search_organizations',
  scope: 'platform',
  sort: 'name',
  filters: { query: 'Emberwild Park', city: 'Springfield', region: 'IL', limit: 25 },
}

describe('bound cursors', () => {
  it('round-trips the position for the same query, ignoring limit, case and padding', () => {
    const cursor = issueBoundCursor(base, 'org_42')
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/u)
    const same: CursorQuery = {
      ...base,
      filters: { query: '  emberwild park ', city: 'springfield', region: 'il', limit: 10 },
    }
    expect(readBoundCursor(same, cursor)).toBe('org_42')
  })

  it('refuses a changed filter, sort, scope or tool with an actionable message', () => {
    const cursor = issueBoundCursor(base, 'org_42')
    const variants: CursorQuery[] = [
      { ...base, filters: { ...base.filters, query: 'NEW Zoo' } },
      { ...base, filters: { ...base.filters, city: 'Suamico' } },
      { ...base, sort: 'updated' },
      { ...base, scope: 'tenant:t1' },
      { ...base, tool: 'crm.list_candidates' },
    ]
    for (const variant of variants) {
      expect(() => readBoundCursor(variant, cursor)).toThrow(OperatorInvalidCursorError)
      expect(() => readBoundCursor(variant, cursor)).toThrow(/different query; restart/u)
    }
  })

  it('keeps ids case-sensitive', () => {
    const a = queryHash({ ...base, filters: { organizationId: 'AbC' } })
    const b = queryHash({ ...base, filters: { organizationId: 'abc' } })
    expect(a).not.toBe(b)
  })

  it('refuses a tampered payload and garbage', () => {
    const cursor = issueBoundCursor(base, 'org_42')
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const forged = Buffer.from(JSON.stringify({ ...decoded, p: 'org_99', q: 'deadbeefdeadbeef' }))
    for (const bad of [
      forged.toString('base64url'),
      'not a cursor!!',
      'org_42',
      '',
      Buffer.from('[]').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 'c0', q: decoded.q, p: 'x' })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 'c1', q: decoded.q, p: '' })).toString('base64url'),
    ]) {
      expect(() => readBoundCursor(base, bad)).toThrow(OperatorInvalidCursorError)
    }
  })

  it('wraps outgoing cursors and reports completeness honestly', async () => {
    const seen: unknown[] = []
    const run = async (args: Record<string, unknown>) => {
      seen.push(args.cursor)
      return args.cursor === undefined ? pageResult([1], 'pos-1') : pageResult([2], null)
    }
    const first = (await withBoundCursor(base, {}, run)) as {
      nextCursor: string
      complete: boolean
    }
    expect(first.complete).toBe(false)
    expect(first.nextCursor).not.toBe('pos-1')
    const second = (await withBoundCursor(base, { cursor: first.nextCursor }, run)) as {
      nextCursor: null
      complete: boolean
    }
    expect(seen).toEqual([undefined, 'pos-1'])
    expect(second).toMatchObject({ nextCursor: null, complete: true })
    await expect(
      withBoundCursor(
        { ...base, filters: { query: 'NEW Zoo' } },
        { cursor: first.nextCursor },
        run,
      ),
    ).rejects.toThrow(OperatorInvalidCursorError)
    expect(seen).toHaveLength(2)
  })
})

describe('registry cursor binding', () => {
  function registryFor(name: 'customers.list' | 'crm.list_candidates') {
    const seen: Array<Record<string, unknown>> = []
    const tool: OperatorReadTool = {
      name,
      capability: 'operator:read',
      async handler(raw) {
        const args = raw as Record<string, unknown>
        seen.push(args)
        return pageResult([], args.cursor === undefined ? 'row-7' : null)
      },
    }
    const registry = createOperatorRegistry({ reads: [tool] })
    const context = {
      grant: { capabilities: ['operator:read'] },
    } as unknown as Omit<OperatorCallContext, 'kinds'>
    return { registry, context, seen }
  }

  it('refuses a cursor from a different customers.list query before the handler runs', async () => {
    const { registry, context, seen } = registryFor('customers.list')
    const page = (await registry.callTool('customers.list', { query: 'Acme' }, context)) as {
      nextCursor: string
      complete: boolean
    }
    expect(page.complete).toBe(false)
    await expect(
      registry.callTool('customers.list', { query: 'Other', cursor: page.nextCursor }, context),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    expect(seen).toHaveLength(1)
    const next = await registry.callTool(
      'customers.list',
      { query: ' acme ', cursor: page.nextCursor },
      context,
    )
    expect(next).toMatchObject({ complete: true, nextCursor: null })
    expect(seen[1]?.cursor).toBe('row-7')
  })

  it('binds crm.list_candidates cursors to their city filter', async () => {
    const { registry, context } = registryFor('crm.list_candidates')
    const page = (await registry.callTool(
      'crm.list_candidates',
      { city: 'Waterloo', region: 'IA' },
      context,
    )) as { nextCursor: string }
    await expect(
      registry.callTool(
        'crm.list_candidates',
        { city: 'Suamico', region: 'WI', cursor: page.nextCursor },
        context,
      ),
    ).rejects.toThrow(/different query/u)
  })
})

describe('crm.list_drafts scope', () => {
  it('names the required scope fields instead of an empty custom issue', () => {
    const result = OPERATOR_MCP_INPUTS['crm.list_drafts'].safeParse({})
    expect(result.success).toBe(false)
    if (result.success) return
    const issue = result.error.issues[0]!
    expect(issue.path).toEqual(['campaignId'])
    expect(issue.message).toMatch(/campaignId, organizationId or memberId/u)
    expect(OPERATOR_MCP_INPUTS['crm.list_drafts'].safeParse({ organizationId: 'o1' }).success).toBe(
      true,
    )
  })
})
