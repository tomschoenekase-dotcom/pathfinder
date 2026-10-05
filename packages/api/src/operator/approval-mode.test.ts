import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getOperatorToolDefinition,
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_OUTPUTS,
  OPERATOR_MCP_TOOLS,
} from '@pathfinder/contracts/operator-mcp'

import {
  isAlwaysAskKind,
  isRoutineAutoKind,
  operatorApprovalMode,
  readAutonomyPolicies,
  resolveAutonomy,
} from './autonomy'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import { createContextReadTool } from './tools/context'

function policyDatabase(mode: 'AUTO' | 'ASK' | null) {
  return {
    operatorAutonomyPolicy: {
      findUnique: vi.fn(async () => (mode ? { mode, allowedKinds: [] } : null)),
      findMany: vi.fn(async () =>
        mode ? [{ capability: 'venues:propose', mode, allowedKinds: [] }] : [],
      ),
    },
    operatorAuditEvent: { groupBy: vi.fn(async () => []) },
  } as never
}

describe('default approval mode: none', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.OPERATOR_APPROVAL_MODE
    delete process.env.OPERATOR_APPROVAL_MODE
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.OPERATOR_APPROVAL_MODE
    else process.env.OPERATOR_APPROVAL_MODE = saved
  })

  it('is the default and only review turns approvals back on', () => {
    expect(operatorApprovalMode({})).toBe('none')
    expect(operatorApprovalMode({ OPERATOR_APPROVAL_MODE: 'anything' })).toBe('none')
    expect(operatorApprovalMode({ OPERATOR_APPROVAL_MODE: ' Review ' })).toBe('review')
  })

  it('applies every implemented kind at once, whatever the stored dashboard rows say', async () => {
    for (const kind of OPERATOR_PROPOSAL_KINDS) {
      expect(isAlwaysAskKind(kind.kind), kind.kind).toBe(false)
      expect(isRoutineAutoKind(kind.kind), kind.kind).toBe(true)
      for (const stored of [null, 'ASK', 'AUTO'] as const) {
        expect(await resolveAutonomy(kind, policyDatabase(stored)), kind.kind).toBe('auto')
      }
    }
    expect(
      await resolveAutonomy(
        { kind: 'operator.revert', capability: 'operator:revert' },
        policyDatabase('ASK'),
      ),
    ).toBe('auto')
  })

  it('covers creating clients and venues, importing, customizing and changing personality', () => {
    for (const kind of [
      'customers.create',
      'customers.invite',
      'venues.create',
      'venues.update',
      'venues.package-import',
      'venues.knowledge',
      'venues.content-changeset',
      'venues.publish',
      'appearance.update',
      'appearance.guest-actions',
    ]) {
      expect(
        OPERATOR_PROPOSAL_KINDS.some((entry) => entry.kind === kind),
        kind,
      ).toBe(true)
    }
    expect(getOperatorToolDefinition('venues.propose_update')?.proposalKind).toBe('venues.update')
    expect(getOperatorToolDefinition('venues.propose_package_import')?.proposalKind).toBe(
      'venues.package-import',
    )
    const update = OPERATOR_MCP_INPUTS['venues.propose_update']
    expect(
      update.safeParse({
        tenantId: 't',
        venueId: 'v',
        operationId: '3f2b8a52-6c1e-4f5e-9d8a-1b2c3d4e5f60',
        tonePreset: 'enthusiastic',
        aiGuideNotes: 'Speak like a warm, curious docent.',
        greeting: 'Welcome in!',
        chatBannerUrl: 'https://images.example.com/hall.jpg',
      }).success,
    ).toBe(true)
  })

  it('tells agents that every action applies and never points them at an approval page', async () => {
    for (const tool of OPERATOR_MCP_TOOLS) {
      expect(tool.description, tool.name).not.toMatch(/always needs a human|approveUrl/iu)
    }
    const database = policyDatabase('ASK')
    const policies = await readAutonomyPolicies(database)
    for (const row of policies) {
      if (row.capability === 'operator:plan') continue
      const implemented = OPERATOR_PROPOSAL_KINDS.filter(
        (kind) => kind.capability === row.capability,
      )
      if (implemented.length > 0) expect(row.mode, row.capability).toBe('auto')
    }
    const tool = createContextReadTool(new Set(OPERATOR_MCP_TOOLS.map((row) => row.name)))
    const rawContext = await tool.handler({}, {
      database,
      grant: {
        grantId: 'grant',
        allTenants: true,
        tenantIds: [],
        capabilities: [...new Set(OPERATOR_MCP_TOOLS.map((row) => row.capability))],
      },
      now: new Date('2026-10-05T00:00:00.000Z'),
    } as never)
    const context = OPERATOR_MCP_OUTPUTS['operator.get_context'].parse(rawContext)
    const asking = context.tools.filter((row) => row.approvalMode === 'ask').map((row) => row.name)
    expect(asking.filter((name) => name !== 'operator.propose_plan')).toEqual([])
  })
})
