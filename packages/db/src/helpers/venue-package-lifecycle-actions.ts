import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'
import { lockVenueContentMutation } from './venue-content-lock'

export type VenuePackageLifecycleActor = {
  type: 'HUMAN'
  id: string
  role: 'OWNER' | 'PLATFORM_ADMIN'
}
export type VenuePackageLifecycleClient = Pick<typeof db, '$transaction'>
export type VenuePackageLifecycleStatus = 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'

export class VenuePackageLifecycleError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'VenuePackageLifecycleError'
  }
}

export type VenuePackageLifecycleRecord = {
  id: string
  tenantId: string
  venueId: string
  status: string
  updatedAt: Date
  approvedCommandKey: string | null
  approvedBy: string | null
  appliedCommandKey: string | null
  appliedBy: string | null
  revertedCommandKey: string | null
  revertedBy: string | null
}

type Transaction = typeof db
type LifecycleKind = 'approve' | 'apply' | 'revert'

type LifecycleSpec<T extends VenuePackageLifecycleRecord> = {
  kind: LifecycleKind
  tenantId: string
  id: string
  expectedUpdatedAt: Date
  commandKey: string
  actor: VenuePackageLifecycleActor
  load: (tx: Transaction, scope: { tenantId: string; id: string }) => Promise<T | null>
  validate: (tx: Transaction, current: T) => Promise<void>
  execute?: (tx: Transaction, current: T) => Promise<Record<string, unknown>>
  auditState: (record: T) => Record<string, unknown>
}

const lifecycle = {
  approve: {
    from: 'DRAFT',
    to: 'APPROVED',
    commandField: 'approvedCommandKey',
    actorField: 'approvedBy',
    atField: 'approvedAt',
    action: 'venue-package.approved',
    invalid: 'Only a draft venue package can be approved',
  },
  apply: {
    from: 'APPROVED',
    to: 'APPLIED',
    commandField: 'appliedCommandKey',
    actorField: 'appliedBy',
    atField: 'appliedAt',
    action: 'venue-package.applied',
    invalid: 'Only an approved venue package can be applied',
  },
  revert: {
    from: 'APPLIED',
    to: 'REVERTED',
    commandField: 'revertedCommandKey',
    actorField: 'revertedBy',
    atField: 'revertedAt',
    action: 'venue-package.reverted',
    invalid: 'Only an applied venue package can be reverted',
  },
} as const

function requireLifecycleActor(actor: VenuePackageLifecycleActor): void {
  if (
    actor.type !== 'HUMAN' ||
    (actor.role !== 'OWNER' && actor.role !== 'PLATFORM_ADMIN') ||
    !actor.id.trim()
  ) {
    throw new VenuePackageLifecycleError(
      'INVALID_INPUT',
      'A human venue owner or platform administrator is required',
    )
  }
}

function conflict(message = 'Venue package changed; refresh and review it again'): never {
  throw new VenuePackageLifecycleError('CONFLICT', message)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

async function runLifecycle<T extends VenuePackageLifecycleRecord>(
  input: LifecycleSpec<T>,
  client: VenuePackageLifecycleClient,
): Promise<T> {
  requireLifecycleActor(input.actor)
  const rule = lifecycle[input.kind]
  const isExactReplay = (current: T) =>
    current.status === rule.to &&
    current[rule.commandField] === input.commandKey &&
    current[rule.actorField] === input.actor.id
  const operation = async (rawTx: unknown) => {
    const tx = rawTx as unknown as Transaction
    await setContentVersionContext(tx, { actorId: input.actor.id })
    let current = await input.load(tx, { tenantId: input.tenantId, id: input.id })
    if (!current) throw new VenuePackageLifecycleError('NOT_FOUND', 'Venue package not found')
    if (current.tenantId !== input.tenantId || current.id !== input.id) {
      throw new VenuePackageLifecycleError('NOT_FOUND', 'Venue package not found')
    }
    const venueId = current.venueId
    await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId })
    current = await input.load(tx, { tenantId: input.tenantId, id: input.id })
    if (
      !current ||
      current.tenantId !== input.tenantId ||
      current.id !== input.id ||
      current.venueId !== venueId
    ) {
      throw new VenuePackageLifecycleError('NOT_FOUND', 'Venue package not found')
    }
    if (current.status !== rule.from) {
      if (isExactReplay(current)) return current
      conflict(rule.invalid)
    }
    await input.validate(tx, current)
    const effects = input.execute ? await input.execute(tx, current) : {}
    const now = new Date()
    const changed = await tx.venuePackage.updateMany({
      where: {
        id: input.id,
        tenantId: input.tenantId,
        venueId,
        status: rule.from,
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        ...effects,
        status: rule.to,
        [rule.actorField]: input.actor.id,
        [rule.atField]: now,
        [rule.commandField]: input.commandKey,
      },
    })
    if (changed.count !== 1) conflict()
    const saved = await input.load(tx, { tenantId: input.tenantId, id: input.id })
    if (
      !saved ||
      saved.tenantId !== input.tenantId ||
      saved.id !== input.id ||
      saved.venueId !== venueId
    ) {
      conflict()
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: rule.action,
        targetType: 'VenuePackage',
        targetId: input.id,
        beforeState: input.auditState(current),
        afterState: input.auditState(saved),
      },
      tx,
    )
    return saved
  }
  const candidate = client as VenuePackageLifecycleClient & {
    $transaction?: (callback: (tx: unknown) => Promise<T>) => Promise<T>
  }
  if (typeof candidate.$transaction !== 'function') {
    return operation(client as unknown as Transaction)
  }
  try {
    return await candidate.$transaction(operation)
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    return candidate.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as Transaction
      const current = await input.load(tx, { tenantId: input.tenantId, id: input.id })
      if (current && isExactReplay(current)) return current
      conflict('Venue-package command key was already used')
    })
  }
}

type PublicSpec<T extends VenuePackageLifecycleRecord> = Omit<LifecycleSpec<T>, 'kind'>

export function approveVenuePackageAction<T extends VenuePackageLifecycleRecord>(
  input: PublicSpec<T>,
  client: VenuePackageLifecycleClient = db,
) {
  return runLifecycle({ ...input, kind: 'approve' }, client)
}

export function applyVenuePackageAction<T extends VenuePackageLifecycleRecord>(
  input: PublicSpec<T>,
  client: VenuePackageLifecycleClient = db,
) {
  return runLifecycle({ ...input, kind: 'apply' }, client)
}

export function revertVenuePackageAction<T extends VenuePackageLifecycleRecord>(
  input: PublicSpec<T>,
  client: VenuePackageLifecycleClient = db,
) {
  return runLifecycle({ ...input, kind: 'revert' }, client)
}
