import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding } from '@pathfinder/ai'
import {
  assertVenueAiAvailable,
  buildOperationalUpdatePreview,
  consumeApprovalGrantAction,
  createOperationalUpdateAction,
  db,
  getCompactAccountContext,
  getAccountMeeting,
  getAccountTimeline,
  getCompanyKnowledgeItem,
  readUnifiedIntegrationHealth,
  listAccountCorrespondence,
  listAccountMeetings,
  searchCompanyKnowledge,
} from '@pathfinder/db'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpAgentActions } from './agent-actions'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
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
 * agent interactions. Only writes with canonical machine attribution and exact approval
 * consumption are bound; all other write contracts remain unavailable.
 */
export function createSafeOperationalMcpRegistry(database: typeof db = db) {
  const unavailableActions: Omit<
    PathfinderMcpDomainActions,
    | 'read'
    | 'accountContext'
    | 'accountTimeline'
    | 'accountMeetings'
    | 'accountMeetingGet'
    | 'accountCorrespondence'
    | 'knowledgeSearch'
    | 'knowledgeGet'
    | 'integrationHealth'
    | 'verifyApprovalGrant'
    | 'createUpdateDraft'
  > = {
    askOperator: async () => unavailable('Operator question'),
    delegateSpecialist: async () => unavailable('Specialist delegation'),
    proposeBillingAction: async () => unavailable('Billing proposal'),
    createPackageDraft: async () => unavailable('Package draft'),
    createSupportDraft: async () => unavailable('Support draft'),
    requestEvaluation: async () => unavailable('Evaluation request'),
  }
  const approvedWrites: Pick<
    PathfinderMcpDomainActions,
    'verifyApprovalGrant' | 'createUpdateDraft'
  > = {
    async verifyApprovalGrant(request, context) {
      const now = new Date()
      const grant = await database.approvalGrant.findFirst({
        where: {
          id: request.approvalGrantId,
          tenantId: context.credential.tenantId,
          venueId: request.venueId,
          actionName: request.toolName,
          capability: request.capability,
          revokedAt: null,
          notBefore: { lte: now },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      })
      if (!grant) {
        throw new McpActionBindingError('Approval grant is unavailable')
      }
    },
    async createUpdateDraft(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Operational update drafts require venue scope')
      const now = new Date()
      const worker = await database.agentWorker.findFirst({
        where: {
          workerKey: input.workerKey,
          tenantId: context.credential.tenantId,
          clientId: context.credential.clientId,
          credentialId: context.credential.credentialId,
          status: 'ONLINE',
          leaseExpiresAt: { gt: now },
          capabilities: { has: 'updates:draft' },
        },
        select: { id: true, workerKey: true, modelProvider: true, modelName: true },
      })
      if (!worker) throw new McpActionBindingError('Verified worker is unavailable')
      const run = await database.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: context.credential.tenantId,
          venueId,
          agentIdentityId: input.agentIdentityId,
          executionWorkerId: worker.id,
          status: { in: ['RUNNING', 'AWAITING_APPROVAL'] },
          executionLeaseExpiresAt: { gt: now },
        },
        select: { id: true },
      })
      if (!run) throw new McpActionBindingError('Verified worker run is unavailable')
      if (!context.approvalGrantId) throw new McpActionBindingError('Approval grant is required')
      const actor = {
        type: 'AGENT' as const,
        actorId: input.agentIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId,
        workerId: worker.workerKey,
        credentialId: context.credential.credentialId,
        approvalGrantId: context.approvalGrantId,
        capability: 'updates:draft',
        ...(worker.modelProvider && worker.modelName
          ? { modelProvider: worker.modelProvider, modelName: worker.modelName }
          : {}),
        idempotencyKey: input.operationId,
      }
      const parameters = {
        clientId: context.credential.clientId,
        venueId,
        updateType: 'GENERAL_NOTICE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: input.title,
        body: input.body,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
      }
      const result = await database.$transaction(async (tx) => {
        const sameTransaction = {
          $transaction: async (callback: (inner: typeof tx) => unknown) => callback(tx),
        } as never
        const consumption = await consumeApprovalGrantAction(
          {
            tenantId: context.credential.tenantId,
            venueId,
            approvalGrantId: context.approvalGrantId!,
            operationId: input.operationId,
            actionName: 'pathfinder.create_update_draft',
            capability: 'updates:draft',
            parameters,
            actor,
            now,
          },
          sameTransaction,
        )
        if (consumption.replayed && consumption.consumption.resultReference) {
          const updateId = consumption.consumption.resultReference.replace(
            /^OperationalUpdate:/u,
            '',
          )
          const update = await tx.operationalUpdate.findFirst({
            where: {
              id: updateId,
              tenantId: context.credential.tenantId,
              venueId,
            },
          })
          if (!update)
            throw new McpActionBindingError('Approved draft replay target is unavailable')
          return { update, preview: buildOperationalUpdatePreview(update, now), replayed: true }
        }
        const created = await createOperationalUpdateAction(
          {
            tenantId: context.credential.tenantId,
            actor,
            fields: {
              venueId,
              updateType: 'GENERAL_NOTICE',
              severity: 'INFO',
              priority: 'NORMAL',
              title: input.title,
              body: input.body,
              startsAt: new Date(input.startsAt),
              expiresAt: new Date(input.expiresAt),
            },
            schedule: false,
            now,
          },
          sameTransaction,
        )
        await tx.approvalGrantConsumption.update({
          where: { id: consumption.consumption.id },
          data: { resultReference: `OperationalUpdate:${created.update.id}` },
        })
        return { ...created, replayed: false }
      })
      return {
        kind: 'torchiko.operational-update-draft',
        summary: result.replayed ? 'Existing approved draft returned.' : 'Approved draft created.',
        data: jsonData({
          id: result.update.id,
          status: result.update.status,
          preview: result.preview,
          replayed: result.replayed,
        }),
      }
    },
  }
  const companyBrainReads: Pick<
    PathfinderMcpDomainActions,
    | 'accountContext'
    | 'accountTimeline'
    | 'accountMeetings'
    | 'accountMeetingGet'
    | 'accountCorrespondence'
    | 'knowledgeSearch'
    | 'knowledgeGet'
    | 'integrationHealth'
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
    async accountTimeline(input, context) {
      const data = await getAccountTimeline(
        {
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
        },
        database,
      )
      return {
        kind: 'torchiko.account-timeline',
        summary: `${data.items.length} account timeline event(s).`,
        data: jsonData(data),
      }
    },
    async accountMeetings(input, context) {
      const data = await listAccountMeetings(
        {
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
        },
        database,
      )
      return {
        kind: 'torchiko.account-meetings',
        summary: `${data.items.length} account meeting(s).`,
        data: jsonData(data),
      }
    },
    async accountMeetingGet(input, context) {
      const data = await getAccountMeeting(
        {
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          meetingId: input.meetingId,
        },
        database,
      )
      return {
        kind: 'torchiko.account-meeting',
        summary: data.meeting.title,
        data: jsonData(data),
      }
    },
    async accountCorrespondence(input, context) {
      const data = await listAccountCorrespondence(
        {
          clientId: context.credential.clientId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
          ...(input.before ? { before: input.before } : {}),
          limit: input.limit,
        },
        database,
      )
      return {
        kind: 'torchiko.account-correspondence',
        summary: `${data.items.length} correspondence record(s).`,
        data: jsonData(data),
      }
    },
    async knowledgeSearch(input, context) {
      let queryEmbedding: number[] | undefined
      if (input.venueId) {
        const accounting = createApiAiUsageRecorder({
          db: database,
          tenantId: context.credential.tenantId,
          venueId: input.venueId,
          feature: 'company-knowledge-query-embedding',
          surface: 'mcp',
        })
        try {
          const generated = await generateEmbedding({
            modelKey: AI_EMBEDDING_MODEL_KEYS.KNOWLEDGE_CONTENT,
            text: input.query,
            usageSink: accounting.sink,
            budgetGate: accounting.budgetGate,
            admissionGuard: () =>
              assertVenueAiAvailable(database, {
                tenantId: context.credential.tenantId,
                venueId: input.venueId!,
              }),
          })
          queryEmbedding = generated.embedding
        } catch {
          queryEmbedding = undefined
        }
      }
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
        queryEmbedding ? { queryEmbedding } : {},
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
    async integrationHealth(input, context) {
      const data = await readUnifiedIntegrationHealth(
        {
          clientId: context.credential.clientId,
          venueIds: input.venueId ? [input.venueId] : context.credential.venueIds,
        },
        database,
      )
      return {
        kind: 'torchiko.integration-health',
        summary: `${data.integrations.length} integration health record(s).`,
        data: jsonData(data),
      }
    },
  }
  const reads = createPathfinderMcpReadActions(
    database as unknown as Parameters<typeof createPathfinderMcpReadActions>[0],
    { ...unavailableActions, ...companyBrainReads, ...approvedWrites },
  )
  const actions = createPathfinderMcpAgentActions(database, reads)
  return createPathfinderMcpRegistry(actions, { writeToolsEnabled: true })
}
