import { AsyncLocalStorage } from 'node:async_hooks'

import { PLATFORM_TABLES, TENANTED_TABLES } from '../tenanted-tables'

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

const bypassTenantIsolationStorage = new AsyncLocalStorage<boolean>()

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
  ].includes(action)
}

function isTenantedModel(model: string | undefined): model is (typeof TENANTED_TABLES)[number] {
  return model !== undefined && TENANTED_TABLES.includes(model as (typeof TENANTED_TABLES)[number])
}

function isBypassEnabled(): boolean {
  return bypassTenantIsolationStorage.getStore() === true
}

export class TenantIsolationError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant isolation violated: query on '${model}' (${operation}) missing tenant_id`)
    this.name = 'TenantIsolationError'
  }
}

export async function withTenantIsolationBypass<T>(fn: () => Promise<T>): Promise<T> {
  return bypassTenantIsolationStorage.run(true, fn)
}

export async function tenantIsolationMiddleware(
  params: TenantIsolationMiddlewareParams,
  next: MiddlewareNext,
) {
  if (!isTenantedModel(params.model)) {
    return next(params)
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
    // Only the create path must carry tenantId — it ensures every new row is
    // tenant-scoped. The where clause uses a unique key (e.g. anonymousToken)
    // that already identifies a tenant-owned row, so adding tenantId there is
    // not required by Prisma's typed API and not necessary for security.
    const hasCreateTenantId = hasTenantIdValue(params.args?.create)

    if (!hasCreateTenantId) {
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

export const tenantIsolationInternals = {
  hasOwnTenantKey,
  hasTenantIdInCreateData,
  hasTenantIdValue,
  isBypassEnabled,
  requiresWhereTenantId,
}
