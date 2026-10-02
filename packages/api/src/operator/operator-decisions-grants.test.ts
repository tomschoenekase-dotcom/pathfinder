import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { OPERATOR_MCP_TOOLS } from '@pathfinder/contracts/operator-mcp'

import { isAlwaysAskKind, OPERATOR_LOCKED_CAPABILITIES } from './autonomy'
import {
  claimJobGrantUse,
  createJobGrant,
  isJobGrantableKind,
  listJobGrantableKinds,
  OPERATOR_JOB_GRANT_LIMITS,
} from './job-grants'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import { createKindRegistry } from './proposals'

const registry = createKindRegistry(OPERATOR_PROPOSAL_KINDS)
const allowedUserIds = new Set(['user_owner'])

/** A database that fails the test if a refusal reaches it: these checks must happen first. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be reached')
    },
  },
) as never

const input = (extra: Record<string, unknown> = {}) => ({
  name: 'Example job',
  clientId: 'opc_1',
  tenantId: 'tenant_a',
  kinds: ['appearance.update'],
  maxExecutions: 2,
  actorUserId: 'user_owner',
  requestId: 'req_1',
  now: new Date('2026-10-02T12:00:00Z'),
  ...extra,
})

describe('the operator connection can never decide, mint or grant', () => {
  const root = __dirname
  const surface = [
    'registry.ts',
    'http.ts',
    'oauth.ts',
    ...readdirSync(path.join(root, 'tools'))
      .filter((file) => file.endsWith('.ts') && !file.includes('.test.'))
      .map((file) => path.join('tools', file)),
  ]

  it.each(surface)('%s does not reference the human-only services', (file) => {
    const source = readFileSync(path.join(root, file), 'utf8')
    for (const name of [
      'decideRequest',
      'createJobGrant',
      'revokeJobGrant',
      'applyPendingWithJobGrant',
      'claimJobGrantUse',
    ]) {
      expect(source, `${file} must not use ${name}`).not.toContain(name)
    }
  })

  it('publishes no tool that decides or grants, and the one chat tool is a control, not a proposal', () => {
    const names = OPERATOR_MCP_TOOLS.map((tool) => tool.name)
    expect(names.filter((name) => /decide|job_grant|grant_job/u.test(name))).toEqual([])
    const request = OPERATOR_MCP_TOOLS.find((tool) => tool.name === 'operator.request_decision')!
    expect(request).toMatchObject({ effect: 'control', capability: 'operator:plan' })
    expect(Object.keys((request.inputSchema as { properties: object }).properties)).toEqual([
      'proposalId',
    ])
  })
})

describe('job grants are default deny', () => {
  it('only kinds that opted in are grantable, and none that mail, invite, bill or speak to a customer', () => {
    const grantable = OPERATOR_PROPOSAL_KINDS.filter(isJobGrantableKind).map((kind) => kind.kind)
    expect(grantable).toEqual(['appearance.update'])
    expect(listJobGrantableKinds(registry).map((kind) => kind.kind)).toEqual(['appearance.update'])
    const externalEffect = OPERATOR_PROPOSAL_KINDS.filter((kind) =>
      /^(customers|crm\.(batch|draft|contact-address|import)|support\.(client|completion|information|create)|reports|routines\.enable|venues\.(source|content))/u.test(
        kind.kind,
      ),
    )
    expect(externalEffect.length).toBeGreaterThan(5)
    for (const kind of externalEffect) expect(isJobGrantableKind(kind)).toBe(false)
  })

  it('an always-ask kind or locked capability is refused even if it sets the opt-in', () => {
    const always = OPERATOR_PROPOSAL_KINDS.find((kind) => isAlwaysAskKind(kind.kind))!
    expect(isJobGrantableKind({ ...always, jobGrant: {} })).toBe(false)
    const locked = OPERATOR_PROPOSAL_KINDS.find((kind) =>
      OPERATOR_LOCKED_CAPABILITIES.has(kind.capability),
    )!
    expect(isJobGrantableKind({ ...locked, jobGrant: {} })).toBe(false)
    // Opting in is necessary: the same kinds without the flag are never grantable.
    for (const kind of OPERATOR_PROPOSAL_KINDS) {
      if (kind.jobGrant === undefined) expect(isJobGrantableKind(kind)).toBe(false)
    }
  })
})

describe('createJobGrant refuses before touching the database', () => {
  const deps = { database: untouchable, kinds: registry, allowedUserIds }

  it('wrong role: an actor outside the allowlist', async () => {
    await expect(
      createJobGrant(input({ actorUserId: 'user_stranger' }), deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_ACTOR' })
  })

  it('kinds that never opted in, are always-ask, or do not exist', async () => {
    for (const kind of [
      'customers.invite',
      'customers.create',
      'crm.stage-change',
      'crm.batch-release',
      'support.client-reply',
      'reports.generate',
      'venues.content-changeset',
      'nope',
    ]) {
      await expect(createJobGrant(input({ kinds: [kind] }), deps)).rejects.toMatchObject({
        code: 'KIND_NOT_GRANTABLE',
      })
    }
  })

  it('bounds: executions, expiry, amount and kind count', async () => {
    const limits = OPERATOR_JOB_GRANT_LIMITS
    for (const bad of [
      { maxExecutions: 0 },
      { maxExecutions: limits.maxExecutions + 1 },
      { maxExecutions: 2.5 },
      { expiresInMinutes: limits.minMinutes - 1 },
      { expiresInMinutes: limits.maxHours * 60 + 1 },
      { maxAmountCents: -1 },
      { maxAmountCents: 10 },
      { name: '' },
      { name: 'x'.repeat(121) },
      { kinds: [] },
    ]) {
      await expect(createJobGrant(input(bad), deps)).rejects.toMatchObject({ code: 'INVALID' })
    }
  })
})

describe('claimJobGrantUse never reaches the database for a kind that did not opt in', () => {
  it.each(['crm.propose_stage_change', 'customers.propose_invite', 'venues.propose_create'])(
    '%s',
    async (tool) => {
      const kind = registry.get(tool)!
      expect(
        await claimJobGrantUse(untouchable, {
          kind,
          args: {},
          clientId: 'opc_1',
          tenantId: 'tenant_a',
          venueId: null,
          now: new Date(),
          allowedUserIds,
        }),
      ).toBeNull()
    },
  )

  it('a proposal with no tenant target can never match a tenant-scoped grant', async () => {
    const kind = registry.get('appearance.propose_update')!
    expect(
      await claimJobGrantUse(untouchable, {
        kind,
        args: {},
        clientId: 'opc_1',
        tenantId: null,
        venueId: null,
        now: new Date(),
        allowedUserIds,
      }),
    ).toBeNull()
  })
})
