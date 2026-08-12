import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { setContentVersionContext } from './content-version-context'

export type PlatformAdminActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
export type ClientAccountActionClient = Pick<typeof db, '$transaction'>
export type ClientAccountActionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT'

export class ClientAccountActionError extends Error {
  constructor(
    readonly code: ClientAccountActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ClientAccountActionError'
  }
}

export const clientAccountSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  planTier: true,
  nextPaymentDue: true,
  createdAt: true,
  updatedAt: true,
} as const

type OwnerIdentity = { id: string; email: string }
type InitialVenue = {
  name: string
  slug: string
  guideMode: 'location_aware' | 'non_location'
  description?: string | undefined
  guideNotes?: string | undefined
  category?: string | undefined
  defaultCenterLat?: number | undefined
  defaultCenterLng?: number | undefined
}

export type CreateClientAccountInput = {
  tenantId: string
  name: string
  slug: string
  owner: OwnerIdentity
  actor: PlatformAdminActor
  initialVenue?: InitialVenue | undefined
}

function requireActor(actor: PlatformAdminActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new ClientAccountActionError(
      'INVALID_INPUT',
      'A human platform administrator is required',
    )
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function nextUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1))
}

function tenantAudit(value: {
  id: string
  name: string
  slug: string
  status: string
  planTier: string
  nextPaymentDue: Date | null
  updatedAt: Date
}) {
  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    status: value.status,
    planTier: value.planTier,
    nextPaymentDue: value.nextPaymentDue?.toISOString() ?? null,
    updatedAt: value.updatedAt.toISOString(),
  }
}

async function exactReplay(tx: typeof db, input: CreateClientAccountInput) {
  const existing = await tx.tenant.findUnique({
    where: { id: input.tenantId },
    select: clientAccountSelect,
  })
  if (!existing) return null
  if (existing.name !== input.name || existing.slug !== input.slug) {
    throw new ClientAccountActionError(
      'CONFLICT',
      'This client identifier is already used by different account details',
    )
  }
  const [owner, membership] = await Promise.all([
    tx.user.findUnique({ where: { id: input.owner.id }, select: { id: true, email: true } }),
    tx.tenantMembership.findUnique({
      where: {
        tenantId: input.tenantId,
        tenantId_userId: { tenantId: input.tenantId, userId: input.owner.id },
      },
      select: { role: true, status: true },
    }),
  ])
  if (
    owner?.email !== input.owner.email ||
    membership?.role !== 'OWNER' ||
    membership.status !== 'ACTIVE'
  ) {
    throw new ClientAccountActionError(
      'CONFLICT',
      'This client identifier already has different owner details',
    )
  }
  if (!input.initialVenue) return { tenant: existing, venue: null }
  const venue = await tx.venue.findFirst({
    where: { tenantId: input.tenantId, slug: input.initialVenue.slug },
    select: {
      id: true,
      name: true,
      slug: true,
      guideMode: true,
      description: true,
      guideNotes: true,
      category: true,
      defaultCenterLat: true,
      defaultCenterLng: true,
    },
  })
  const expected = input.initialVenue
  if (
    !venue ||
    venue.name !== expected.name ||
    venue.guideMode !== expected.guideMode ||
    venue.description !== (expected.description ?? null) ||
    venue.guideNotes !== (expected.guideNotes ?? null) ||
    venue.category !== (expected.category ?? null) ||
    venue.defaultCenterLat !== (expected.defaultCenterLat ?? null) ||
    venue.defaultCenterLng !== (expected.defaultCenterLng ?? null)
  ) {
    throw new ClientAccountActionError(
      'CONFLICT',
      'This client identifier already has different initial venue details',
    )
  }
  return { tenant: existing, venue: { id: venue.id, name: venue.name, slug: venue.slug } }
}

export async function createClientAccountAction(
  input: CreateClientAccountInput,
  client: ClientAccountActionClient = db,
) {
  requireActor(input.actor)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:client-create:${input.tenantId}`}, 0))`
    const replay = await exactReplay(tx, input)
    if (replay) return { ...replay, replayed: true }

    let tenant: {
      id: string
      name: string
      slug: string
      status: string
      planTier: string
      nextPaymentDue: Date | null
      createdAt: Date
      updatedAt: Date
    }
    try {
      tenant = await tx.tenant.create({
        data: { id: input.tenantId, name: input.name, slug: input.slug },
        select: clientAccountSelect,
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ClientAccountActionError(
          'CONFLICT',
          'A client with this organization ID or slug already exists',
        )
      }
      throw error
    }

    await tx.user.upsert({
      where: { id: input.owner.id },
      create: { id: input.owner.id, email: input.owner.email },
      update: { email: input.owner.email },
    })
    await tx.tenantMembership.upsert({
      where: {
        tenantId: input.tenantId,
        tenantId_userId: { tenantId: input.tenantId, userId: input.owner.id },
      },
      create: {
        tenantId: input.tenantId,
        userId: input.owner.id,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
      update: { role: 'OWNER', status: 'ACTIVE' },
    })

    if (input.initialVenue) await setContentVersionContext(tx, { actorId: input.actor.id })
    const venue = input.initialVenue
      ? await tx.venue.create({
          data: {
            tenantId: input.tenantId,
            name: input.initialVenue.name,
            slug: input.initialVenue.slug,
            guideMode: input.initialVenue.guideMode,
            ...(input.initialVenue.description !== undefined
              ? { description: input.initialVenue.description }
              : {}),
            ...(input.initialVenue.guideNotes !== undefined
              ? { guideNotes: input.initialVenue.guideNotes }
              : {}),
            ...(input.initialVenue.category !== undefined
              ? { category: input.initialVenue.category }
              : {}),
            ...(input.initialVenue.defaultCenterLat !== undefined
              ? { defaultCenterLat: input.initialVenue.defaultCenterLat }
              : {}),
            ...(input.initialVenue.defaultCenterLng !== undefined
              ? { defaultCenterLng: input.initialVenue.defaultCenterLng }
              : {}),
          },
          select: { id: true, name: true, slug: true },
        })
      : null

    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.client.created',
        targetType: 'Tenant',
        targetId: input.tenantId,
        afterState: {
          ...tenantAudit(tenant),
          ownerUserId: input.owner.id,
          ...(venue ? { venueId: venue.id } : {}),
        },
      },
      tx,
    )
    return { tenant, venue, replayed: false }
  })
}

type UpdateClientAccountInput = {
  tenantId: string
  expectedUpdatedAt: Date
  actor: PlatformAdminActor
}

async function updateClientAccount(
  input: UpdateClientAccountInput,
  change:
    | { kind: 'status'; value: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' }
    | { kind: 'planTier'; value: 'free' | 'pro' | 'enterprise' }
    | { kind: 'nextPaymentDue'; value: Date | null },
  client: ClientAccountActionClient,
) {
  requireActor(input.actor)
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const before = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: clientAccountSelect,
    })
    if (!before) throw new ClientAccountActionError('NOT_FOUND', 'Client not found')
    if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new ClientAccountActionError(
        'CONFLICT',
        'Client account changed after this page loaded; refresh and try again',
      )
    }
    const updatedAt = nextUpdatedAt(before.updatedAt)
    const data =
      change.kind === 'status'
        ? { status: change.value, updatedAt }
        : change.kind === 'planTier'
          ? { planTier: change.value, updatedAt }
          : { nextPaymentDue: change.value, updatedAt }
    const changed = await tx.tenant.updateMany({
      where: { id: input.tenantId, updatedAt: input.expectedUpdatedAt },
      data,
    })
    if (changed.count !== 1) {
      throw new ClientAccountActionError(
        'CONFLICT',
        'Client account changed after this page loaded; refresh and try again',
      )
    }
    const saved = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: clientAccountSelect,
    })
    if (!saved) throw new ClientAccountActionError('CONFLICT', 'Client account changed')
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action:
          change.kind === 'status'
            ? 'admin.client.status_updated'
            : change.kind === 'planTier'
              ? 'admin.client.plan_updated'
              : 'admin.client.payment_due_updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: tenantAudit(before),
        afterState: tenantAudit(saved),
      },
      tx,
    )
    return saved
  })
}

export function updateClientStatusAction(
  input: UpdateClientAccountInput & { status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' },
  client: ClientAccountActionClient = db,
) {
  return updateClientAccount(input, { kind: 'status', value: input.status }, client)
}

export function updateClientPlanTierAction(
  input: UpdateClientAccountInput & { planTier: 'free' | 'pro' | 'enterprise' },
  client: ClientAccountActionClient = db,
) {
  return updateClientAccount(input, { kind: 'planTier', value: input.planTier }, client)
}

export function setClientPaymentDueAction(
  input: UpdateClientAccountInput & { nextPaymentDue: Date | null },
  client: ClientAccountActionClient = db,
) {
  return updateClientAccount(input, { kind: 'nextPaymentDue', value: input.nextPaymentDue }, client)
}
