import { AsyncLocalStorage } from 'node:async_hooks'

import { logger } from '@pathfinder/config/logger'

import { PLATFORM_TABLES, SHARED_SCOPE_TABLES, TENANTED_TABLES } from '../tenanted-tables'

export type TenantIsolationMiddlewareParams = {
  action: string
  args?: {
    create?: unknown
    data?: unknown
    where?: unknown
  }
  model?: string
}

type MiddlewareNext = (params: TenantIsolationMiddlewareParams) => Promise<unknown>

type TenantIsolationGlobal = typeof globalThis & {
  __pathfinderTenantIsolationBypassStorage?: AsyncLocalStorage<boolean>
}

// Next.js can evaluate this package in more than one server bundle. Keep one
// request-scoped AsyncLocalStorage instance per process so the approved bypass
// wrapper and Prisma middleware cannot diverge across those module copies.
const tenantIsolationGlobal = globalThis as TenantIsolationGlobal
const bypassTenantIsolationStorage =
  tenantIsolationGlobal.__pathfinderTenantIsolationBypassStorage ?? new AsyncLocalStorage<boolean>()
tenantIsolationGlobal.__pathfinderTenantIsolationBypassStorage = bypassTenantIsolationStorage
const APPEND_ONLY_MODELS = [
  'AiUsageEvent',
  'OperatingCostEvidence',
  'GuestAnswerAttribution',
  'ProductEntitlementOverride',
  'BillingEventApplication',
  'BillingAccessOverride',
  'VoiceTranscriptSegment',
  'EvalCase',
  'EvalResult',
  'EvalReview',
  'OnboardingMilestoneEvent',
  'AgentAction',
  'AgentTimelineEvent',
  'AgentMessage',
  'ApprovalRequest',
  'ApprovalDecision',
  'SupportMessage',
  'SupportMessageAttachment',
  'SupportRequestAuditEvent',
  'SupportPackageHandoff',
  'SupportPackageHandoffSupersession',
  'SupportPreviewFeedback',
  'SupportAgentRunLineage',
  'ClientAssistantSupportHandoff',
  'ExternalCredentialRotation',
  'ExternalCredentialOperationReceipt',
  'ExternalCredentialRevocation',
  'ExternalCredentialActivation',
  'OffboardingVenueTarget',
  'OffboardingRevocationEvidence',
  'OffboardingExportArtifact',
  'ContentModuleIdentity',
  'ContentModuleRevision',
  'ItemContent',
  'ServiceContent',
  'PolicyContent',
  'EventContent',
  'OperationalFactContent',
  'RelationshipContent',
  'ContentModuleEvidence',
  'ContentModulePublication',
  'IntakeRun',
  'IntakeEvidenceRecord',
  'IntakeUploadVerificationReceipt',
  'IntakeRunEvent',
  'IntakePackageHandoff',
  'AiScopedWorkloadConfigurationHistory',
  'AiWorkloadConfigurationHistory',
  'ClientCreateIntentEvent',
  'VenuePackageManifestArtifact',
  'NativeVenueDeploymentArtifact',
  'NativeVenueDeploymentEffect',
  'NativeVenueDeploymentCommand',
  'NativeVenueDeploymentPublicationLineage',
  'NativeVenueDeploymentEvaluationEvidence',
  'ProspectStageHistory',
  'ProspectActivity',
  'ProspectSourceEvidence',
  'ProspectContactSuppressionEvent',
  'ProspectEmailEvent',
  'ProspectImportReportEntry',
] as const
const AUDIT_LIFECYCLE_MODELS = [
  'AgentBridgeSession',
  'AgentRun',
  'CustomerAccessRequest',
  'EvalRun',
  'EvalRunCostReservation',
  'SupportRequest',
  'SupportRequestParticipant',
  'OnboardingQuestionLink',
  'OffboardingPlan',
  'OffboardingExportOperation',
  'IntakeUpload',
  'GuestChatTurn',
  'GuestChatProviderOperation',
  'VenueBotConfiguration',
  'PersonalityProfile',
  'CustomCharacter',
  'ClientAssistantPreference',
  'ClientAssistantThread',
  'ClientAssistantTurn',
] as const
const MUTATING_EXISTING_ACTIONS = ['update', 'updateMany', 'upsert', 'delete', 'deleteMany']
const DESTRUCTIVE_ACTIONS = ['delete', 'deleteMany']

function hasOwnTenantKey(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return Object.prototype.hasOwnProperty.call(value, 'tenantId')
}

function hasTenantIdValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>

  if (Object.prototype.hasOwnProperty.call(record, 'tenantId')) {
    return record.tenantId !== undefined && record.tenantId !== null
  }

  if (Object.prototype.hasOwnProperty.call(record, 'tenant_id')) {
    return record.tenant_id !== undefined && record.tenant_id !== null
  }

  return false
}

function hasTenantIdInCreateData(data: unknown): boolean {
  if (Array.isArray(data)) {
    return data.every((item) => hasTenantIdValue(item))
  }

  return hasTenantIdValue(data)
}

function requiresWhereTenantId(action: string): boolean {
  return [
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'findUnique',
    'findUniqueOrThrow',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
    'count',
    'aggregate',
    'groupBy',
  ].includes(action)
}

function isTenantedModel(model: string | undefined): model is (typeof TENANTED_TABLES)[number] {
  return model !== undefined && TENANTED_TABLES.includes(model as (typeof TENANTED_TABLES)[number])
}

function isBypassEnabled(): boolean {
  return bypassTenantIsolationStorage.getStore() === true
}

function resolveBypassCaller(stack = new Error().stack): string {
  // V8 stacks begin with the error header, this helper, and the bypass wrapper.
  // Skip those frames positionally so minification cannot disguise them.
  for (const frame of stack?.split('\n').slice(3) ?? []) {
    const normalized = frame.trim().replaceAll('\\', '/')
    const repositoryPath = normalized.match(/(?:^|[/(@])((?:apps|packages)\/[^():]+:\d+:\d+)/)
    if (repositoryPath?.[1]) return repositoryPath[1]

    const location = normalized.match(/(?:\()?((?:file:\/\/\/)?[^()]+):(\d+):(\d+)\)?$/)
    if (location?.[1]) {
      const filePath = location[1]
      const nextServerIndex = filePath.lastIndexOf('/.next/server/')
      if (nextServerIndex >= 0) {
        const relative = filePath
          .slice(nextServerIndex + 1)
          .replace(/chunks\/[^/]+\.js$/, 'chunks/[chunk].js')
        return `${relative}:${location[2]}:${location[3]}`
      }

      const distIndex = filePath.lastIndexOf('/dist/')
      if (distIndex >= 0) {
        return `${filePath.slice(distIndex + 1)}:${location[2]}:${location[3]}`
      }

      // Never expose an arbitrary absolute deployment or user path.
      continue
    }

    const functionName = normalized.match(/^at\s+(?:async\s+)?([^\s(]+)/)?.[1]
    if (functionName && functionName.length >= 3 && !/[/\\:]/.test(functionName)) {
      return functionName
    }
  }

  return 'unknown'
}

export class TenantIsolationError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant isolation violated: query on '${model}' (${operation}) missing tenant_id`)
    this.name = 'TenantIsolationError'
  }
}

export class AppendOnlyModelError extends Error {
  constructor(model: string, operation: string) {
    super(`Append-only model '${model}' does not allow '${operation}'`)
    this.name = 'AppendOnlyModelError'
  }
}

/**
 * Disables only the Prisma tenant-predicate presence check for the callback.
 * It grants no user role, venue access, capability, or audience authorization.
 * Callers must establish their own authoritative scope and remain limited to
 * reviewed platform-admin or tenant-filtered worker paths.
 */
export async function withTenantIsolationBypass<T>(fn: () => Promise<T>): Promise<T> {
  logger.info({
    action: 'tenant_isolation.bypass',
    caller: resolveBypassCaller(),
  })
  // PrismaPromise is a lazy thenable: returning it directly from run() can
  // defer query execution until after the AsyncLocalStorage scope has exited.
  // Assimilate and await it inside the scoped async callback instead.
  return bypassTenantIsolationStorage.run(true, async () => await fn())
}

export async function tenantIsolationMiddleware(
  params: TenantIsolationMiddlewareParams,
  next: MiddlewareNext,
) {
  if (
    params.model !== undefined &&
    APPEND_ONLY_MODELS.includes(params.model as (typeof APPEND_ONLY_MODELS)[number]) &&
    MUTATING_EXISTING_ACTIONS.includes(params.action)
  ) {
    throw new AppendOnlyModelError(params.model, params.action)
  }

  if (!isTenantedModel(params.model)) {
    return next(params)
  }

  if (
    AUDIT_LIFECYCLE_MODELS.includes(params.model as (typeof AUDIT_LIFECYCLE_MODELS)[number]) &&
    DESTRUCTIVE_ACTIONS.includes(params.action)
  ) {
    throw new AppendOnlyModelError(params.model, params.action)
  }

  if (isBypassEnabled()) {
    return next(params)
  }

  if (params.action === 'create' || params.action === 'createMany') {
    if (!hasTenantIdInCreateData(params.args?.data)) {
      throw new TenantIsolationError(params.model, params.action)
    }

    return next(params)
  }

  if (params.action === 'upsert') {
    const createTenantId = (params.args?.create as Record<string, unknown> | undefined)?.tenantId
    const whereTenantId = (params.args?.where as Record<string, unknown> | undefined)?.tenantId

    if (
      createTenantId === undefined ||
      createTenantId === null ||
      whereTenantId === undefined ||
      whereTenantId === null ||
      createTenantId !== whereTenantId
    ) {
      throw new TenantIsolationError(params.model, params.action)
    }

    return next(params)
  }

  if (requiresWhereTenantId(params.action)) {
    if (!hasTenantIdValue(params.args?.where)) {
      throw new TenantIsolationError(params.model, params.action)
    }

    return next(params)
  }

  return next(params)
}

export const TENANTED_TABLES_LIST = TENANTED_TABLES
export const PLATFORM_TABLES_LIST = PLATFORM_TABLES
export const SHARED_SCOPE_TABLES_LIST = SHARED_SCOPE_TABLES

export const tenantIsolationInternals = {
  hasOwnTenantKey,
  hasTenantIdInCreateData,
  hasTenantIdValue,
  isBypassEnabled,
  resolveBypassCaller,
  requiresWhereTenantId,
}
