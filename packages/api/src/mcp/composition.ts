import { db } from '@pathfinder/db'

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

/**
 * Production composition for the safe operational catalog. It reuses canonical reads and durable
 * agent interactions. Approval-bound writes stay disabled until their domain actions can attribute
 * a machine actor without impersonating a human user.
 */
export function createSafeOperationalMcpRegistry(database: typeof db = db) {
  const unavailableActions: Omit<PathfinderMcpDomainActions, 'read'> = {
    verifyApprovalGrant: async () => unavailable('Approval verification'),
    askOperator: async () => unavailable('Operator question'),
    delegateSpecialist: async () => unavailable('Specialist delegation'),
    proposeBillingAction: async () => unavailable('Billing proposal'),
    createPackageDraft: async () => unavailable('Package draft'),
    createUpdateDraft: async () => unavailable('Operational update draft'),
    createSupportDraft: async () => unavailable('Support draft'),
    requestEvaluation: async () => unavailable('Evaluation request'),
  }
  const reads = createPathfinderMcpReadActions(
    database as unknown as Parameters<typeof createPathfinderMcpReadActions>[0],
    unavailableActions,
  )
  const actions = createPathfinderMcpAgentActions(database, reads)
  return createPathfinderMcpRegistry(actions, { writeToolsEnabled: false })
}
