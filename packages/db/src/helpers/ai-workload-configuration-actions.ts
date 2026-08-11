import {
  AiConfigurationOverrideSchema,
  resolveAiWorkloadConfiguration,
  type AiConfigurationOverride,
  type AiWorkloadId,
} from '@pathfinder/ai'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AiConfigurationHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type AiConfigurationScope =
  | { level: 'WORKLOAD'; workloadId: AiWorkloadId }
  | { level: 'CLIENT'; tenantId: string; workloadId: AiWorkloadId }
  | { level: 'VENUE'; tenantId: string; venueId: string; workloadId: AiWorkloadId }

export type AiConfigurationActionErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'UNSAFE_CHANGE_REQUIRES_APPROVAL'

export class AiConfigurationActionError extends Error {
  constructor(
    readonly code: AiConfigurationActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiConfigurationActionError'
  }
}

export type AiConfigurationValues = AiConfigurationOverride['values']
export type AiConfigurationActionClient = Pick<typeof db, '$transaction'>

type PersistedOverride = {
  id: string
  workloadId: string
  enabled: boolean
  primaryModelKey: string | null
  primaryModelKeySet: boolean
  fallbackEnabled: boolean | null
  fallbackEnabledSet: boolean
  fallbackModelKeys: string[]
  fallbackModelKeysSet: boolean
  timeoutMs: number | null
  timeoutMsSet: boolean
  maxAttempts: number | null
  maxAttemptsSet: boolean
  maxOutputTokens: number | null
  maxOutputTokensSet: boolean
  requestBudgetCeilingE8Usd: string | null
  requestBudgetCeilingE8UsdSet: boolean
  unsafeChangesEnabled: boolean
  isTombstone: boolean
  reason: string
  revision: number
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
}

const select = {
  id: true,
  workloadId: true,
  enabled: true,
  primaryModelKey: true,
  primaryModelKeySet: true,
  fallbackEnabled: true,
  fallbackEnabledSet: true,
  fallbackModelKeys: true,
  fallbackModelKeysSet: true,
  timeoutMs: true,
  timeoutMsSet: true,
  maxAttempts: true,
  maxAttemptsSet: true,
  maxOutputTokens: true,
  maxOutputTokensSet: true,
  requestBudgetCeilingE8Usd: true,
  requestBudgetCeilingE8UsdSet: true,
  unsafeChangesEnabled: true,
  isTombstone: true,
  reason: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

function validateActor(actor: AiConfigurationHumanActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new AiConfigurationActionError(
      'INVALID_INPUT',
      'A human platform administrator is required',
    )
  }
}

function scopeForResolver(scope: AiConfigurationScope): AiConfigurationOverride['scope'] {
  if (scope.level === 'WORKLOAD') return scope
  if (scope.level === 'CLIENT') {
    return { level: 'CLIENT', clientId: scope.tenantId, workloadId: scope.workloadId }
  }
  return {
    level: 'VENUE',
    clientId: scope.tenantId,
    venueId: scope.venueId,
    workloadId: scope.workloadId,
  }
}

export function configurationValuesFromRow(row: PersistedOverride): AiConfigurationValues {
  const values: AiConfigurationValues = {}
  if (row.primaryModelKeySet) values.primaryModelKey = row.primaryModelKey as AiWorkloadId
  if (row.fallbackEnabledSet || row.fallbackModelKeysSet) {
    values.fallback = {
      enabled: row.fallbackEnabled ?? false,
      modelKeys: row.fallbackModelKeys as AiWorkloadId[],
    }
  }
  if (row.timeoutMsSet && row.timeoutMs !== null) values.timeoutMs = row.timeoutMs
  if (row.maxAttemptsSet && row.maxAttempts !== null) values.maxAttempts = row.maxAttempts
  if (row.maxOutputTokensSet) values.maxOutputTokens = row.maxOutputTokens
  if (row.requestBudgetCeilingE8UsdSet) {
    values.requestBudgetCeilingE8Usd = row.requestBudgetCeilingE8Usd
  }
  return values
}

export function configurationOverrideFromRow(
  row: PersistedOverride,
  scope: AiConfigurationScope,
): AiConfigurationOverride | null {
  if (row.isTombstone) return null
  return AiConfigurationOverrideSchema.parse({
    activation: row.enabled ? 'ENABLED' : 'DISABLED',
    scope: scopeForResolver(scope),
    values: configurationValuesFromRow(row),
    unsafeChangesEnabled: row.unsafeChangesEnabled,
    reason: row.reason,
  })
}

function writeData(input: {
  enabled: boolean
  values: AiConfigurationValues
  unsafeChangesEnabled: boolean
  reason: string
  actorId: string
}) {
  const values = input.values
  return {
    enabled: input.enabled,
    primaryModelKey: values.primaryModelKey ?? null,
    primaryModelKeySet: values.primaryModelKey !== undefined,
    fallbackEnabled: values.fallback?.enabled ?? null,
    fallbackEnabledSet: values.fallback !== undefined,
    fallbackModelKeys: values.fallback?.modelKeys ?? [],
    fallbackModelKeysSet: values.fallback !== undefined,
    timeoutMs: values.timeoutMs ?? null,
    timeoutMsSet: values.timeoutMs !== undefined,
    maxAttempts: values.maxAttempts ?? null,
    maxAttemptsSet: values.maxAttempts !== undefined,
    maxOutputTokens: values.maxOutputTokens ?? null,
    maxOutputTokensSet: values.maxOutputTokens !== undefined,
    requestBudgetCeilingE8Usd: values.requestBudgetCeilingE8Usd ?? null,
    requestBudgetCeilingE8UsdSet: values.requestBudgetCeilingE8Usd !== undefined,
    unsafeChangesEnabled: input.unsafeChangesEnabled,
    isTombstone: false,
    reason: input.reason,
    updatedBy: input.actorId,
  }
}

function snapshot(row: PersistedOverride, scope: AiConfigurationScope) {
  return {
    scope,
    workloadId: row.workloadId,
    enabled: row.enabled,
    values: configurationValuesFromRow(row),
    unsafeChangesEnabled: row.unsafeChangesEnabled,
    isTombstone: row.isTombstone,
    reason: row.reason,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function assertProposedConfiguration(input: {
  scope: AiConfigurationScope
  enabled: boolean
  values: AiConfigurationValues
  unsafeChangesEnabled: boolean
  reason: string
  existing: PersistedOverride | null
  lowerOverrides: AiConfigurationOverride[]
}): void {
  const proposed = AiConfigurationOverrideSchema.parse({
    activation: input.enabled ? 'ENABLED' : 'DISABLED',
    scope: scopeForResolver(input.scope),
    values: input.values,
    unsafeChangesEnabled: input.unsafeChangesEnabled,
    reason: input.reason,
  })
  try {
    const current = resolveAiWorkloadConfiguration({
      workloadId: input.scope.workloadId,
      ...(input.scope.level === 'WORKLOAD' ? {} : { clientId: input.scope.tenantId }),
      ...(input.scope.level === 'VENUE' ? { venueId: input.scope.venueId } : {}),
      overrides: [
        ...input.lowerOverrides,
        ...(input.existing
          ? [configurationOverrideFromRow(input.existing, input.scope)].filter(
              (value): value is AiConfigurationOverride => value !== null,
            )
          : []),
      ],
    })
    const next = resolveAiWorkloadConfiguration({
      workloadId: input.scope.workloadId,
      ...(input.scope.level === 'WORKLOAD' ? {} : { clientId: input.scope.tenantId }),
      ...(input.scope.level === 'VENUE' ? { venueId: input.scope.venueId } : {}),
      overrides: [...input.lowerOverrides, proposed],
    })

    const budgetExpands =
      current.requestBudgetCeilingE8Usd !== null &&
      (next.requestBudgetCeilingE8Usd === null ||
        BigInt(next.requestBudgetCeilingE8Usd) > BigInt(current.requestBudgetCeilingE8Usd))
    const outputExpands =
      current.maxOutputTokens !== null &&
      (next.maxOutputTokens === null || next.maxOutputTokens > current.maxOutputTokens)
    const fallbackExpands =
      next.fallback.enabled &&
      (!current.fallback.enabled ||
        next.fallback.modelKeys.join('\u0000') !== current.fallback.modelKeys.join('\u0000'))
    const spendExpands =
      current.primaryModelKey !== next.primaryModelKey ||
      fallbackExpands ||
      next.maxAttempts > current.maxAttempts ||
      outputExpands ||
      budgetExpands
    if (spendExpands && !input.unsafeChangesEnabled) {
      throw new AiConfigurationActionError(
        'UNSAFE_CHANGE_REQUIRES_APPROVAL',
        'Replacement would expand spend or change model selection and requires explicit unsafe-change approval',
      )
    }
  } catch (error) {
    if (error instanceof AiConfigurationActionError) throw error
    const message = error instanceof Error ? error.message : 'Invalid AI configuration'
    if (message.includes('default-off unsafe change')) {
      throw new AiConfigurationActionError('UNSAFE_CHANGE_REQUIRES_APPROVAL', message)
    }
    throw new AiConfigurationActionError('INVALID_INPUT', message)
  }
}

async function assertScope(tx: typeof db, scope: AiConfigurationScope): Promise<void> {
  if (scope.level === 'WORKLOAD') return
  const tenant = await tx.tenant.findFirst({ where: { id: scope.tenantId }, select: { id: true } })
  if (!tenant) throw new AiConfigurationActionError('NOT_FOUND', 'Client not found')
  if (scope.level === 'VENUE') {
    const venue = await tx.venue.findFirst({
      where: { id: scope.venueId, tenantId: scope.tenantId },
      select: { id: true },
    })
    if (!venue) throw new AiConfigurationActionError('NOT_FOUND', 'Venue not found')
  }
}

async function findCurrent(tx: typeof db, scope: AiConfigurationScope) {
  if (scope.level === 'WORKLOAD') {
    return tx.aiWorkloadConfigurationOverride.findFirst({
      where: { workloadId: scope.workloadId },
      select,
    })
  }
  return tx.aiScopedWorkloadConfigurationOverride.findFirst({
    where: {
      tenantId: scope.tenantId,
      venueScopeKey: scope.level === 'CLIENT' ? '__client__' : scope.venueId,
      workloadId: scope.workloadId,
    },
    select,
  })
}

async function readBaselineOverrides(
  tx: typeof db,
  scope: AiConfigurationScope,
): Promise<AiConfigurationOverride[]> {
  const overrides: AiConfigurationOverride[] = []
  if (scope.level !== 'WORKLOAD') {
    const workload = await tx.aiWorkloadConfigurationOverride.findFirst({
      where: { workloadId: scope.workloadId },
      select,
    })
    if (workload) {
      const parsed = configurationOverrideFromRow(workload, {
        level: 'WORKLOAD',
        workloadId: scope.workloadId,
      })
      if (parsed) overrides.push(parsed)
    }
  }
  if (scope.level === 'VENUE') {
    const client = await tx.aiScopedWorkloadConfigurationOverride.findFirst({
      where: {
        tenantId: scope.tenantId,
        venueScopeKey: '__client__',
        workloadId: scope.workloadId,
      },
      select,
    })
    if (client) {
      const parsed = configurationOverrideFromRow(client, {
        level: 'CLIENT',
        tenantId: scope.tenantId,
        workloadId: scope.workloadId,
      })
      if (parsed) overrides.push(parsed)
    }
  }
  return overrides
}

function conflict(): never {
  throw new AiConfigurationActionError(
    'CONFLICT',
    'AI configuration changed after this page loaded; refresh and try again',
  )
}

export async function saveAiWorkloadConfigurationOverrideAction(
  input: {
    scope: AiConfigurationScope
    actor: AiConfigurationHumanActor
    expectedRevision: number | null
    enabled: boolean
    values: AiConfigurationValues
    unsafeChangesEnabled: boolean
    reason: string
  },
  client: AiConfigurationActionClient = db,
) {
  validateActor(input.actor)
  try {
    return await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      await assertScope(tx, input.scope)
      const existing = await findCurrent(tx, input.scope)
      if ((existing?.revision ?? null) !== input.expectedRevision) conflict()
      const lowerOverrides = await readBaselineOverrides(tx, input.scope)
      assertProposedConfiguration({ ...input, existing, lowerOverrides })
      const data = writeData({ ...input, actorId: input.actor.id })
      const nextRevision = (existing?.revision ?? 0) + 1
      let saved: PersistedOverride
      if (input.scope.level === 'WORKLOAD') {
        if (existing) {
          const changed = await tx.aiWorkloadConfigurationOverride.updateMany({
            where: { id: existing.id, revision: existing.revision },
            data: { ...data, revision: { increment: 1 } },
          })
          if (changed.count !== 1) conflict()
          saved = (await findCurrent(tx, input.scope)) as PersistedOverride
        } else {
          saved = await tx.aiWorkloadConfigurationOverride.create({
            data: {
              ...data,
              workloadId: input.scope.workloadId,
              createdBy: input.actor.id,
              revision: nextRevision,
            },
            select,
          })
        }
        await tx.aiWorkloadConfigurationHistory.create({
          data: {
            overrideId: saved.id,
            workloadId: input.scope.workloadId,
            revision: saved.revision,
            action: existing ? 'UPDATED' : 'CREATED',
            snapshot: snapshot(saved, input.scope),
            actorId: input.actor.id,
            actorRole: input.actor.role,
            reason: input.reason,
          },
        })
      } else {
        if (existing) {
          const changed = await tx.aiScopedWorkloadConfigurationOverride.updateMany({
            where: {
              id: existing.id,
              tenantId: input.scope.tenantId,
              revision: existing.revision,
            },
            data: { ...data, revision: { increment: 1 } },
          })
          if (changed.count !== 1) conflict()
          saved = (await findCurrent(tx, input.scope)) as PersistedOverride
        } else {
          saved = await tx.aiScopedWorkloadConfigurationOverride.create({
            data: {
              ...data,
              tenantId: input.scope.tenantId,
              venueId: input.scope.level === 'VENUE' ? input.scope.venueId : null,
              venueScopeKey: input.scope.level === 'VENUE' ? input.scope.venueId : '__client__',
              scopeLevel: input.scope.level,
              workloadId: input.scope.workloadId,
              createdBy: input.actor.id,
              revision: nextRevision,
            },
            select,
          })
        }
        await tx.aiScopedWorkloadConfigurationHistory.create({
          data: {
            overrideId: saved.id,
            tenantId: input.scope.tenantId,
            venueId: input.scope.level === 'VENUE' ? input.scope.venueId : null,
            scopeLevel: input.scope.level,
            workloadId: input.scope.workloadId,
            revision: saved.revision,
            action: existing ? 'UPDATED' : 'CREATED',
            snapshot: snapshot(saved, input.scope),
            actorId: input.actor.id,
            actorRole: input.actor.role,
            reason: input.reason,
          },
        })
      }
      await writeAuditLogStrict(
        {
          tenantId: input.scope.level === 'WORKLOAD' ? null : input.scope.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: existing
            ? 'ai-configuration.override-updated'
            : 'ai-configuration.override-created',
          targetType: 'AiWorkloadConfigurationOverride',
          targetId: saved.id,
          ...(existing ? { beforeState: snapshot(existing, input.scope) } : {}),
          afterState: snapshot(saved, input.scope),
        },
        tx,
      )
      return saved
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      conflict()
    }
    throw error
  }
}

export async function resetAiWorkloadConfigurationOverrideAction(
  input: {
    scope: AiConfigurationScope
    actor: AiConfigurationHumanActor
    expectedRevision: number
    reason: string
  },
  client: AiConfigurationActionClient = db,
) {
  validateActor(input.actor)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await assertScope(tx, input.scope)
    const existing = await findCurrent(tx, input.scope)
    if (!existing) throw new AiConfigurationActionError('NOT_FOUND', 'Override not found')
    if (existing.revision !== input.expectedRevision) conflict()
    const resetData = {
      enabled: false,
      primaryModelKey: null,
      primaryModelKeySet: false,
      fallbackEnabled: null,
      fallbackEnabledSet: false,
      fallbackModelKeys: [],
      fallbackModelKeysSet: false,
      timeoutMs: null,
      timeoutMsSet: false,
      maxAttempts: null,
      maxAttemptsSet: false,
      maxOutputTokens: null,
      maxOutputTokensSet: false,
      requestBudgetCeilingE8Usd: null,
      requestBudgetCeilingE8UsdSet: false,
      unsafeChangesEnabled: false,
      isTombstone: true,
      reason: input.reason,
      updatedBy: input.actor.id,
      revision: { increment: 1 },
    }
    const changed =
      input.scope.level === 'WORKLOAD'
        ? await tx.aiWorkloadConfigurationOverride.updateMany({
            where: { id: existing.id, revision: input.expectedRevision },
            data: resetData,
          })
        : await tx.aiScopedWorkloadConfigurationOverride.updateMany({
            where: {
              id: existing.id,
              tenantId: input.scope.tenantId,
              revision: input.expectedRevision,
            },
            data: resetData,
          })
    if (changed.count !== 1) conflict()
    const saved = (await findCurrent(tx, input.scope)) as PersistedOverride
    if (input.scope.level === 'WORKLOAD') {
      await tx.aiWorkloadConfigurationHistory.create({
        data: {
          overrideId: saved.id,
          workloadId: input.scope.workloadId,
          revision: saved.revision,
          action: 'RESET',
          snapshot: snapshot(saved, input.scope),
          actorId: input.actor.id,
          actorRole: input.actor.role,
          reason: input.reason,
        },
      })
    } else {
      await tx.aiScopedWorkloadConfigurationHistory.create({
        data: {
          overrideId: saved.id,
          tenantId: input.scope.tenantId,
          venueId: input.scope.level === 'VENUE' ? input.scope.venueId : null,
          scopeLevel: input.scope.level,
          workloadId: input.scope.workloadId,
          revision: saved.revision,
          action: 'RESET',
          snapshot: snapshot(saved, input.scope),
          actorId: input.actor.id,
          actorRole: input.actor.role,
          reason: input.reason,
        },
      })
    }
    await writeAuditLogStrict(
      {
        tenantId: input.scope.level === 'WORKLOAD' ? null : input.scope.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'ai-configuration.override-reset',
        targetType: 'AiWorkloadConfigurationOverride',
        targetId: saved.id,
        beforeState: snapshot(existing, input.scope),
        afterState: snapshot(saved, input.scope),
      },
      tx,
    )
    return saved
  })
}
