import type { PrismaClient } from '@prisma/client'

import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import { buildPaymentRecoveryContext } from '@pathfinder/billing'
import type { McpReadInput, McpToolResult } from '@pathfinder/contracts/mcp-v0'
import { buildOnboardingMilestoneRollup } from '@pathfinder/contracts'
import {
  OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS,
  WORKER_HEARTBEAT_KEY,
  assessNativeGuestReadActivationAction,
  measureNativeContentConvergenceAction,
  previewRetentionDispositionAction,
  projectWorkerHeartbeat,
} from '@pathfinder/db'

import type { PathfinderMcpDomainActions, VerifiedMcpInvocationContext } from './registry'
import { loadCustomerStatePreservation } from '../lib/customer-state-preservation'

const CURSOR_VERSION = 1 as const
const MAX_PAGE_SIZE = 100
const FORBIDDEN_EXTERNAL_FIELDS = new Set([
  'sourceUrl',
  'photoUrl',
  'chatLogoUrl',
  'chatBannerUrl',
  'redirectTo',
  'lastErrorCode',
])

type ReadResource = McpReadInput['resource']
type ReadDb = Pick<
  PrismaClient,
  | 'tenant'
  | 'billingAccount'
  | 'venue'
  | 'place'
  | 'venueKnowledgeEntry'
  | 'contentVersion'
  | 'venuePackage'
  | 'supportRequest'
  | 'operationalUpdate'
  | 'aiUsageDailyRollup'
  | 'aiCostBudget'
  | 'jobRecord'
  | 'platformConfig'
  | 'evalRun'
  | 'weeklyReport'
  | 'visitorSession'
  | 'externalAccessCredential'
  | 'agentRun'
  | 'agentAction'
  | 'agentTimelineEvent'
  | 'approvalRequest'
  | 'operationalEvent'
  | 'nativeVenueDeploymentRelease'
  | 'nativeVenueDeploymentHead'
  | 'nativeVenueDeploymentEvaluationEvidence'
  | 'tenantFeatureFlag'
  | 'venueReportConfiguration'
  | 'agentQuestion'
  | 'agentOutcomeObservation'
  | 'agentImprovementProposal'
  | 'onboardingMilestoneEvent'
  | 'offboardingPlan'
>
type McpReadServices = {
  assessNativeGuestReadActivation?: typeof assessNativeGuestReadActivationAction
  measureNativeContentConvergence?: typeof measureNativeContentConvergenceAction
  previewRetentionDisposition?: typeof previewRetentionDispositionAction
}

type CursorPayload = Readonly<{
  v: typeof CURSOR_VERSION
  resource: ReadResource
  sortAt: string
  id: string
}>

export class McpReadBindingError extends Error {
  constructor(
    readonly code: 'INVALID_CURSOR' | 'SCOPE_INVARIANT' | 'RESOURCE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Deterministic, opaque pagination token. It carries no authority: the adapter always reapplies
 * the verified credential's tenant/client/venue scope after decoding it.
 */
export function encodeMcpReadCursor(payload: Omit<CursorPayload, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...payload }), 'utf8').toString(
    'base64url',
  )
}

export function decodeMcpReadCursor(
  encoded: string | undefined,
  expectedResource: ReadResource,
): CursorPayload | undefined {
  if (encoded === undefined) return undefined
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (
      typeof value !== 'object' ||
      value === null ||
      !('v' in value) ||
      value.v !== CURSOR_VERSION ||
      !('resource' in value) ||
      value.resource !== expectedResource ||
      !('sortAt' in value) ||
      typeof value.sortAt !== 'string' ||
      !Number.isFinite(Date.parse(value.sortAt)) ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 120
    ) {
      throw new Error('invalid')
    }
    return value as CursorPayload
  } catch {
    throw new McpReadBindingError('INVALID_CURSOR', 'The pagination cursor is invalid.')
  }
}

/** Concrete read-only bindings for the injected MCP registry seam. No listener or auth is added. */
export function createPathfinderMcpReadActions(
  db: ReadDb,
  unavailableWriteActions: Omit<PathfinderMcpDomainActions, 'read'>,
): PathfinderMcpDomainActions {
  return {
    ...unavailableWriteActions,
    read: (input, context) => readMcpResource(db, input, context),
  }
}

export async function readMcpResource(
  db: ReadDb,
  input: McpReadInput,
  context: VerifiedMcpInvocationContext,
  services: McpReadServices = {},
): Promise<McpToolResult> {
  assertExactScope(input, context)
  const limit = Math.min(input.limit, MAX_PAGE_SIZE)
  const cursor = decodeMcpReadCursor(input.cursor, input.resource)

  switch (input.resource) {
    case 'clients':
      rejectCursor(cursor, input.resource)
      return readClient(db, context.credential.tenantId)
    case 'billing':
      rejectCursor(cursor, input.resource)
      return readBilling(db, context.credential.tenantId, context.credential.venueIds)
    case 'venues':
      return readVenues(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'configuration':
      rejectCursor(cursor, input.resource)
      return readConfiguration(db, context.credential.tenantId, input.venueId!)
    case 'content':
      return readApprovedContent(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'history':
      return readHistory(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'packages':
      return readPackages(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'support':
      return readSupport(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'updates':
      return readUpdates(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'ai-usage':
      return readAiUsage(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'jobs':
      return readJobs(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'evaluations':
      return readEvaluations(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'reports':
      return readReports(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'conversations':
      return readConversations(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'integrations':
      return readIntegrations(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'agent-runs':
      return readAgentRuns(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'agent-run-trace':
      return readAgentRunTrace(
        db,
        context.credential.tenantId,
        input.venueId!,
        input.agentRunId!,
        limit,
        cursor,
      )
    case 'events':
      return readEvents(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'deployments':
      return readDeployments(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'feature-flags':
      return readFeatureFlags(db, context.credential.tenantId, limit, cursor)
    case 'onboarding-summary':
      rejectCursor(cursor, input.resource)
      return readOnboardingSummary(db, context.credential.tenantId, input.venueId!, services)
    case 'readiness':
      rejectCursor(cursor, input.resource)
      return readReadiness(db, context.credential.tenantId, input.venueId!, services)
    case 'retention-preview':
      rejectCursor(cursor, input.resource)
      return readRetentionPreview(db, context.credential.tenantId, services)
    case 'questions':
      return readQuestions(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'outcomes':
      return readOutcomes(db, context.credential.tenantId, input.venueId!, limit, cursor)
    case 'agent-improvements':
      return readAgentImprovements(db, context.credential.tenantId, input.venueId!, limit, cursor)
    default:
      throw new McpReadBindingError(
        'RESOURCE_UNAVAILABLE',
        'The requested resource is unavailable.',
      )
  }
}

function assertExactScope(input: McpReadInput, context: VerifiedMcpInvocationContext): void {
  const { credential } = context
  if (credential.clientId !== credential.tenantId || input.clientId !== credential.tenantId) {
    throw new McpReadBindingError(
      'SCOPE_INVARIANT',
      'Verified tenant and client scope do not match.',
    )
  }
  if (
    !['clients', 'billing', 'feature-flags', 'retention-preview'].includes(input.resource) &&
    !input.venueId
  ) {
    throw new McpReadBindingError('SCOPE_INVARIANT', 'This resource requires exact venue scope.')
  }
  if (input.venueId && !credential.venueIds.includes(input.venueId)) {
    throw new McpReadBindingError('SCOPE_INVARIANT', 'Verified venue scope does not match.')
  }
}

async function readRetentionPreview(
  db: ReadDb,
  tenantId: string,
  services: McpReadServices,
): Promise<McpToolResult> {
  const previewRetentionDisposition =
    services.previewRetentionDisposition ?? previewRetentionDispositionAction
  const preview = await previewRetentionDisposition({ tenantId }, db as never)
  return result('retention-preview', preview)
}

async function readBilling(
  db: ReadDb,
  tenantId: string,
  venueIds: readonly string[],
): Promise<McpToolResult> {
  const [account, customerStatePreservation] = await Promise.all([
    db.billingAccount.findFirst({
      where: { tenantId },
      select: {
        billingMode: true,
        currency: true,
        status: true,
        paidThroughAt: true,
        gracePeriodEndsAt: true,
        reconciliationHealth: true,
        lastReconciledAt: true,
        tenant: {
          select: {
            prospectCustomerRelationships: {
              where: { status: 'ACTIVE' },
              orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
              take: 1,
              select: {
                startedAt: true,
                organization: {
                  select: { id: true, canonicalName: true, relationshipTier: true },
                },
              },
            },
          },
        },
        commercialAgreements: {
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            isBase: true,
            internalPlanKey: true,
            status: true,
            billingMode: true,
            billingInterval: true,
            billingIntervalCount: true,
            agreedAmountMinor: true,
            currency: true,
            coveredVenueCount: true,
            currentPeriodEndsAt: true,
            cancelAtPeriodEnd: true,
            cancellationEffectiveAt: true,
            accessEndsAt: true,
          },
        },
        invoiceProjections: {
          // Use the complete durable invoice set for recovery evidence, then bound
          // the historical invoice payload returned to the agent below.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            amountDueMinor: true,
            amountPaidMinor: true,
            amountRemainingMinor: true,
            currency: true,
            dueAt: true,
            paidAt: true,
            failedAt: true,
            nextRetryAt: true,
            failureSummary: true,
          },
        },
      },
    }),
    loadCustomerStatePreservation(db, tenantId, venueIds),
  ])
  if (!account) return result('billing', null)
  const agreement =
    account.commercialAgreements.find((candidate) => candidate.isBase) ??
    account.commercialAgreements[0] ??
    null
  const relationship = account.tenant.prospectCustomerRelationships[0] ?? null
  const paymentRecovery = buildPaymentRecoveryContext({
    accountStatus: account.status,
    gracePeriodEndsAt: account.gracePeriodEndsAt,
    agreement: agreement
      ? {
          agreedAmountMinor: agreement.agreedAmountMinor,
          currency: agreement.currency,
          billingInterval: agreement.billingInterval,
          billingIntervalCount: agreement.billingIntervalCount,
        }
      : null,
    invoices: account.invoiceProjections,
    relationship: relationship
      ? {
          organizationId: relationship.organization.id,
          organizationName: relationship.organization.canonicalName,
          relationshipTier: relationship.organization.relationshipTier,
          relationshipStartedAt: relationship.startedAt,
        }
      : null,
  })
  return result('billing', {
    billingMode: account.billingMode,
    currency: account.currency,
    status: account.status,
    paidThroughAt: account.paidThroughAt?.toISOString() ?? null,
    gracePeriodEndsAt: account.gracePeriodEndsAt?.toISOString() ?? null,
    reconciliationHealth: account.reconciliationHealth,
    lastReconciledAt: account.lastReconciledAt?.toISOString() ?? null,
    paymentRecovery: {
      ...paymentRecovery,
      generatedAt: paymentRecovery.generatedAt.toISOString(),
      timing: {
        ...paymentRecovery.timing,
        delinquentSince: paymentRecovery.timing.delinquentSince?.toISOString() ?? null,
        nextRetryAt: paymentRecovery.timing.nextRetryAt?.toISOString() ?? null,
        gracePeriodEndsAt: paymentRecovery.timing.gracePeriodEndsAt?.toISOString() ?? null,
      },
      accountValue: paymentRecovery.accountValue
        ? {
            ...paymentRecovery.accountValue,
            amountMinor: paymentRecovery.accountValue.amountMinor?.toString() ?? null,
          }
        : null,
      financialExposure: {
        ...paymentRecovery.financialExposure,
        receivableAtRiskByCurrency:
          paymentRecovery.financialExposure.receivableAtRiskByCurrency.map((entry) => ({
            ...entry,
            amountMinor: entry.amountMinor.toString(),
          })),
        ongoingVariableCost: paymentRecovery.financialExposure.ongoingVariableCost
          ? {
              ...paymentRecovery.financialExposure.ongoingVariableCost,
              amountMinor:
                paymentRecovery.financialExposure.ongoingVariableCost.amountMinor.toString(),
              asOf:
                paymentRecovery.financialExposure.ongoingVariableCost.asOf?.toISOString() ?? null,
            }
          : null,
      },
      relationship: paymentRecovery.relationship
        ? {
            ...paymentRecovery.relationship,
            relationshipStartedAt: paymentRecovery.relationship.relationshipStartedAt.toISOString(),
          }
        : null,
      priorCommunication: paymentRecovery.priorCommunication
        ? {
            ...paymentRecovery.priorCommunication,
            occurredAt: paymentRecovery.priorCommunication.occurredAt.toISOString(),
          }
        : null,
    },
    customerStatePreservation: customerStatePreservation
      ? {
          ...customerStatePreservation,
          generatedAt: customerStatePreservation.generatedAt.toISOString(),
          venues: customerStatePreservation.venues.map((venue) => ({
            ...venue,
            latestOffboardingPlan: venue.latestOffboardingPlan
              ? {
                  ...venue.latestOffboardingPlan,
                  updatedAt: venue.latestOffboardingPlan.updatedAt.toISOString(),
                }
              : null,
          })),
        }
      : null,
    agreements: account.commercialAgreements.map((agreement) => ({
      ...agreement,
      agreedAmountMinor: agreement.agreedAmountMinor?.toString() ?? null,
      currentPeriodEndsAt: agreement.currentPeriodEndsAt?.toISOString() ?? null,
      cancellationEffectiveAt: agreement.cancellationEffectiveAt?.toISOString() ?? null,
      accessEndsAt: agreement.accessEndsAt?.toISOString() ?? null,
    })),
    invoices: account.invoiceProjections.slice(0, 25).map((invoice) => ({
      ...invoice,
      amountDueMinor: invoice.amountDueMinor.toString(),
      amountPaidMinor: invoice.amountPaidMinor.toString(),
      amountRemainingMinor: invoice.amountRemainingMinor.toString(),
      dueAt: invoice.dueAt?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      failedAt: invoice.failedAt?.toISOString() ?? null,
      nextRetryAt: invoice.nextRetryAt?.toISOString() ?? null,
    })),
  })
}

function rejectCursor(cursor: CursorPayload | undefined, resource: ReadResource): void {
  if (cursor) {
    throw new McpReadBindingError('INVALID_CURSOR', `${resource} does not accept a cursor.`)
  }
}

function cursorWhere(
  cursor: CursorPayload | undefined,
  field: 'createdAt' | 'updatedAt' | 'date' | 'startedAt' | 'setAt',
) {
  if (!cursor) return {}
  const sortAt = new Date(cursor.sortAt)
  return { OR: [{ [field]: { lt: sortAt } }, { [field]: sortAt, id: { lt: cursor.id } }] }
}

function page<T extends { id: string }>(
  resource: ReadResource,
  rows: readonly T[],
  limit: number,
  sortAt: (row: T) => Date,
) {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeMcpReadCursor({ resource, sortAt: sortAt(last).toISOString(), id: last.id })
        : null,
  }
}

async function readClient(db: ReadDb, tenantId: string): Promise<McpToolResult> {
  const client = await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      planTier: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result(
    'clients',
    client
      ? {
          ...client,
          createdAt: client.createdAt.toISOString(),
          updatedAt: client.updatedAt.toISOString(),
        }
      : null,
  )
}

async function readVenues(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.venue.findMany({
    where: { tenantId, id: venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      name: true,
      slug: true,
      category: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('venues', mapPage(page('venues', rows, limit, (row) => row.createdAt)))
}

async function readConfiguration(
  db: ReadDb,
  tenantId: string,
  venueId: string,
): Promise<McpToolResult> {
  const venue = await db.venue.findFirst({
    where: { id: venueId, tenantId },
    select: {
      id: true,
      aiTone: true,
      tonePreset: true,
      tonePresetVersion: true,
      aiGuideName: true,
      chatTheme: true,
      chatAccentColor: true,
      chatFont: true,
      guideMode: true,
      defaultCenterLat: true,
      defaultCenterLng: true,
      isActive: true,
      updatedAt: true,
    },
  })
  return result(
    'configuration',
    venue ? normalizeRecord({ ...venue, updatedAt: venue.updatedAt.toISOString() }) : null,
  )
}

async function readApprovedContent(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const where = { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') }
  const [places, knowledge] = await Promise.all([
    db.place.findMany({
      where: { ...where, isActive: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        type: true,
        itemType: true,
        shortDescription: true,
        longDescription: true,
        lat: true,
        lng: true,
        tags: true,
        areaName: true,
        hours: true,
        sourceType: true,
        authorship: true,
        sourceName: true,
        lastReviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.venueKnowledgeEntry.findMany({
      where: { ...where, isEnabled: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        sourceType: true,
        authorship: true,
        sourceName: true,
        lastReviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ])
  const merged = [
    ...places.map((row) => ({ ...row, contentKind: 'place' as const })),
    ...knowledge.map((row) => ({ ...row, contentKind: 'knowledge' as const })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  return result('content', mapPage(page('content', merged, limit, (row) => row.createdAt)))
}

async function readHistory(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.contentVersion.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      entityType: true,
      entityId: true,
      operation: true,
      venuePackageId: true,
      venuePackageAction: true,
      snapshotSchemaVersion: true,
      createdAt: true,
    },
  })
  return result('history', mapPage(page('history', rows, limit, (row) => row.createdAt)))
}

async function readPackages(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.venuePackage.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      schemaVersion: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      approvedAt: true,
      appliedAt: true,
      revertedAt: true,
    },
  })
  return result('packages', mapPage(page('packages', rows, limit, (row) => row.createdAt)))
}

async function readSupport(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.supportRequest.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'updatedAt') },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      category: true,
      status: true,
      subject: true,
      version: true,
      statusChangedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('support', mapPage(page('support', rows, limit, (row) => row.updatedAt)))
}

async function readUpdates(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.operationalUpdate.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      placeId: true,
      updateType: true,
      severity: true,
      priority: true,
      title: true,
      body: true,
      startsAt: true,
      expiresAt: true,
      status: true,
      isActive: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('updates', mapPage(page('updates', rows, limit, (row) => row.createdAt)))
}

async function readAiUsage(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const [rows, budget] = await Promise.all([
    db.aiUsageDailyRollup.findMany({
      where: { tenantId, venueId, ...cursorWhere(cursor, 'date') },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        date: true,
        feature: true,
        requestCount: true,
        successfulRequestCount: true,
        failedRequestCount: true,
        inputTokens: true,
        outputTokens: true,
        cacheCreationInputTokens: true,
        cacheReadInputTokens: true,
        audioInputTokens: true,
        audioOutputTokens: true,
        cachedAudioInputTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
    }),
    db.aiCostBudget.findFirst({
      where: { tenantId, coverageVersion: 'gateway-v1' },
      select: {
        coverageVersion: true,
        enabled: true,
        startsAt: true,
        endsAt: true,
        limitUnits: true,
        remainingUnits: true,
        reservedUnits: true,
        committedUnits: true,
        epoch: true,
        revision: true,
        breachedAt: true,
        updatedAt: true,
      },
    }),
  ])
  const paged = page('ai-usage', rows, limit, (row) => row.date)
  const now = new Date()
  const budgetState = !budget
    ? 'NOT_CONFIGURED'
    : !budget.enabled
      ? 'DISABLED'
      : budget.breachedAt
        ? 'BREACHED'
        : now < budget.startsAt
          ? 'SCHEDULED'
          : now >= budget.endsAt
            ? 'EXPIRED'
            : budget.remainingUnits === 0n
              ? 'EXHAUSTED'
              : 'ACTIVE'
  return result('ai-usage', {
    schemaVersion: 'pathfinder.ai-usage.v2',
    scope: { clientId: tenantId, venueId },
    costProtection: budget
      ? {
          configured: true,
          coverageVersion: budget.coverageVersion,
          state: budgetState,
          enabled: budget.enabled,
          startsAt: budget.startsAt.toISOString(),
          endsAt: budget.endsAt.toISOString(),
          hardLimitUsd: aiCostUnitsToDecimal(budget.limitUnits),
          remainingUsd: aiCostUnitsToDecimal(budget.remainingUnits),
          reservedUsd: aiCostUnitsToDecimal(budget.reservedUnits),
          committedUsd: aiCostUnitsToDecimal(budget.committedUnits),
          epoch: budget.epoch,
          revision: budget.revision,
          breachedAt: budget.breachedAt?.toISOString() ?? null,
          updatedAt: budget.updatedAt.toISOString(),
        }
      : {
          configured: false,
          coverageVersion: 'gateway-v1',
          state: budgetState,
        },
    boundaries: {
      estimatedCostsAreInvoices: false,
      anomalyThresholdPolicy: 'UNRESOLVED',
      automaticBudgetMutationAuthorized: false,
      automaticServiceSuspensionAuthorized: false,
      customerPricingImpact: 'NONE',
      operatorReasonIncluded: false,
      operatorIdentityIncluded: false,
    },
    ...paged,
    items: paged.items.map((row) => ({
      ...row,
      date: row.date.toISOString(),
      estimatedCostUsd: aiCostUnitsToDecimal(aiCostDecimalToUnits(row.estimatedCostUsd)),
    })),
  })
}

async function readJobs(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const now = new Date()
  const exactScope = {
    tenantId,
    venueId,
  } as const
  const [rows, byStatus, byFailureDisposition, longRunningCount, heartbeat] = await Promise.all([
    db.jobRecord.findMany({
      where: { ...exactScope, ...cursorWhere(cursor, 'createdAt') },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        queue: true,
        jobName: true,
        status: true,
        attemptNumber: true,
        maxAttempts: true,
        failureDisposition: true,
        terminalAt: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    }),
    db.jobRecord.groupBy({
      by: ['status'],
      where: exactScope,
      _count: { _all: true },
      _min: { startedAt: true },
      _max: { completedAt: true },
    }),
    db.jobRecord.groupBy({
      by: ['failureDisposition'],
      where: { ...exactScope, status: 'FAILED' },
      _count: { _all: true },
    }),
    db.jobRecord.count({
      where: {
        ...exactScope,
        status: 'RUNNING',
        startedAt: { lt: new Date(now.getTime() - OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS) },
      },
    }),
    db.platformConfig.findUnique({
      where: { key: WORKER_HEARTBEAT_KEY },
      select: { value: true, updatedAt: true },
    }),
  ])
  const paged = mapPage(page('jobs', rows, limit, (row) => row.createdAt))
  return result('jobs', {
    schemaVersion: 'pathfinder.jobs.v2',
    observedAt: now.toISOString(),
    scope: { clientId: tenantId, venueId },
    persisted: {
      source: 'job-records',
      byStatus: byStatus.map((entry) => ({
        status: entry.status,
        count: entry._count._all,
        oldestStartedAt: entry._min.startedAt?.toISOString() ?? null,
        latestCompletedAt: entry._max.completedAt?.toISOString() ?? null,
      })),
      failedByDisposition: byFailureDisposition.map((entry) => ({
        disposition: entry.failureDisposition ?? 'UNCLASSIFIED',
        count: entry._count._all,
      })),
      longRunning: {
        count: longRunningCount,
        observedAfterMs: OPERATIONAL_JOB_LONG_RUNNING_AFTER_MS,
        classification: 'DIAGNOSTIC_ONLY',
      },
    },
    workerRuntime: normalizeRecord(projectWorkerHeartbeat(heartbeat, now)),
    boundaries: {
      persistedRecordsAreLiveQueue: false,
      liveRedisQueueInspected: false,
      liveQueueDepthKnown: false,
      absenceOfRecordsMeansHealthy: false,
      automaticRetryAuthorized: false,
      cancellationAuthorized: false,
      redriveAuthorized: false,
      incidentControlAuthorized: false,
      providerExecutionProven: false,
      serviceLevelObjectivePolicy: 'UNRESOLVED',
    },
    ...paged,
  })
}

async function readEvaluations(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.evalRun.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      promptContractVersion: true,
      modelProvider: true,
      modelName: true,
      declaredBudgetCeilingE8Usd: true,
      triggerType: true,
      status: true,
      attemptNumber: true,
      maxAttempts: true,
      startedAt: true,
      completedAt: true,
      cancellationRequestedAt: true,
      createdAt: true,
    },
  })
  const paged = page('evaluations', rows, limit, (row) => row.createdAt)
  return result('evaluations', {
    ...paged,
    items: paged.items.map((row) =>
      normalizeRecord({
        ...row,
        declaredBudgetCeilingE8Usd: row.declaredBudgetCeilingE8Usd.toString(),
      }),
    ),
  })
}

async function readReports(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.weeklyReport.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      weekStart: true,
      weekEnd: true,
      status: true,
      title: true,
      answerCount: true,
      sessionCount: true,
      generatedAt: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('reports', mapPage(page('reports', rows, limit, (row) => row.createdAt)))
}

async function readConversations(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.visitorSession.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'startedAt') },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      experienceScope: true,
      startedAt: true,
      lastActiveAt: true,
      messageCount: true,
      isNotable: true,
      _count: { select: { conversationInsights: true, messageFeedback: true } },
    },
  })
  return result(
    'conversations',
    mapPage(page('conversations', rows, limit, (row) => row.startedAt)),
  )
}

async function readIntegrations(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.externalAccessCredential.findMany({
    where: { tenantId, clientId: tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      kind: true,
      label: true,
      capabilities: true,
      enabled: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('integrations', mapPage(page('integrations', rows, limit, (row) => row.createdAt)))
}

async function readAgentRuns(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.agentRun.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      parentAgentRunId: true,
      agentIdentityId: true,
      runType: true,
      requestedOperation: true,
      status: true,
      modelProvider: true,
      modelName: true,
      costE8Usd: true,
      costStatus: true,
      errorCode: true,
      attemptNumber: true,
      maxAttempts: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      agentIdentity: { select: { id: true, name: true, agentType: true } },
    },
  })
  return result('agent-runs', mapPage(page('agent-runs', rows, limit, (row) => row.createdAt)))
}

type AgentRunTraceKind = 'ACTION' | 'EVENT' | 'APPROVAL' | 'OUTCOME'

function decodeAgentRunTraceCursor(cursor?: CursorPayload) {
  if (!cursor) return undefined
  const match = /^(ACTION|EVENT|APPROVAL|OUTCOME):(.+)$/u.exec(cursor.id)
  if (!match) {
    throw new McpReadBindingError('INVALID_CURSOR', 'The agent run trace cursor is invalid.')
  }
  return {
    createdAt: new Date(cursor.sortAt),
    kind: match[1] as AgentRunTraceKind,
    id: match[2]!,
  }
}

function agentRunTraceWhere(
  kind: AgentRunTraceKind,
  cursor?: ReturnType<typeof decodeAgentRunTraceCursor>,
) {
  if (!cursor) return {}
  const kindOrder = kind.localeCompare(cursor.kind)
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      ...(kindOrder < 0
        ? [{ createdAt: cursor.createdAt }]
        : kindOrder === 0
          ? [{ createdAt: cursor.createdAt, id: { lt: cursor.id } }]
          : []),
    ],
  }
}

function agentRunTraceState(
  approval: { decision: { decision: string } | null; expiresAt: Date | null },
  now: Date,
) {
  if (approval.decision) return approval.decision.decision
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) return 'EXPIRED'
  return 'PENDING'
}

async function readAgentRunTrace(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  agentRunId: string,
  limit: number,
  opaqueCursor?: CursorPayload,
): Promise<McpToolResult> {
  const cursor = decodeAgentRunTraceCursor(opaqueCursor)
  const where = { tenantId, venueId, agentRunId }
  const take = limit + 1
  const [run, actions, events, approvals, outcomes] = await Promise.all([
    db.agentRun.findFirst({ where: { id: agentRunId, tenantId, venueId }, select: { id: true } }),
    db.agentAction.findMany({
      where: { ...where, ...agentRunTraceWhere('ACTION', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        createdAt: true,
        actorType: true,
        actorId: true,
        requestedOperation: true,
        actionName: true,
        inputSummary: true,
        modelProvider: true,
        modelName: true,
        costE8Usd: true,
        status: true,
        errorCode: true,
        beforeVersionRef: true,
        afterVersionRef: true,
        approvalDecisionId: true,
      },
    }),
    db.agentTimelineEvent.findMany({
      where: { ...where, ...agentRunTraceWhere('EVENT', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        createdAt: true,
        actorType: true,
        actorId: true,
        agentActionId: true,
        eventType: true,
        message: true,
      },
    }),
    db.approvalRequest.findMany({
      where: { ...where, ...agentRunTraceWhere('APPROVAL', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        createdAt: true,
        requestedByType: true,
        requestedById: true,
        proposedAction: true,
        reason: true,
        riskCategory: true,
        expiresAt: true,
        decision: { select: { decision: true, reason: true, createdAt: true } },
      },
    }),
    db.agentOutcomeObservation.findMany({
      where: { ...where, ...agentRunTraceWhere('OUTCOME', cursor) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        createdAt: true,
        actorType: true,
        actorId: true,
        signalKind: true,
        verdict: true,
        summary: true,
        evidenceRef: true,
        taskClass: true,
        modelProvider: true,
        modelName: true,
      },
    }),
  ])
  if (!run) {
    throw new McpReadBindingError('RESOURCE_UNAVAILABLE', 'The requested agent run is unavailable.')
  }

  const now = new Date()
  const items = [
    ...actions.map((item) => ({ ...item, kind: 'ACTION' as const })),
    ...events.map((item) => ({ ...item, kind: 'EVENT' as const })),
    ...approvals.map((item) => ({
      ...item,
      kind: 'APPROVAL' as const,
      state: agentRunTraceState(item, now),
    })),
    ...outcomes.map((item) => ({ ...item, kind: 'OUTCOME' as const })),
  ].sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.kind.localeCompare(left.kind) ||
      right.id.localeCompare(left.id),
  )
  const visible = items.slice(0, limit)
  const last = visible.at(-1)
  return result('agent-run-trace', {
    items: visible.map((item) => ({
      ...normalizeRecord(item),
      ...(item.kind === 'APPROVAL' && item.decision
        ? {
            decision: {
              ...item.decision,
              createdAt: item.decision.createdAt.toISOString(),
            },
          }
        : {}),
    })),
    nextCursor:
      items.length > limit && last
        ? encodeMcpReadCursor({
            resource: 'agent-run-trace',
            sortAt: last.createdAt.toISOString(),
            id: `${last.kind}:${last.id}`,
          })
        : null,
    bounded: true,
    excludes: [
      'RAW_ACTION_OUTPUT',
      'RAW_ACTION_INPUT_REFERENCE',
      'SCOPE_SNAPSHOT',
      'EVENT_DATA',
      'EXECUTION_LEASE',
    ],
  })
}

async function readEvents(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.operationalEvent.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      eventType: true,
      sourceSubsystem: true,
      severity: true,
      title: true,
      summary: true,
      actionRequired: true,
      linkedObjectType: true,
      linkedObjectId: true,
      recommendedAction: true,
      state: true,
      occurrenceCount: true,
      lastOccurredAt: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('events', mapPage(page('events', rows, limit, (row) => row.createdAt)))
}

async function readDeployments(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.nativeVenueDeploymentRelease.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      artifactId: true,
      profile: true,
      expectedEffectCount: true,
      status: true,
      approvedAt: true,
      appliedAt: true,
      revertedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return result('deployments', mapPage(page('deployments', rows, limit, (row) => row.createdAt)))
}

async function readFeatureFlags(
  db: ReadDb,
  tenantId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.tenantFeatureFlag.findMany({
    where: { tenantId, ...cursorWhere(cursor, 'setAt') },
    orderBy: [{ setAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, flagKey: true, enabled: true, setAt: true },
  })
  return result('feature-flags', mapPage(page('feature-flags', rows, limit, (row) => row.setAt)))
}

async function readReadiness(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  services: McpReadServices,
): Promise<McpToolResult> {
  const measureNativeContentConvergence =
    services.measureNativeContentConvergence ?? measureNativeContentConvergenceAction
  const assessNativeGuestReadActivation =
    services.assessNativeGuestReadActivation ?? assessNativeGuestReadActivationAction
  const [venue, activePlaces, enabledKnowledge, reporting, contentConvergence, nativeGuestRead] =
    await Promise.all([
      db.venue.findFirst({
        where: { id: venueId, tenantId },
        select: { id: true, isActive: true, name: true, slug: true, updatedAt: true },
      }),
      db.place.count({ where: { tenantId, venueId, isActive: true } }),
      db.venueKnowledgeEntry.count({ where: { tenantId, venueId, isEnabled: true } }),
      db.venueReportConfiguration.findFirst({
        where: { tenantId, venueId },
        select: { enabled: true, updatedAt: true },
      }),
      measureNativeContentConvergence(db as never, { tenantId, venueId })
        .then((measurement) => ({
          available: true as const,
          contractVersion: measurement.contractVersion,
          phase: measurement.phase,
          guestReadPath: measurement.guestReadPath,
          headValid: measurement.headValid,
          stateMatchesHead: measurement.stateMatchesHead,
          readyForShadowEvaluation: measurement.readyForShadowEvaluation,
          readyForLegacyRetirement: measurement.readyForLegacyRetirement,
          needsOperatorAttention: measurement.needsOperatorAttention,
          blockers: measurement.blockers,
          counts: measurement.counts,
          head: measurement.head
            ? {
                revision: measurement.head.revision,
                updatedAt: measurement.head.updatedAt.toISOString(),
                releaseStatus: measurement.head.releaseStatus,
              }
            : null,
        }))
        .catch(() => ({
          available: false as const,
          phase: 'UNAVAILABLE' as const,
          readyForShadowEvaluation: false as const,
          readyForLegacyRetirement: false as const,
          needsOperatorAttention: true as const,
          blockers: ['MEASUREMENT_UNAVAILABLE'] as const,
        })),
      assessNativeGuestReadActivation({ client: db as never, tenantId, venueId })
        .then((assessment) => ({
          available: true as const,
          contractVersion: assessment.contractVersion,
          runtime: { serverGateEnabled: assessment.runtime.serverGateEnabled },
          policy: {
            present: assessment.policy.present,
            enabled: assessment.policy.enabled,
            valid: assessment.policy.valid,
            mode: assessment.policy.mode,
            qualityPolicyReferencePresent: assessment.policy.qualityPolicyReferencePresent,
            rollbackRehearsalReferencePresent: assessment.policy.rollbackRehearsalReferencePresent,
            productionApprovalReferencePresent:
              assessment.policy.productionApprovalReferencePresent,
          },
          head: {
            present: assessment.head.present,
            valid: assessment.head.valid,
            targetMatches: assessment.head.targetMatches,
          },
          evaluation: { valid: assessment.evaluation.valid },
          path: assessment.path,
          reason: assessment.reason,
          readyForConfiguredMode: assessment.readyForConfiguredMode,
          nativeExecutionReady: assessment.nativeExecutionReady,
          blockers: assessment.blockers,
          compatibilityDataRetentionRequired: assessment.compatibilityDataRetentionRequired,
        }))
        .catch(() => ({
          available: false as const,
          path: 'LEGACY' as const,
          reason: 'ASSESSMENT_UNAVAILABLE' as const,
          readyForConfiguredMode: false as const,
          nativeExecutionReady: false as const,
          blockers: ['ASSESSMENT_UNAVAILABLE'] as const,
          compatibilityDataRetentionRequired: true as const,
        })),
    ])
  const runtimeReadGateOpen = nativeGuestRead.readyForConfiguredMode
  const materializedStateInSync =
    contentConvergence.available && contentConvergence.phase === 'NATIVE_HEAD_IN_SYNC'
  return result(
    'readiness',
    venue
      ? {
          venueId: venue.id,
          venueActive: venue.isActive,
          activePlaceCount: activePlaces,
          enabledKnowledgeCount: enabledKnowledge,
          reportingEnabled: reporting?.enabled ?? false,
          readyForPreview: venue.isActive && activePlaces + enabledKnowledge > 0,
          contentConvergence,
          nativeGuestRead: {
            ...nativeGuestRead,
            alignment: {
              runtimeReadGateOpen,
              materializedStateInSync,
              allObservedTechnicalEvidenceAligned: runtimeReadGateOpen && materializedStateInSync,
            },
            boundaries: {
              readOnly: true as const,
              activationAuthorized: false as const,
              qualityThresholdInferred: false as const,
              policyReferencesExposed: false as const,
              compatibilityDataRetentionRequired: true as const,
            },
          },
          updatedAt: venue.updatedAt.toISOString(),
        }
      : null,
  )
}

const ONBOARDING_SUMMARY_VERSION = 'torchiko-onboarding-summary-v1' as const
const ONBOARDING_SUMMARY_WINDOW_DAYS = 90
const ONBOARDING_SUMMARY_EVENT_LIMIT = 1_000

async function readOnboardingSummary(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  services: McpReadServices,
): Promise<McpToolResult> {
  const to = new Date()
  const from = new Date(to.getTime() - ONBOARDING_SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const [readiness, rows] = await Promise.all([
    readReadiness(db, tenantId, venueId, services),
    db.onboardingMilestoneEvent.findMany({
      where: { tenantId, venueId, occurredAt: { gte: from, lt: to } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: ONBOARDING_SUMMARY_EVENT_LIMIT + 1,
      select: {
        id: true,
        eventType: true,
        occurredAt: true,
        category: true,
        durationMs: true,
      },
    }),
  ])
  if (readiness.data === null) return result('onboarding-summary', null)
  const rollup = buildOnboardingMilestoneRollup({
    events: rows.slice(0, ONBOARDING_SUMMARY_EVENT_LIMIT).map((row) => ({
      ...row,
      eventType: row.eventType as Parameters<
        typeof buildOnboardingMilestoneRollup
      >[0]['events'][number]['eventType'],
    })),
    from,
    to,
    eventLimit: ONBOARDING_SUMMARY_EVENT_LIMIT,
    truncated: rows.length > ONBOARDING_SUMMARY_EVENT_LIMIT,
  })
  return result('onboarding-summary', {
    schemaVersion: ONBOARDING_SUMMARY_VERSION,
    venueId,
    readiness: readiness.data,
    milestoneRollup: {
      ...rollup,
      window: {
        ...rollup.window,
        from: rollup.window.from.toISOString(),
        to: rollup.window.to.toISOString(),
      },
    },
  })
}

async function readQuestions(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.agentQuestion.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      agentIdentityId: true,
      agentRunId: true,
      question: true,
      context: true,
      choices: true,
      blocking: true,
      status: true,
      answer: true,
      answeredAt: true,
      createdAt: true,
      updatedAt: true,
      agentIdentity: { select: { id: true, name: true } },
    },
  })
  return result('questions', mapPage(page('questions', rows, limit, (row) => row.createdAt)))
}

async function readOutcomes(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.agentOutcomeObservation.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      agentRunId: true,
      agentIdentityId: true,
      signalKind: true,
      verdict: true,
      summary: true,
      evidenceRef: true,
      taskClass: true,
      modelProvider: true,
      modelName: true,
      actorType: true,
      createdAt: true,
      agentIdentity: { select: { id: true, name: true } },
    },
  })
  return result('outcomes', mapPage(page('outcomes', rows, limit, (row) => row.createdAt)))
}

async function readAgentImprovements(
  db: ReadDb,
  tenantId: string,
  venueId: string,
  limit: number,
  cursor?: CursorPayload,
): Promise<McpToolResult> {
  const rows = await db.agentImprovementProposal.findMany({
    where: { tenantId, venueId, ...cursorWhere(cursor, 'createdAt') },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      agentIdentityId: true,
      approvalRequestId: true,
      proposalKey: true,
      revision: true,
      supersedesProposalId: true,
      taskClass: true,
      targetKind: true,
      title: true,
      hypothesis: true,
      proposedChange: true,
      validationPlan: true,
      baselineSnapshot: true,
      createdByType: true,
      createdAt: true,
      agentIdentity: { select: { id: true, name: true } },
      approvalRequest: {
        select: {
          riskCategory: true,
          decision: { select: { decision: true, createdAt: true } },
        },
      },
      evidence: {
        orderBy: { outcomeObservationId: 'asc' },
        select: { outcomeObservationId: true },
      },
      validationEvidence: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          baselineEvalRunId: true,
          candidateEvalRunId: true,
          implementationKind: true,
          implementationRef: true,
          implementationVersion: true,
          implementationHash: true,
          changeDimensions: true,
          comparisonSnapshot: true,
          comparisonHash: true,
          recordedByType: true,
          createdAt: true,
        },
      },
    },
  })
  return result(
    'agent-improvements',
    mapPage(page('agent-improvements', rows, limit, (row) => row.createdAt)),
  )
}

function mapPage<T extends Record<string, unknown>>(value: {
  items: readonly T[]
  nextCursor: string | null
}) {
  return {
    ...value,
    items: value.items.map(normalizeRecord),
  }
}

function normalizeRecord(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !FORBIDDEN_EXTERNAL_FIELDS.has(key))
      .map(([key, item]) => [
        key,
        item instanceof Date
          ? item.toISOString()
          : typeof item === 'bigint'
            ? item.toString()
            : item,
      ]),
  )
}

function result(resource: ReadResource, data: unknown): McpToolResult {
  return {
    kind: `pathfinder.${resource}`,
    summary: `Authorized ${resource} read completed.`,
    data: data as McpToolResult['data'],
  }
}
