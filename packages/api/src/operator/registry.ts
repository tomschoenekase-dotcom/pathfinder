import { z } from 'zod'

import type { McpToolResult, VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'
import {
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_TOOLS,
  type OperatorCapability,
  type OperatorToolDefinition,
  type OperatorToolName,
} from '@pathfinder/contracts/operator-mcp'
import { db } from '@pathfinder/db'

import type { OperatorDatabase } from './audit'
import { readAutonomyPolicies } from './autonomy'
import type { OperatorServerConfig } from './config'
import { assertGrantCapability, buildOperatorReadScope, OperatorNotFoundError } from './grants'
import { OPERATOR_PROPOSAL_KINDS } from './kinds'
import type { VerifiedOperatorGrant } from './oauth'
import { createPlan, planView } from './plans'
import {
  createKindRegistry,
  createProposal,
  createRevertProposal,
  proposalView,
  type OperatorKindRegistry,
  type AnyOperatorProposalKind,
} from './proposals'

export type OperatorCallContext = Readonly<{
  config: OperatorServerConfig
  database: OperatorDatabase
  grant: VerifiedOperatorGrant
  kinds: OperatorKindRegistry
  now: Date
  requestId: string
  /** Calls an existing venue read service with a per-call, read-only credential scope. */
  venueRead: VenueReadService
}>

export type VenueReadService = (
  tool: 'torchiko.appearance.get' | 'torchiko.venues.list',
  args: Record<string, unknown>,
  scope: VerifiedMcpCredentialScope,
) => Promise<McpToolResult>

export type OperatorReadTool = Readonly<{
  name: OperatorToolName
  capability: OperatorCapability
  handler: (args: unknown, context: OperatorCallContext) => Promise<unknown>
}>

/** Reads the operator itself owns. P4 adds CRM, venue, support and manual reads beside these. */
const builtInReads: readonly OperatorReadTool[] = [
  {
    name: 'operator.get_proposal',
    capability: 'operator:read',
    async handler(raw, context) {
      const { proposalId } = OPERATOR_MCP_INPUTS['operator.get_proposal'].parse(raw)
      const plan = await context.database.operatorPlan.findUnique({ where: { id: proposalId } })
      if (plan) {
        if (plan.grantId !== context.grant.grantId) throw new OperatorNotFoundError()
        return {
          ...(await planView(plan, context)),
          tool: 'operator.propose_plan',
          kind: 'operator.plan',
          createdAt: plan.createdAt.toISOString(),
          expiresAt: plan.expiresAt.toISOString(),
        }
      }
      const row = await context.database.operatorProposal.findUnique({ where: { id: proposalId } })
      // Only this connection's own proposals are visible; anything else is indistinguishable.
      if (!row || row.grantId !== context.grant.grantId) throw new OperatorNotFoundError()
      return {
        ...proposalView(row, context.config),
        tool: row.tool,
        kind: row.kind,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }
    },
  },
  {
    name: 'operator.list_proposals',
    capability: 'operator:read',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['operator.list_proposals'].parse(raw)
      const rows = await context.database.operatorProposal.findMany({
        where: {
          grantId: context.grant.grantId,
          planId: null,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 26,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      })
      const page = rows.slice(0, 25)
      return {
        items: page.map((row) => ({
          ...proposalView(row, context.config),
          tool: row.tool,
          kind: row.kind,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        })),
        nextCursor: rows.length > 25 ? page.at(-1)!.id : null,
      }
    },
  },
  {
    name: 'operator.get_autonomy',
    capability: 'operator:read',
    async handler(raw, context) {
      OPERATOR_MCP_INPUTS['operator.get_autonomy'].parse(raw)
      return { policies: await readAutonomyPolicies(context.database) }
    },
  },
  {
    name: 'appearance.get',
    capability: 'appearance:read',
    async handler(raw, context) {
      const input = OPERATOR_MCP_INPUTS['appearance.get'].parse(raw)
      const scope = await buildOperatorReadScope(
        context.grant,
        input.tenantId,
        ['appearance:read'],
        context.database,
      )
      if (!scope.venueIds.includes(input.venueId)) throw new OperatorNotFoundError()
      const read = await context.venueRead(
        'torchiko.appearance.get',
        { clientId: input.tenantId, venueId: input.venueId },
        scope,
      )
      const data = read.data as Record<string, unknown>
      const appearance = data.chatAppearance as { title?: unknown } | null
      return {
        venueId: input.venueId,
        updatedAt: data.updatedAt,
        title: typeof appearance?.title === 'string' ? appearance.title : null,
        chatTheme: data.chatTheme,
        chatAccentColor: data.chatAccentColor ?? null,
        chatFont: data.chatFont,
        chatAppearance: appearance ?? null,
      }
    },
  },
]

export type OperatorRegistry = Readonly<{
  kinds: OperatorKindRegistry
  listTools: () => readonly OperatorToolDefinition[]
  callTool: (
    name: string,
    args: unknown,
    context: Omit<OperatorCallContext, 'kinds'>,
  ) => Promise<unknown>
}>

export class OperatorUnknownToolError extends Error {
  readonly code = 'UNKNOWN_TOOL'
}

const PlanInput = OPERATOR_MCP_INPUTS['operator.propose_plan']
const RevertInput = OPERATOR_MCP_INPUTS['operator.propose_revert']

export function createOperatorRegistry(
  options: Readonly<{
    reads?: readonly OperatorReadTool[]
    kinds?: readonly AnyOperatorProposalKind[]
  }> = {},
): OperatorRegistry {
  const reads = new Map(
    [...builtInReads, ...(options.reads ?? [])].map((tool) => [tool.name as string, tool]),
  )
  const kinds = createKindRegistry(options.kinds ?? OPERATOR_PROPOSAL_KINDS)
  const writeNames = new Set<string>([
    ...kinds.keys(),
    'operator.propose_plan',
    'operator.propose_revert',
  ])
  const available = OPERATOR_MCP_TOOLS.filter(
    (tool) => reads.has(tool.name) || writeNames.has(tool.name),
  )
  return {
    kinds,
    listTools: () => available,
    async callTool(name, args, partial) {
      const context: OperatorCallContext = { ...partial, kinds }
      const service = {
        config: context.config,
        database: context.database,
        grant: context.grant,
        kinds,
        now: context.now,
        requestId: context.requestId,
      }
      const read = reads.get(name)
      if (read) {
        assertGrantCapability(context.grant, read.capability)
        return read.handler(args, context)
      }
      if (name === 'operator.propose_plan') {
        return createPlan(PlanInput.parse(args), service)
      }
      if (name === 'operator.propose_revert') {
        return createRevertProposal(args, (raw) => RevertInput.parse(raw), service)
      }
      if (kinds.has(name)) return createProposal(name, args, service)
      throw new OperatorUnknownToolError('Unknown tool')
    },
  }
}

export const OperatorToolCallParams = z
  .object({
    name: z.string().trim().min(1).max(191),
    arguments: z.record(z.unknown()).default({}),
    // Accepted for protocol compatibility and ignored: approval is never a caller claim here.
    _meta: z.record(z.unknown()).optional(),
  })
  .strict()

export function defaultVenueRead(database: OperatorDatabase = db): VenueReadService {
  return async (tool, args, scope) => {
    const { createSafeOperationalMcpRegistry } = await import('../mcp/composition')
    const registry = createSafeOperationalMcpRegistry(
      database as unknown as Parameters<typeof createSafeOperationalMcpRegistry>[0],
    )
    const result = await registry.callTool(tool, args, { credential: scope })
    return result.structuredContent
  }
}
