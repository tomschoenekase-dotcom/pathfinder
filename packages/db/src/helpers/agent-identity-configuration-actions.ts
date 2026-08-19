import {
  AgentIdentityConfigurationFields,
  agentConfigurationCoherenceIssue,
  type AgentIdentityConfigurationFields as AgentIdentityFields,
} from '@pathfinder/contracts'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type AgentIdentityConfigurationScope =
  | { level: 'CLIENT'; tenantId: string }
  | { level: 'VENUE'; tenantId: string; venueId: string }

export type AgentIdentityConfigurationActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export class AgentIdentityConfigurationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'AgentIdentityConfigurationError'
  }
}

type ActionClient = Pick<typeof db, '$transaction'>

const identitySelect = {
  id: true,
  tenantId: true,
  venueId: true,
  identityKey: true,
  name: true,
  description: true,
  agentType: true,
  accessScope: true,
  accessCapabilities: true,
  autonomyLevel: true,
  autonomousActions: true,
  defaultProvider: true,
  defaultModel: true,
  enabled: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

type IdentitySnapshot = {
  id: string
  tenantId: string
  venueId: string | null
  identityKey: string
  name: string
  description: string | null
  agentType: string
  accessScope: string
  accessCapabilities: string[]
  autonomyLevel: string
  autonomousActions: string[]
  defaultProvider: string | null
  defaultModel: string | null
  enabled: boolean
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

function assertActor(actor: AgentIdentityConfigurationActor) {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id.trim()) {
    throw new AgentIdentityConfigurationError(
      'FORBIDDEN',
      'Agent identity configuration requires a human platform administrator',
    )
  }
}

function exactScope(scope: AgentIdentityConfigurationScope) {
  if (!scope.tenantId.trim()) {
    throw new AgentIdentityConfigurationError('INVALID_INPUT', 'Tenant scope is required')
  }
  if (scope.level === 'VENUE' && !scope.venueId.trim()) {
    throw new AgentIdentityConfigurationError('INVALID_INPUT', 'Venue scope is required')
  }
  return {
    tenantId: scope.tenantId,
    venueId: scope.level === 'VENUE' ? scope.venueId : null,
  }
}

function parseFields(fields: AgentIdentityFields) {
  const parsed = AgentIdentityConfigurationFields.safeParse(fields)
  if (!parsed.success) {
    throw new AgentIdentityConfigurationError(
      'INVALID_INPUT',
      parsed.error.issues[0]?.message ?? 'Invalid agent identity configuration',
    )
  }
  const issue = agentConfigurationCoherenceIssue(parsed.data)
  if (issue) throw new AgentIdentityConfigurationError('INVALID_INPUT', issue)
  return {
    ...parsed.data,
    defaultProvider: parsed.data.defaultProvider ?? null,
    defaultModel: parsed.data.defaultModel ?? null,
  }
}

function snapshot(identity: IdentitySnapshot) {
  return {
    scope: {
      level: identity.accessScope,
      tenantId: identity.tenantId,
      venueId: identity.venueId,
    },
    identityKey: identity.identityKey,
    name: identity.name,
    description: identity.description,
    agentType: identity.agentType,
    accessCapabilities: identity.accessCapabilities,
    autonomyLevel: identity.autonomyLevel,
    autonomousActions: identity.autonomousActions,
    defaultProvider: identity.defaultProvider,
    defaultModel: identity.defaultModel,
    enabled: identity.enabled,
    providerConfigurationEditable: !identity.enabled,
    revision: identity.updatedAt.toISOString(),
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function isForeignKeyConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2003')
}

function conflict(message: string): never {
  throw new AgentIdentityConfigurationError('CONFLICT', message)
}

export async function createDisabledAgentIdentity(
  input: {
    scope: AgentIdentityConfigurationScope
    fields: AgentIdentityFields
    actor: AgentIdentityConfigurationActor
  },
  client: ActionClient = db,
) {
  assertActor(input.actor)
  const scope = exactScope(input.scope)
  const fields = parseFields(input.fields)
  try {
    return await client.$transaction(async (tx) => {
      if (input.scope.level === 'VENUE') {
        const venue = await tx.venue.findFirst({
          where: { id: input.scope.venueId, tenantId: input.scope.tenantId },
          select: { id: true },
        })
        if (!venue) throw new AgentIdentityConfigurationError('NOT_FOUND', 'Venue not found')
      } else {
        const tenant = await tx.tenant.findFirst({
          where: { id: input.scope.tenantId },
          select: { id: true },
        })
        if (!tenant) throw new AgentIdentityConfigurationError('NOT_FOUND', 'Client not found')
      }
      const created = await tx.agentIdentity.create({
        data: {
          ...scope,
          identityKey: fields.identityKey,
          name: fields.name,
          description: fields.description,
          agentType: fields.agentType,
          accessScope: input.scope.level,
          accessCapabilities: fields.accessCapabilities,
          autonomyLevel: fields.autonomyLevel,
          autonomousActions: fields.autonomousActions,
          defaultProvider: fields.defaultProvider,
          defaultModel: fields.defaultModel,
          enabled: false,
          createdBy: input.actor.id,
        },
        select: identitySelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: scope.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.agent-identity.created-disabled',
          targetType: 'AgentIdentity',
          targetId: created.id,
          afterState: snapshot(created),
        },
        tx,
      )
      return created
    })
  } catch (error) {
    if (isUniqueConflict(error)) conflict('Agent identity key already exists for this client')
    if (isForeignKeyConflict(error)) {
      throw new AgentIdentityConfigurationError(
        'NOT_FOUND',
        'Client or venue no longer exists in the requested scope',
      )
    }
    throw error
  }
}

export async function editDisabledAgentIdentity(
  input: {
    scope: AgentIdentityConfigurationScope
    agentIdentityId: string
    expectedUpdatedAt: Date
    fields: AgentIdentityFields
    actor: AgentIdentityConfigurationActor
  },
  client: ActionClient = db,
) {
  assertActor(input.actor)
  const scope = exactScope(input.scope)
  const fields = parseFields(input.fields)
  try {
    return await client.$transaction(async (tx) => {
      const before = await tx.agentIdentity.findFirst({
        where: { id: input.agentIdentityId, ...scope },
        select: identitySelect,
      })
      if (!before)
        throw new AgentIdentityConfigurationError('NOT_FOUND', 'Agent identity not found')
      if (before.enabled) {
        conflict('Enabled agent identities cannot be edited from the staged editor')
      }
      if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        conflict('Agent identity configuration changed; refresh before editing')
      }
      const nextUpdatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
      const updated = await tx.agentIdentity.updateMany({
        where: {
          id: before.id,
          ...scope,
          enabled: false,
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          identityKey: fields.identityKey,
          name: fields.name,
          description: fields.description,
          agentType: fields.agentType,
          accessCapabilities: fields.accessCapabilities,
          autonomyLevel: fields.autonomyLevel,
          autonomousActions: fields.autonomousActions,
          defaultProvider: fields.defaultProvider,
          defaultModel: fields.defaultModel,
          updatedAt: nextUpdatedAt,
        },
      })
      if (updated.count !== 1)
        conflict('Agent identity configuration changed; refresh before editing')
      const saved = await tx.agentIdentity.findFirstOrThrow({
        where: { id: before.id, ...scope, enabled: false },
        select: identitySelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: scope.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.agent-identity.edited-disabled',
          targetType: 'AgentIdentity',
          targetId: saved.id,
          beforeState: snapshot(before),
          afterState: snapshot(saved),
        },
        tx,
      )
      return saved
    })
  } catch (error) {
    if (isUniqueConflict(error)) conflict('Agent identity key already exists for this client')
    throw error
  }
}

export async function disableAgentIdentity(
  input: {
    scope: AgentIdentityConfigurationScope
    agentIdentityId: string
    expectedUpdatedAt: Date
    actor: AgentIdentityConfigurationActor
  },
  client: ActionClient = db,
) {
  assertActor(input.actor)
  const scope = exactScope(input.scope)
  return client.$transaction(async (tx) => {
    const before = await tx.agentIdentity.findFirst({
      where: { id: input.agentIdentityId, ...scope },
      select: identitySelect,
    })
    if (!before) throw new AgentIdentityConfigurationError('NOT_FOUND', 'Agent identity not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      conflict('Agent identity configuration changed; refresh before disabling')
    }
    if (!before.enabled) conflict('Agent identity is already disabled')
    const nextUpdatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
    const updated = await tx.agentIdentity.updateMany({
      where: {
        id: before.id,
        ...scope,
        enabled: true,
        updatedAt: input.expectedUpdatedAt,
      },
      data: { enabled: false, updatedAt: nextUpdatedAt },
    })
    if (updated.count !== 1)
      conflict('Agent identity configuration changed; refresh before disabling')
    const saved = await tx.agentIdentity.findFirstOrThrow({
      where: { id: before.id, ...scope, enabled: false },
      select: identitySelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.agent-identity.disabled',
        targetType: 'AgentIdentity',
        targetId: saved.id,
        beforeState: snapshot(before),
        afterState: snapshot(saved),
      },
      tx,
    )
    return saved
  })
}

export async function enableAgentIdentity(
  input: {
    scope: AgentIdentityConfigurationScope
    agentIdentityId: string
    expectedUpdatedAt: Date
    actor: AgentIdentityConfigurationActor
  },
  client: ActionClient = db,
) {
  assertActor(input.actor)
  const scope = exactScope(input.scope)
  return client.$transaction(async (tx) => {
    const before = await tx.agentIdentity.findFirst({
      where: { id: input.agentIdentityId, ...scope },
      select: identitySelect,
    })
    if (!before) throw new AgentIdentityConfigurationError('NOT_FOUND', 'Agent identity not found')
    if (before.enabled) conflict('Agent identity is already enabled')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      conflict('Agent identity configuration changed; refresh before enabling')
    }
    if (!before.defaultProvider || !before.defaultModel) {
      throw new AgentIdentityConfigurationError(
        'INVALID_INPUT',
        'Configure an execution provider and model before enabling this identity',
      )
    }
    const nextUpdatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
    const updated = await tx.agentIdentity.updateMany({
      where: { id: before.id, ...scope, enabled: false, updatedAt: input.expectedUpdatedAt },
      data: { enabled: true, updatedAt: nextUpdatedAt },
    })
    if (updated.count !== 1) {
      conflict('Agent identity configuration changed; refresh before enabling')
    }
    const saved = await tx.agentIdentity.findFirstOrThrow({
      where: { id: before.id, ...scope, enabled: true },
      select: identitySelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: scope.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.agent-identity.enabled',
        targetType: 'AgentIdentity',
        targetId: saved.id,
        beforeState: snapshot(before),
        afterState: snapshot(saved),
      },
      tx,
    )
    return saved
  })
}
