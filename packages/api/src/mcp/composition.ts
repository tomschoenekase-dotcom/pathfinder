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
  recordCompanyMeetingExtractionAction,
  completeCompanyMeetingProcessingAction,
  listAccountCorrespondence,
  listAccountMeetings,
  listConversationKnowledgeGaps,
  prepareCustomerAccessRequestAction,
  prepareLocationDraftProposalAction,
  proposeKnowledgeCorrectionAction,
  publishOperationalEvent,
  searchCompanyKnowledge,
} from '@pathfinder/db'
import type { JsonValue, PathfinderMcpToolName } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpAgentActions } from './agent-actions'
import { createApiAiUsageRecorder } from '../lib/api-ai-usage'
import { readWeeklyReportLifecycleForMachine } from '../lib/weekly-report-lifecycle'
import { createPathfinderMcpReadActions, McpReadBindingError } from './read-actions'
import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'

/** Exact tools with a real safe-runtime domain binding. Contract-only tools are deliberately
 * omitted until their canonical action, attribution, approval, and replay behavior are bound. */
export const SAFE_OPERATIONAL_MCP_TOOL_BINDINGS = [
  'pathfinder.read',
  'torchiko.account.get_context',
  'torchiko.account.timeline',
  'torchiko.account.meetings',
  'torchiko.account.meeting_get',
  'torchiko.account.correspondence',
  'torchiko.meeting.process',
  'torchiko.knowledge.search',
  'torchiko.knowledge.get',
  'torchiko.knowledge.list_gaps',
  'torchiko.knowledge.propose_correction',
  'torchiko.locations.propose_draft',
  'torchiko.customer_access.prepare_invitation',
  'torchiko.integrations.health',
  'torchiko.reports.get_lifecycle',
  'pathfinder.ask_operator',
  'pathfinder.delegate_specialist',
  'pathfinder.propose_billing_action',
  'pathfinder.create_update_draft',
] as const satisfies readonly PathfinderMcpToolName[]

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
    | 'processMeeting'
    | 'knowledgeSearch'
    | 'knowledgeGet'
    | 'listKnowledgeGaps'
    | 'proposeKnowledgeCorrection'
    | 'proposeLocationDraft'
    | 'prepareCustomerAccessInvitation'
    | 'integrationHealth'
    | 'reportLifecycle'
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
    | 'verifyApprovalGrant'
    | 'createUpdateDraft'
    | 'processMeeting'
    | 'proposeKnowledgeCorrection'
    | 'proposeLocationDraft'
    | 'prepareCustomerAccessInvitation'
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
    async proposeKnowledgeCorrection(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Knowledge corrections require venue scope')
      const now = new Date()
      const worker = await database.agentWorker.findFirst({
        where: {
          workerKey: input.workerKey,
          tenantId: context.credential.tenantId,
          clientId: context.credential.clientId,
          credentialId: context.credential.credentialId,
          status: 'ONLINE',
          leaseExpiresAt: { gt: now },
          capabilities: { has: 'knowledge:draft' },
        },
        select: { id: true, modelProvider: true, modelName: true },
      })
      if (!worker) throw new McpActionBindingError('Verified knowledge worker is unavailable')
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
      if (!run) throw new McpActionBindingError('Verified knowledge worker run is unavailable')

      const actor = {
        type: 'AGENT' as const,
        actorId: input.agentIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId,
        workerId: worker.id,
        credentialId: context.credential.credentialId,
        capability: 'knowledge:draft',
        ...(worker.modelProvider && worker.modelName
          ? { modelProvider: worker.modelProvider, modelName: worker.modelName }
          : {}),
        idempotencyKey: input.operationId,
      }
      const result = await proposeKnowledgeCorrectionAction(
        {
          operationId: input.operationId,
          tenantId: context.credential.tenantId,
          venueId,
          conversationInsightId: input.conversationInsightId,
          ...(input.targetKnowledgeEntryId
            ? { targetKnowledgeEntryId: input.targetKnowledgeEntryId }
            : {}),
          correctionKind: input.correctionKind,
          aiInference: input.aiInference,
          proposedChange: input.proposedChange,
          reason: input.reason,
          confidence: input.confidence,
          actor,
        },
        database,
      )
      if (!result.replayed) {
        await publishOperationalEvent({
          client: database,
          event: {
            tenantId: context.credential.tenantId,
            venueId,
            eventType: 'knowledge.proposal.created',
            sourceSubsystem: 'conversation-intelligence',
            severity: 'WARNING',
            title: 'Visitor-answer correction needs review',
            summary:
              'An AI worker prepared an evidence-linked correction. Canonical venue knowledge is unchanged.',
            actionRequired: true,
            linkedObjectType: 'knowledge-change-proposal',
            linkedObjectId: result.proposal.id,
            recommendedAction:
              'Compare the source conversation and trusted venue evidence, then approve or reject the proposal.',
            deduplicationKey: `knowledge-proposal:${result.proposal.id}`,
          },
        }).catch(() => undefined)
      }
      return {
        kind: 'torchiko.knowledge-correction-proposal',
        summary: result.replayed
          ? 'Existing visitor-answer correction returned.'
          : 'Visitor-answer correction recorded for human review; canonical knowledge is unchanged.',
        data: jsonData({
          id: result.proposal.id,
          status: result.proposal.status,
          replayed: result.replayed,
          canonicalKnowledgeChanged: false,
        }),
      }
    },
    async proposeLocationDraft(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Location proposals require venue scope')
      const now = new Date()
      const worker = await database.agentWorker.findFirst({
        where: {
          workerKey: input.workerKey,
          tenantId: context.credential.tenantId,
          clientId: context.credential.clientId,
          credentialId: context.credential.credentialId,
          status: 'ONLINE',
          leaseExpiresAt: { gt: now },
          capabilities: { has: 'locations:propose' },
        },
        select: { id: true, modelProvider: true, modelName: true },
      })
      if (!worker) throw new McpActionBindingError('Verified location worker is unavailable')
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
      if (!run) throw new McpActionBindingError('Verified location worker run is unavailable')

      const result = await prepareLocationDraftProposalAction(
        {
          operationId: input.operationId,
          tenantId: context.credential.tenantId,
          venueId,
          reason: input.reason,
          evidence: input.evidence,
          draft: input.draft,
          actor: {
            type: 'AGENT',
            actorId: input.agentIdentityId,
            role: 'AGENT',
            agentIdentityId: input.agentIdentityId,
            agentRunId: input.agentRunId,
            workerId: worker.id,
            credentialId: context.credential.credentialId,
            capability: 'locations:propose',
            ...(worker.modelProvider && worker.modelName
              ? { modelProvider: worker.modelProvider, modelName: worker.modelName }
              : {}),
            idempotencyKey: input.operationId,
          },
        },
        database,
      )
      if (!result.replayed) {
        await publishOperationalEvent({
          client: database,
          event: {
            tenantId: context.credential.tenantId,
            venueId,
            eventType: 'venue-location.proposal-created',
            sourceSubsystem: 'venue-locations',
            severity: 'WARNING',
            title: 'Location draft needs review',
            summary:
              'An AI worker prepared a typed location anchor. Venue content is unchanged until a human approves and separately applies the inactive draft.',
            actionRequired: true,
            linkedObjectType: 'approval-request',
            linkedObjectId: result.approvalRequest.id,
            recommendedAction:
              'Review the proposed anchor and evidence, record a decision, then separately apply the approved inactive draft.',
            deduplicationKey: `location-proposal:${result.approvalRequest.id}`,
          },
        }).catch(() => undefined)
      }
      return {
        kind: 'torchiko.location-draft-proposal',
        summary: result.replayed
          ? 'Existing location draft proposal returned; venue content is unchanged.'
          : 'Location draft prepared for human review; venue content is unchanged.',
        data: jsonData({
          approvalRequestId: result.approvalRequest.id,
          replayed: result.replayed,
          approvalRequired: true,
          applicationRequiredAfterApproval: true,
          canonicalVenueContentChanged: false,
        }),
      }
    },
    async prepareCustomerAccessInvitation(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Customer access requests require venue scope')
      const now = new Date()
      const worker = await database.agentWorker.findFirst({
        where: {
          workerKey: input.workerKey,
          tenantId: context.credential.tenantId,
          clientId: context.credential.clientId,
          credentialId: context.credential.credentialId,
          status: 'ONLINE',
          leaseExpiresAt: { gt: now },
          capabilities: { has: 'customer-access:prepare' },
        },
        select: { id: true, modelProvider: true, modelName: true },
      })
      if (!worker) throw new McpActionBindingError('Verified customer-access worker is unavailable')
      const run = await database.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: context.credential.tenantId,
          venueId,
          agentIdentityId: input.agentIdentityId,
          executionWorkerId: worker.id,
          status: 'RUNNING',
          executionLeaseExpiresAt: { gt: now },
        },
        select: { id: true },
      })
      if (!run) throw new McpActionBindingError('Verified customer-access run is unavailable')

      const actor = {
        type: 'AGENT' as const,
        actorId: input.agentIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId,
        workerId: worker.id,
        credentialId: context.credential.credentialId,
        capability: 'customer-access:prepare',
        ...(worker.modelProvider && worker.modelName
          ? { modelProvider: worker.modelProvider, modelName: worker.modelName }
          : {}),
        idempotencyKey: input.operationId,
      }
      const result = await prepareCustomerAccessRequestAction(
        {
          operationId: input.operationId,
          tenantId: context.credential.tenantId,
          venueId,
          supportRequestId: input.supportRequestId,
          sourceSupportMessageId: input.sourceSupportMessageId,
          emailAddress: input.emailAddress,
          requestedRole: input.requestedRole,
          reason: input.reason,
          actor,
        },
        database,
      )
      if (!result.replayed) {
        await publishOperationalEvent({
          client: database,
          event: {
            tenantId: context.credential.tenantId,
            venueId,
            eventType: 'customer-access.approval-required',
            sourceSubsystem: 'customer-access',
            severity: 'WARNING',
            title: 'Customer team invitation needs approval',
            summary:
              'An AI worker prepared a member invitation from verified owner-authored support evidence. No invitation has been sent.',
            actionRequired: true,
            linkedObjectType: 'customer-access-request',
            linkedObjectId: result.request.id,
            recommendedAction:
              'Review the requested email, source support message, and requested role before authorizing any external invitation.',
            deduplicationKey: `customer-access-request:${result.request.id}`,
          },
        }).catch(() => undefined)
      }
      return {
        kind: 'torchiko.customer-access-request',
        summary: result.replayed
          ? 'Existing customer invitation request returned; no invitation was sent.'
          : 'Customer invitation prepared for founder approval; no invitation was sent.',
        data: jsonData({
          id: result.request.id,
          approvalRequestId: result.request.approvalRequestId,
          status: result.request.status,
          requestedRole: result.request.requestedRole,
          replayed: result.replayed,
          externalEffectsExecuted: false,
          membershipChanged: false,
          invitationSent: false,
        }),
      }
    },
    async processMeeting(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Meeting processing requires venue scope')
      const now = new Date()
      const worker = await database.agentWorker.findFirst({
        where: {
          workerKey: input.workerKey,
          tenantId: context.credential.tenantId,
          clientId: context.credential.clientId,
          credentialId: context.credential.credentialId,
          status: 'ONLINE',
          leaseExpiresAt: { gt: now },
          capabilities: { has: 'meetings:process' },
        },
        select: { id: true, workerKey: true, modelProvider: true, modelName: true },
      })
      if (!worker) throw new McpActionBindingError('Verified meeting worker is unavailable')
      const [run, meeting] = await Promise.all([
        database.agentRun.findFirst({
          where: {
            id: input.agentRunId,
            tenantId: context.credential.tenantId,
            venueId,
            agentIdentityId: input.agentIdentityId,
            executionWorkerId: worker.id,
            status: 'RUNNING',
            executionLeaseExpiresAt: { gt: now },
          },
          select: { id: true },
        }),
        database.companyMeeting.findFirst({
          where: {
            id: input.meetingId,
            tenantId: context.credential.tenantId,
            venueId,
          },
          select: { id: true },
        }),
      ])
      if (!run) throw new McpActionBindingError('Verified meeting worker run is unavailable')
      if (!meeting) throw new McpActionBindingError('Meeting is unavailable in verified scope')
      const actor = {
        type: 'AGENT' as const,
        actorId: input.agentIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId,
        workerId: worker.workerKey,
        credentialId: context.credential.credentialId,
        capability: 'meetings.process',
        ...(worker.modelProvider && worker.modelName
          ? { modelProvider: worker.modelProvider, modelName: worker.modelName }
          : {}),
        idempotencyKey: input.operationId,
      }
      const extractionResults = []
      for (const [index, extraction] of input.extractions.entries()) {
        extractionResults.push(
          await recordCompanyMeetingExtractionAction(
            {
              meetingId: input.meetingId,
              tenantId: context.credential.tenantId,
              type: extraction.type,
              content: extraction.content,
              structuredData: extraction.structuredData,
              ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
              ...(extraction.sourceStartOffset !== undefined
                ? { sourceStartOffset: extraction.sourceStartOffset }
                : {}),
              ...(extraction.sourceEndOffset !== undefined
                ? { sourceEndOffset: extraction.sourceEndOffset }
                : {}),
              idempotencyKey: `${input.operationId}:${index}:${extraction.type}`,
              actor,
            },
            database,
          ),
        )
      }
      const completed = await completeCompanyMeetingProcessingAction(
        {
          meetingId: input.meetingId,
          tenantId: context.credential.tenantId,
          summary: input.summary,
          provenance: {
            source: 'MCP',
            operationId: input.operationId,
            agentRunId: input.agentRunId,
            workerKey: input.workerKey,
          },
          actor,
        },
        database,
      )
      return {
        kind: 'torchiko.meeting-processing',
        summary: completed.replayed
          ? 'Existing completed meeting processing returned.'
          : 'Meeting extraction candidates recorded and processing completed.',
        data: jsonData({
          meetingId: completed.id,
          processingStatus: completed.processingStatus,
          extractionCount: extractionResults.length,
          replayed: completed.replayed && extractionResults.every((item) => item.replayed),
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
    | 'listKnowledgeGaps'
    | 'integrationHealth'
    | 'reportLifecycle'
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
    async listKnowledgeGaps(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpActionBindingError('Knowledge gap review requires venue scope')
      const data = await listConversationKnowledgeGaps(
        {
          tenantId: context.credential.tenantId,
          venueId,
          limit: input.limit,
        },
        database,
      )
      return {
        kind: 'torchiko.visitor-knowledge-gaps',
        summary: `${data.length} reviewable visitor knowledge gap(s).`,
        data: jsonData({ items: data }),
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
    async reportLifecycle(input, context) {
      const venueId = input.venueId
      if (!venueId) throw new McpReadBindingError('SCOPE_INVARIANT', 'Venue scope is required.')
      const lifecycle = await readWeeklyReportLifecycleForMachine(
        {
          tenantId: context.credential.tenantId,
          venueId,
          reportId: input.reportId,
        },
        database,
      )
      if (!lifecycle) {
        throw new McpReadBindingError(
          'RESOURCE_UNAVAILABLE',
          'The requested weekly report is unavailable.',
        )
      }
      const latestJob = lifecycle.jobs[0] ?? null
      return {
        kind: 'torchiko.weekly-report-lifecycle',
        summary: `Weekly report is ${lifecycle.status.toLowerCase()}.`,
        data: jsonData({
          schemaVersion: 'weekly-report-lifecycle.v1',
          scope: { venueId, reportId: lifecycle.scope.reportId },
          version: lifecycle.version,
          status: lifecycle.status,
          legacyStatus: lifecycle.legacyStatus,
          executionEnabled: lifecycle.executionEnabled,
          report: {
            title: lifecycle.report.title,
            weekStart: lifecycle.report.weekStart,
            weekEnd: lifecycle.report.weekEnd,
            createdAt: lifecycle.report.createdAt,
            generatedAt: lifecycle.report.generatedAt,
            sourceEvidence: {
              capturedAnswerCount: lifecycle.report.answerCount,
              publicSessionCount: lifecycle.report.sessionCount,
              lineage: 'PERSISTED_GENERATION_COUNTS',
              exactSourceArtifactsAvailable: false,
            },
            failurePresent: lifecycle.report.error !== null,
          },
          generation: {
            dispatch: lifecycle.dispatch
              ? {
                  state: lifecycle.dispatch.status,
                  attempts: lifecycle.dispatch.attempts,
                  nextAttemptAt: lifecycle.dispatch.nextAttemptAt,
                  consumedAt: lifecycle.dispatch.consumedAt,
                  createdAt: lifecycle.dispatch.createdAt,
                  updatedAt: lifecycle.dispatch.updatedAt,
                  failurePresent: lifecycle.dispatch.lastError !== null,
                }
              : null,
            jobs: {
              count: lifecycle.jobs.length,
              latest: latestJob
                ? {
                    name: latestJob.jobName,
                    status: latestJob.status,
                    attemptNumber: latestJob.attemptNumber,
                    maxAttempts: latestJob.maxAttempts,
                    failureDisposition: latestJob.failureDisposition,
                    startedAt: latestJob.startedAt,
                    completedAt: latestJob.completedAt,
                    terminalAt: latestJob.terminalAt,
                    failurePresent: latestJob.error !== null,
                  }
                : null,
            },
          },
          publication: {
            state: lifecycle.report.publishedAt ? 'PUBLISHED' : 'NOT_PUBLISHED',
            publishedAt: lifecycle.report.publishedAt,
            clientVisible: lifecycle.legacyStatus === 'PUBLISHED',
            externalDelivery: 'NOT_MODELED',
          },
          audit: {
            count: lifecycle.audits.length,
            recent: lifecycle.audits.map((event) => ({
              action: event.action,
              createdAt: event.createdAt,
            })),
          },
          boundaries: {
            reportContentIncluded: false,
            rawSourceArtifactsIncluded: false,
            rawProviderErrorsIncluded: false,
            generationAuthorized: false,
            publicationAuthorized: false,
          },
        }),
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
