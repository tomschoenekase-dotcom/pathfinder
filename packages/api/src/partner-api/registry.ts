import { ZodError } from 'zod'

import { isFeatureEnabled } from '@pathfinder/config'
import {
  assertPartnerReadScope,
  GetPartnerClientInput,
  GetPartnerConfigurationInput,
  GetPartnerReadinessInput,
  ListApprovedContentInput,
  ListPartnerUpdatesInput,
  ListPartnerVenuesInput,
  PARTNER_READ_OPERATIONS,
  PartnerReadResult,
  PartnerScopeError,
  PrevalidatedPartnerCredential,
  type GetPartnerClientInput as GetPartnerClientInputType,
  type GetPartnerConfigurationInput as GetPartnerConfigurationInputType,
  type GetPartnerReadinessInput as GetPartnerReadinessInputType,
  type ListApprovedContentInput as ListApprovedContentInputType,
  type ListPartnerUpdatesInput as ListPartnerUpdatesInputType,
  type ListPartnerVenuesInput as ListPartnerVenuesInputType,
  type PartnerReadOperationName,
  type PartnerReadResult as PartnerReadResultType,
  type PrevalidatedPartnerCredential as PrevalidatedPartnerCredentialType,
} from '@pathfinder/contracts/partner-read-api'

export type PartnerReadInvocationContext = Readonly<{
  credential: PrevalidatedPartnerCredentialType
  requestId: string
}>

/** Implementations must delegate to existing authorized domain/read services. */
export type PartnerReadDomainActions = Readonly<{
  getClient: (
    input: GetPartnerClientInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
  listVenues: (
    input: ListPartnerVenuesInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
  listApprovedContent: (
    input: ListApprovedContentInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
  getPartnerSafeConfiguration: (
    input: GetPartnerConfigurationInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
  getReadiness: (
    input: GetPartnerReadinessInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
  listPartnerVisibleUpdates: (
    input: ListPartnerUpdatesInputType,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
}>

export type PartnerReadAuditEvent = Readonly<{
  requestId: string
  credentialId: string
  tenantId: string
  clientId: string
  venueId?: string
  operation: PartnerReadOperationName
  outcome: 'allowed' | 'denied' | 'failed'
  errorCode?: PartnerReadErrorCode
}>

export type PartnerReadSecurityHooks = Readonly<{
  /** Must check current revocation/expiry state for every invocation. */
  checkCredentialActive: (context: PartnerReadInvocationContext) => Promise<{ active: boolean }>
  /** Must enforce the deployment's credential/operation rate-limit policy. */
  checkRateLimit: (
    context: PartnerReadInvocationContext,
    operation: PartnerReadOperationName,
  ) => Promise<{ allowed: boolean }>
  /** Must persist a tenant-bound audit event; registry fails closed if this hook fails. */
  writeAuditEvent: (event: PartnerReadAuditEvent) => Promise<void>
}>

export type PartnerReadErrorCode =
  | 'PARTNER_API_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'CREDENTIAL_INACTIVE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'

const safeMessages: Readonly<Record<PartnerReadErrorCode, string>> = {
  PARTNER_API_UNAVAILABLE: 'Partner API is unavailable.',
  INVALID_REQUEST: 'The request is invalid.',
  FORBIDDEN: 'The requested resource is not available to this credential.',
  CREDENTIAL_INACTIVE: 'The credential is inactive.',
  RATE_LIMITED: 'The request rate limit was exceeded.',
  NOT_FOUND: 'The requested resource was not found.',
  INTERNAL_ERROR: 'The request could not be completed.',
}

export class PartnerReadRegistryError extends Error {
  constructor(readonly code: PartnerReadErrorCode) {
    super(safeMessages[code])
  }
}

/** Domain adapters may use this for a safe not-found outcome; other internal errors are redacted. */
export class PartnerReadNotFoundError extends PartnerReadRegistryError {
  constructor() {
    super('NOT_FOUND')
  }
}

export type PartnerReadRegistry = Readonly<{
  version: 'v1'
  listOperations: () => typeof PARTNER_READ_OPERATIONS
  call: (
    operation: PartnerReadOperationName,
    input: unknown,
    context: PartnerReadInvocationContext,
  ) => Promise<PartnerReadResultType>
}>

const definitions = new Map(
  PARTNER_READ_OPERATIONS.map((definition) => [definition.name, definition]),
)

/** Returns null while the existing partnerReadApi feature flag is off. Creates no network surface. */
export function createPartnerReadRegistry(
  actions: PartnerReadDomainActions,
  hooks: PartnerReadSecurityHooks,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PartnerReadRegistry | null {
  if (!isFeatureEnabled('partnerReadApi', environment)) return null

  return {
    version: 'v1',
    listOperations: () => PARTNER_READ_OPERATIONS,
    async call(operation, rawInput, rawContext) {
      const definition = definitions.get(operation)
      if (!definition) throw new PartnerReadRegistryError('INVALID_REQUEST')

      let context: PartnerReadInvocationContext
      let venueId: string | undefined
      try {
        context = {
          credential: PrevalidatedPartnerCredential.parse(rawContext.credential),
          requestId: parseRequestId(rawContext.requestId),
        }
      } catch {
        throw new PartnerReadRegistryError('INVALID_REQUEST')
      }

      try {
        const credentialState = await hooks.checkCredentialActive(context)
        if (!credentialState.active) throw new PartnerReadRegistryError('CREDENTIAL_INACTIVE')
        const rateLimit = await hooks.checkRateLimit(context, operation)
        if (!rateLimit.allowed) throw new PartnerReadRegistryError('RATE_LIMITED')

        const result = await executeOperation(actions, definition, rawInput, context, (value) => {
          venueId = value
        })
        let parsedResult: PartnerReadResultType
        try {
          parsedResult = PartnerReadResult.parse(result)
        } catch {
          throw new PartnerReadRegistryError('INTERNAL_ERROR')
        }
        await hooks.writeAuditEvent(auditEvent(context, operation, venueId, 'allowed'))
        return parsedResult
      } catch (error) {
        const safeError = toSafeError(error)
        await writeFailureAudit(hooks, context, operation, venueId, safeError)
        throw safeError
      }
    },
  }
}

async function executeOperation(
  actions: PartnerReadDomainActions,
  definition: (typeof PARTNER_READ_OPERATIONS)[number],
  rawInput: unknown,
  context: PartnerReadInvocationContext,
  captureVenueId: (venueId: string | undefined) => void,
): Promise<PartnerReadResultType> {
  switch (definition.name) {
    case 'clients.get': {
      const input = GetPartnerClientInput.parse(rawInput)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.getClient(input, context)
    }
    case 'venues.list': {
      const input = ListPartnerVenuesInput.parse(rawInput)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.listVenues(input, context)
    }
    case 'approved-content.list': {
      const input = ListApprovedContentInput.parse(rawInput)
      captureVenueId(input.venueId)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.listApprovedContent(input, context)
    }
    case 'configuration.get': {
      const input = GetPartnerConfigurationInput.parse(rawInput)
      captureVenueId(input.venueId)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.getPartnerSafeConfiguration(input, context)
    }
    case 'readiness.get': {
      const input = GetPartnerReadinessInput.parse(rawInput)
      captureVenueId(input.venueId)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.getReadiness(input, context)
    }
    case 'updates.list': {
      const input = ListPartnerUpdatesInput.parse(rawInput)
      captureVenueId(input.venueId)
      assertPartnerReadScope(context.credential, input, definition.capability, definition.scope)
      return actions.listPartnerVisibleUpdates(input, context)
    }
  }
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw new PartnerReadRegistryError('INVALID_REQUEST')
  }
  return value
}

function toSafeError(error: unknown): PartnerReadRegistryError {
  if (error instanceof PartnerReadRegistryError) return error
  if (error instanceof PartnerScopeError) return new PartnerReadRegistryError('FORBIDDEN')
  if (error instanceof ZodError) return new PartnerReadRegistryError('INVALID_REQUEST')
  return new PartnerReadRegistryError('INTERNAL_ERROR')
}

function auditEvent(
  context: PartnerReadInvocationContext,
  operation: PartnerReadOperationName,
  venueId: string | undefined,
  outcome: PartnerReadAuditEvent['outcome'],
  errorCode?: PartnerReadErrorCode,
): PartnerReadAuditEvent {
  return {
    requestId: context.requestId,
    credentialId: context.credential.credentialId,
    tenantId: context.credential.tenantId,
    clientId: context.credential.clientId,
    ...(venueId !== undefined ? { venueId } : {}),
    operation,
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

async function writeFailureAudit(
  hooks: PartnerReadSecurityHooks,
  context: PartnerReadInvocationContext,
  operation: PartnerReadOperationName,
  venueId: string | undefined,
  error: PartnerReadRegistryError,
): Promise<void> {
  try {
    await hooks.writeAuditEvent(
      auditEvent(
        context,
        operation,
        venueId,
        ['FORBIDDEN', 'CREDENTIAL_INACTIVE', 'RATE_LIMITED'].includes(error.code)
          ? 'denied'
          : 'failed',
        error.code,
      ),
    )
  } catch {
    throw new PartnerReadRegistryError('INTERNAL_ERROR')
  }
}
