import {
  db,
  getCompactAccountContext,
  getCompanyKnowledgeItem,
  searchCompanyKnowledge,
} from '@pathfinder/db'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpAgentActions } from './agent-actions'
import { createPathfinderMcpReadActions } from './read-actions'
import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'

export class McpActionBindingError extends Error {
  readonly code = 'MCP_ACTION_UNAVAILABLE'
}

function unavailable(action: string): never {
  throw new McpActionBindingError(
    `${action} has no approved canonical machine-actor binding and remains disabled`,
  )
}

function jsonData(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Production composition for the safe operational catalog. It reuses canonical reads and durable
 * agent interactions. Approval-bound writes stay disabled until their domain actions can attribute
 * a machine actor without impersonating a human user.
 */
export function createSafeOperationalMcpRegistry(database: typeof db = db) {
  const unavailableActions: Omit<
    PathfinderMcpDomainActions,
    'read' | 'accountContext' | 'knowledgeSearch' | 'knowledgeGet'
  > = {
    verifyApprovalGrant: async () => unavailable('Approval verification'),
    askOperator: async () => unavailable('Operator question'),
    delegateSpecialist: async () => unavailable('Specialist delegation'),
    proposeBillingAction: async () => unavailable('Billing proposal'),
    createPackageDraft: async () => unavailable('Package draft'),
    createUpdateDraft: async () => unavailable('Operational update draft'),
    createSupportDraft: async () => unavailable('Support draft'),
    requestEvaluation: async () => unavailable('Evaluation request'),
  }
  const companyBrainReads: Pick<
    PathfinderMcpDomainActions,
    'accountContext' | 'knowledgeSearch' | 'knowledgeGet'
  > = {
    async accountContext(input, context) {
      const data = await getCompactAccountContext(
        {
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          recentLimit: input.recentLimit,
        },
        database,
      )
      return {
        kind: 'torchiko.account-context',
        summary: `Compact account context for ${data.identity.canonicalName}.`,
        data: jsonData(data),
      }
    },
    async knowledgeSearch(input, context) {
      const data = await searchCompanyKnowledge(
        {
          query: input.query,
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          types: input.types,
          authorities: input.authorities,
          includeHistorical: input.includeHistorical,
          limit: input.limit,
        },
        { kind: 'CLIENT', clientId: context.credential.clientId, roles: [] },
        database,
      )
      return {
        kind: 'torchiko.company-knowledge-search',
        summary: `${data.results.length} authorized knowledge result(s).`,
        data: jsonData(data),
      }
    },
    async knowledgeGet(input, context) {
      const data = await getCompanyKnowledgeItem(
        {
          knowledgeItemId: input.knowledgeItemId,
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
        },
        { kind: 'CLIENT', clientId: context.credential.clientId, roles: [] },
        database,
      )
      return {
        kind: 'torchiko.company-knowledge-item',
        summary: data.item.title,
        data: jsonData(data),
      }
    },
  }
  const reads = createPathfinderMcpReadActions(
    database as unknown as Parameters<typeof createPathfinderMcpReadActions>[0],
    { ...unavailableActions, ...companyBrainReads },
  )
  const actions = createPathfinderMcpAgentActions(database, reads)
  return createPathfinderMcpRegistry(actions, { writeToolsEnabled: false })
}
