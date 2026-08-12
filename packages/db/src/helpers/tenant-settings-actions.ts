import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type TenantSettingsHumanActor = {
  type: 'HUMAN'
  id: string
  role: 'OWNER' | 'MANAGER'
}

export type TenantSettingsActionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT'

export class TenantSettingsActionError extends Error {
  constructor(
    readonly code: TenantSettingsActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TenantSettingsActionError'
  }
}

export type TenantSettingsActionClient = Pick<typeof db, '$transaction'>
export type TenantEngagementMode = 'STOIC' | 'BALANCED' | 'CURIOUS'

export const tenantEngagementSettingsSelect = {
  id: true,
  engagementMode: true,
  updatedAt: true,
} as const

function invalid(message: string): never {
  throw new TenantSettingsActionError('INVALID_INPUT', message)
}

function assertActor(actor: TenantSettingsHumanActor): void {
  if (
    actor.type !== 'HUMAN' ||
    !actor.id.trim() ||
    !(['OWNER', 'MANAGER'] as const).includes(actor.role)
  ) {
    invalid('A signed-in human owner or manager is required.')
  }
}

function nextUpdatedAt(previous: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1))
}

/**
 * Canonical tenant-local action for changing the question engagement policy.
 * The tenant id is server-resolved, the revision is exact, and the mutation
 * and its deliberately small audit record commit together.
 */
export async function setTenantEngagementModeAction(input: {
  db?: TenantSettingsActionClient
  tenantId: string
  mode: TenantEngagementMode
  expectedUpdatedAt: Date
  actor: TenantSettingsHumanActor
  now?: Date
}) {
  assertActor(input.actor)
  if (!input.tenantId.trim()) invalid('Exact tenant scope is required.')
  if (!(['STOIC', 'BALANCED', 'CURIOUS'] as const).includes(input.mode)) {
    invalid('A supported engagement mode is required.')
  }
  if (Number.isNaN(input.expectedUpdatedAt.getTime())) {
    invalid('A valid expected tenant revision is required.')
  }

  return (input.db ?? db).$transaction(async (tx) => {
    const before = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: tenantEngagementSettingsSelect,
    })
    if (!before) throw new TenantSettingsActionError('NOT_FOUND', 'Tenant not found.')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new TenantSettingsActionError(
        'CONFLICT',
        'Tenant settings changed; refresh and try again.',
      )
    }

    // A same-revision no-op is a safe idempotent replay and does not manufacture
    // a mutation or audit event.
    if (before.engagementMode === input.mode) return { ...before, replayed: true as const }

    const updatedAt = nextUpdatedAt(before.updatedAt, input.now ?? new Date())
    const changed = await tx.tenant.updateMany({
      where: {
        id: input.tenantId,
        updatedAt: input.expectedUpdatedAt,
      },
      data: { engagementMode: input.mode, updatedAt },
    })
    if (changed.count !== 1) {
      throw new TenantSettingsActionError(
        'CONFLICT',
        'Tenant settings changed; refresh and try again.',
      )
    }
    const saved = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: tenantEngagementSettingsSelect,
    })
    if (!saved) {
      throw new TenantSettingsActionError('CONFLICT', 'Tenant settings changed unexpectedly.')
    }
    if (saved.engagementMode !== input.mode || saved.updatedAt.getTime() !== updatedAt.getTime()) {
      throw new TenantSettingsActionError('CONFLICT', 'Tenant settings changed unexpectedly.')
    }

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'tenant.engagement-mode.updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: { engagementMode: before.engagementMode },
        afterState: { engagementMode: saved.engagementMode },
      },
      tx,
    )
    return { ...saved, replayed: false as const }
  })
}
